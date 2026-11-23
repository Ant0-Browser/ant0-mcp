import { rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { saveCredentialFile } from "../src/credential-file.js";
import { discoverConnection } from "../src/connection.js";
import { ID, SECRET, TOKEN, entry, inventoryProfile, mockDaemon, sdkClient } from "./helpers.js";
import { keyStatus, privateTestDirectory, readyFile } from "./key-helpers.js";

const cleanups: (() => Promise<void>)[] = [];
afterEach(async () => {
  for (const close of cleanups.splice(0).reverse()) await close();
});
async function setup(handler?: Parameters<typeof mockDaemon>[0]) {
  const file = readyFile();
  const daemon = await mockDaemon(
    handler ??
      ((req, res) => {
        const url = new URL(req.url!, "http://localhost");
        const data =
          url.pathname === "/v1/automation/status"
            ? keyStatus(file)
            : url.pathname === `/v1/inventory/profiles/${ID}`
              ? inventoryProfile
              : url.pathname === "/v1/inventory/proxies"
                ? { items: [inventoryProfile.proxy], total: 1 }
                : { items: [inventoryProfile], total: 1 };
        res.end(JSON.stringify(data));
      }),
  );
  cleanups.push(daemon.close);
  privateTestDirectory(daemon.home);
  const path = join(daemon.home, "key.json");
  const pending = saveCredentialFile(path, { ...file, phase: "pending", key: null });
  saveCredentialFile(path, file, pending);
  // No master bearer is available: discovery must not require it or recreate it.
  rmSync(join(daemon.home, "ant0d.token"));
  const sdk = await sdkClient(daemon.home, [entry, daemon.home, path]);
  cleanups.push(sdk.close);
  return { ...sdk, daemon, file, path };
}
describe("official MCP client with private delegated credentials", () => {
  it.each(["forbidden", "malformed", "unknown arguments"])(
    "returns a structured %s detail error after official tool discovery",
    async (kind) => {
      const { client, daemon } = await setup((_req, res) => {
        if (kind === "forbidden") {
          res.writeHead(403);
          res.end(JSON.stringify({ message: SECRET }));
        } else res.end(JSON.stringify({ profile: SECRET }));
      });
      await client.listTools();
      const result = await client.callTool({
        name: "ant0_profile_detail",
        arguments: {
          id: ID,
          ...(kind === "unknown arguments" ? { surprise: SECRET } : {}),
        },
      });
      expect(result.isError).toBe(true);
      expect(result.structuredContent).toMatchObject({
        error:
          kind === "forbidden"
            ? "mcp.forbidden"
            : kind === "malformed"
              ? "mcp.response"
              : "mcp.arguments",
      });
      expect(JSON.stringify(result)).not.toContain(SECRET);
      expect(daemon.requests).toHaveLength(kind === "unknown arguments" ? 0 : 1);
    },
  );
  it.each(["credential", "secret"])(
    "rejects the %s disguised in projected metadata after discovery",
    async (kind) => {
      let echo = "";
      const { client, file } = await setup((_req, res) =>
        res.end(
          JSON.stringify({
            ...inventoryProfile,
            profile: { ...inventoryProfile.profile, name: echo },
          }),
        ),
      );
      echo = kind === "credential" ? file.create.credential : file.create.credential.slice(-43);
      await client.listTools();
      const result = await client.callTool({ name: "ant0_profile_detail", arguments: { id: ID } });
      expect(result.isError).toBe(true);
      expect(JSON.stringify(result)).not.toContain(echo);
    },
  );
  it("uses only key inventory/status routes and MCP consumer for all seven tools, without a master token", async () => {
    const { client, daemon, file, stderr } = await setup();
    const { tools } = await client.listTools();
    expect(tools).toHaveLength(7);
    for (const tool of tools) {
      const result = await client.callTool({
        name: tool.name,
        arguments: ["ant0_profile_detail", "ant0_profile_status"].includes(tool.name)
          ? { id: ID }
          : {},
      });
      expect(result.isError, JSON.stringify(result)).not.toBe(true);
      expect(JSON.stringify(result)).not.toContain(file.create.credential);
      expect(JSON.stringify(result)).not.toContain(TOKEN);
      expect(JSON.stringify(result)).not.toContain(SECRET);
      if (tool.name === "ant0_profile_detail") {
        expect(Object.keys(result.structuredContent!).sort()).toEqual([
          "lifecycle",
          "permissions",
          "profile",
          "proxy",
        ]);
        expect(result.structuredContent!.permissions).toEqual({ edit: false, cdp: false });
        expect(result.structuredContent!.profile).not.toHaveProperty("notes");
      }
      if (tool.name === "ant0_licence_status")
        expect(result.structuredContent).toMatchObject({
          state: "active",
          mode: "enforce",
          billing: "lapsed",
          used_local: 1,
          expires_at: null,
          grace_until: null,
        });
    }
    expect(daemon.requests).toHaveLength(7);
    expect(
      daemon.requests.every(
        (r) => r.authorization === `Bearer ${file.create.credential}` && r.consumer === "mcp",
      ),
    ).toBe(true);
    expect(daemon.requests.map((r) => new URL(r.url, "http://localhost").pathname)).toEqual([
      "/v1/automation/status",
      "/v1/automation/status",
      "/v1/inventory/profiles",
      `/v1/inventory/profiles/${ID}`,
      `/v1/inventory/profiles/${ID}`,
      "/v1/inventory/profiles",
      "/v1/inventory/proxies",
    ]);
    expect(stderr()).toBe("");
  });
  it.each([401, 403, 404, 409, 503])(
    "fails HTTP %s without falling back to a valid master bearer",
    async (status) => {
      const { client, daemon, file } = await setup((_req, res) => {
        res.writeHead(status);
        res.end(JSON.stringify({ error: SECRET, message: SECRET }));
      });
      writeFileSync(join(daemon.home, "ant0d.token"), TOKEN, { mode: 0o600 });
      const result = await client.callTool({ name: "ant0_profile_detail", arguments: { id: ID } });
      expect(result.isError).toBe(true);
      expect(JSON.stringify(result)).not.toContain(SECRET);
      expect(daemon.requests).toHaveLength(1);
      expect(daemon.requests[0]!.authorization).toBe(`Bearer ${file.create.credential}`);
    },
  );
  it("fails missing/unsafe key files before any HTTP and never falls back", async () => {
    const daemon = await mockDaemon();
    cleanups.push(daemon.close);
    for (const path of [join(daemon.home, "missing.json"), join(daemon.home, "ant0d.token")]) {
      expect(() => discoverConnection({ home: daemon.home, credentialFile: path })).toThrow();
      await expect(sdkClient(daemon.home, [entry, daemon.home, path])).rejects.toThrow();
    }
    expect(daemon.requests).toEqual([]);
  });
  it("validates loopback before the credential and rejects changed files on subsequent reads", async () => {
    const { client, daemon, path } = await setup();
    expect(() =>
      discoverConnection({
        home: join(daemon.home, "none"),
        credentialFile: path,
        env: { ANT0D_HOST: "evil.example", ANT0D_PORT: "27100" },
      }),
    ).toThrow();
    writeFileSync(path, "{CANARY");
    expect((await client.callTool({ name: "ant0_profiles_list" })).isError).toBe(true);
    expect(daemon.requests).toEqual([]);
  });
  it.each(["edit", "cdp"])(
    "rejects a key detail with %s authority instead of laundering the permission",
    async (field) => {
      const { client } = await setup((_req, res) =>
        res.end(
          JSON.stringify({
            ...inventoryProfile,
            permissions: { edit: false, cdp: false, [field]: true },
          }),
        ),
      );
      const result = await client.callTool({ name: "ant0_profile_detail", arguments: { id: ID } });
      expect(result.structuredContent).toMatchObject({ error: "mcp.response" });
    },
  );
  it("cancels a delegated read through the official client without a master fallback", async () => {
    let disconnected = false;
    const { client, daemon } = await setup((_req, res) => {
      res.writeHead(200);
      res.write("{");
      res.once("close", () => {
        disconnected = true;
      });
    });
    const abort = new AbortController();
    const call = client.callTool(
      { name: "ant0_profiles_list" },
      {
        signal: abort.signal,
      },
    );
    const rejection = expect(call).rejects.toThrow();
    await expect.poll(() => daemon.requests.length).toBe(1);
    abort.abort();
    await rejection;
    await expect.poll(() => disconnected, { timeout: 1500 }).toBe(true);
    expect((await client.listTools()).tools).toHaveLength(7);
    expect(daemon.requests).toHaveLength(1);
  });
  it("preserves the key's limited scopes instead of inferring the read preset", async () => {
    const daemon = await mockDaemon();
    cleanups.push(daemon.close);
    privateTestDirectory(daemon.home);
    const file = readyFile();
    file.create.scopes = ["profiles:read"];
    file.key!.scopes = ["profiles:read"];
    const path = join(daemon.home, "key.json");
    saveCredentialFile(path, file);
    const sdk = await sdkClient(daemon.home, [entry, daemon.home, path]);
    cleanups.push(sdk.close);
    expect(
      (await sdk.client.callTool({ name: "ant0_proxies_list" })).structuredContent,
    ).toMatchObject({ error: "mcp.forbidden" });
    expect(
      (await sdk.client.callTool({ name: "ant0_daemon_status" })).structuredContent,
    ).toMatchObject({ error: "mcp.forbidden" });
    expect(daemon.requests).toEqual([]);
  });
  it.each([
    "wrong key",
    "wrong workspace",
    "expired",
    "licence",
    "missing used_local",
    "unsafe features",
    "offline",
    "missing mcp",
    "wrong user",
    "wrong device",
    "wrong ceiling",
    "duplicate scopes",
    "zero seats",
    "used mismatch",
    "signed expiry",
    "off mode",
    "fractional uptime",
  ])("rejects malformed status: %s", async (kind) => {
    let data: any;
    const { client, file } = await setup((_req, res) => res.end(JSON.stringify(data)));
    data = keyStatus(file);
    if (kind === "wrong key") data.principal.key_id = ID;
    if (kind === "wrong workspace") data.principal.workspace_id = ID;
    if (kind === "expired") data.principal.expires_at = "2020-01-01T00:00:00.000Z";
    if (kind === "licence") data.licence.state = "locked";
    if (kind === "missing used_local") delete data.licence.used_local;
    if (kind === "unsafe features") data.licence.features = [SECRET.repeat(10)];
    if (kind === "offline") data.licence.online = false;
    if (kind === "missing mcp") data.licence.features = ["api"];
    if (kind === "wrong user") data.principal.user_id = ID;
    if (kind === "wrong device") data.principal.device_id = "B".repeat(26);
    if (kind === "wrong ceiling") data.principal.role_ceiling = "owner";
    if (kind === "duplicate scopes") data.principal.scopes = ["status:read", "status:read"];
    if (kind === "zero seats") data.licence.limits.seats = 0;
    if (kind === "used mismatch") data.licence.used_local = 3;
    if (kind === "signed expiry") data.licence.expires_at = data.principal.expires_at;
    if (kind === "off mode") data.licence.mode = "off";
    if (kind === "fractional uptime") data.daemon.uptime_s = 1.5;
    const result = await client.callTool({ name: "ant0_licence_status" });
    expect(result.structuredContent).toMatchObject({ error: "mcp.response" });
    expect(JSON.stringify(result)).not.toContain(SECRET);
  });
  it("rejects a credential file changed during an otherwise successful HTTP read", async () => {
    let path = "";
    const f = await setup((_req, res) => {
      writeFileSync(path, "changed");
      res.end(JSON.stringify(inventoryProfile));
    });
    path = f.path;
    const result = await f.client.callTool({ name: "ant0_profile_detail", arguments: { id: ID } });
    expect(result.isError).toBe(true);
    expect(result.structuredContent).toMatchObject({ error: "mcp.configuration" });
    expect(result.structuredContent).not.toHaveProperty("profile");
  });
});
