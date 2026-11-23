import { rmSync } from "node:fs";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { daemonClient, requestTimeoutMs } from "../src/daemon.js";
import { saveCredentialFile } from "../src/credential-file.js";
import { ID, SECRET, entry, mockDaemon, runResult, sdkClient } from "./helpers.js";
import { operateScopes, readScopes } from "../src/key-contract.js";
import { privateTestDirectory, readyFile } from "./key-helpers.js";

const OTHER_ID = "22345678-1234-4234-8234-123456789abc";
const cleanups: (() => Promise<void>)[] = [];
afterEach(async () => {
  for (const close of cleanups.splice(0).reverse()) await close();
});

async function body(req: NodeJS.ReadableStream): Promise<Record<string, unknown>> {
  const chunks: Buffer[] = [];
  for await (const chunk of req) chunks.push(Buffer.from(chunk));
  return JSON.parse(Buffer.concat(chunks).toString("utf8"));
}

describe("operational MCP tools", () => {
  it("uses closed run/stop inputs and returns endpoint-free results", async () => {
    const bodies: Record<string, unknown>[] = [];
    const daemon = await mockDaemon(async (req, res) => {
      bodies.push(await body(req));
      if (req.url === `/v1/profiles/${ID}/stop`) {
        res.writeHead(204);
        return void res.end();
      }
      res.end(JSON.stringify(runResult));
    });
    cleanups.push(daemon.close);
    const sdk = await sdkClient(daemon.home);
    cleanups.push(sdk.close);

    const run = await sdk.client.callTool({
      name: "ant0_profile_run",
      arguments: { id: ID, timeout_s: 12, conflict_profile_id: OTHER_ID },
    });
    expect(run.isError).not.toBe(true);
    expect(run.structuredContent).toEqual(runResult);
    expect(JSON.stringify(run)).not.toMatch(/ws_endpoint|cdp_http|debug_port|pid/);
    const stop = await sdk.client.callTool({
      name: "ant0_profile_stop",
      arguments: { id: ID, force: true },
    });
    expect(stop.structuredContent).toEqual({});
    expect(daemon.requests.map(({ method, url }) => [method, url])).toEqual([
      ["POST", `/v1/profiles/${ID}/run`],
      ["POST", `/v1/profiles/${ID}/stop`],
    ]);
    expect(bodies).toEqual([{ timeout_s: 12, conflict_profile_id: OTHER_ID }, { force: true }]);
  });

  it("reads a valid Ant0-Sync header on a 204 stop and ignores anything else", async () => {
    let header: string | undefined = "pending";
    const daemon = await mockDaemon(async (req, res) => {
      await body(req);
      res.writeHead(204, header === undefined ? {} : { "ant0-sync": header });
      res.end();
    });
    cleanups.push(daemon.close);
    const sdk = await sdkClient(daemon.home);
    cleanups.push(sdk.close);
    const stop = () => sdk.client.callTool({ name: "ant0_profile_stop", arguments: { id: ID } });

    expect((await stop()).structuredContent).toEqual({ sync: "pending" });
    header = "done";
    expect((await stop()).structuredContent).toEqual({ sync: "done" });
    header = undefined;
    expect((await stop()).structuredContent).toEqual({});
    header = "later";
    const ignored = await stop();
    expect(ignored.isError).not.toBe(true);
    expect(ignored.structuredContent).toEqual({});
  });

  it("rejects unknown, unbounded and arbitrary launch inputs before HTTP", async () => {
    const daemon = await mockDaemon();
    cleanups.push(daemon.close);
    const sdk = await sdkClient(daemon.home);
    cleanups.push(sdk.close);
    for (const args of [
      { id: ID, timeout_s: 0 },
      { id: ID, timeout_s: 601 },
      { id: ID, timeout_s: 1.5 },
      { id: ID, conflict_profile_id: "not-a-uuid" },
      { id: ID, url: `https://${SECRET}` },
      { id: ID, extra_args: [SECRET] },
    ]) {
      const result = await sdk.client.callTool({ name: "ant0_profile_run", arguments: args });
      expect(result.structuredContent).toMatchObject({ error: "mcp.arguments" });
      expect(JSON.stringify(result)).not.toContain(SECRET);
    }
    expect(
      (
        await sdk.client.callTool({
          name: "ant0_profile_stop",
          arguments: { id: ID, force: false, extra: true },
        })
      ).structuredContent,
    ).toMatchObject({ error: "mcp.arguments" });
    expect(daemon.requests).toEqual([]);
  });

  it("advertises tools from exact credential scopes and never falls back to the master bearer", async () => {
    const daemon = await mockDaemon();
    cleanups.push(daemon.close);
    privateTestDirectory(daemon.home);
    const file = readyFile();
    file.create.scopes = [...operateScopes];
    file.key!.scopes = [...operateScopes];
    const path = join(daemon.home, "operate.json");
    saveCredentialFile(path, file);
    rmSync(join(daemon.home, "ant0d.token"));
    const sdk = await sdkClient(daemon.home, [entry, daemon.home, path]);
    cleanups.push(sdk.close);
    expect((await sdk.client.listTools()).tools.map((tool) => tool.name)).toEqual([
      "ant0_daemon_status",
      "ant0_licence_status",
      "ant0_profiles_list",
      "ant0_profile_detail",
      "ant0_profile_status",
      "ant0_sessions_list",
      "ant0_proxies_list",
      "ant0_profile_run",
      "ant0_profile_stop",
    ]);
    const result = await sdk.client.callTool({ name: "ant0_profile_run", arguments: { id: ID } });
    expect(result.structuredContent).toEqual(runResult);
    expect(daemon.requests).toHaveLength(1);
    expect(daemon.requests[0]).toMatchObject({
      method: "POST",
      authorization: `Bearer ${file.create.credential}`,
      consumer: "mcp",
    });

    const limited = readyFile();
    limited.create.scopes = ["profiles:run"];
    limited.key!.scopes = ["profiles:run"];
    const limitedPath = join(daemon.home, "limited.json");
    saveCredentialFile(limitedPath, limited);
    const limitedSdk = await sdkClient(daemon.home, [entry, daemon.home, limitedPath]);
    cleanups.push(limitedSdk.close);
    expect((await limitedSdk.client.listTools()).tools.map((tool) => tool.name)).toEqual([
      "ant0_profile_run",
    ]);
    expect(
      (await limitedSdk.client.callTool({ name: "ant0_profile_stop", arguments: { id: ID } }))
        .structuredContent,
    ).toMatchObject({ error: "mcp.forbidden" });
    expect(daemon.requests).toHaveLength(1);
  });

  it("cancellation is indeterminate and never replays or stops the run", async () => {
    let disconnected = false;
    const daemon = await mockDaemon((_req, res) => {
      res.writeHead(200, { "content-type": "application/json" });
      res.write("{");
      res.on("close", () => {
        disconnected = true;
      });
    });
    cleanups.push(daemon.close);
    const sdk = await sdkClient(daemon.home);
    cleanups.push(sdk.close);
    const abort = new AbortController();
    const pending = sdk.client.callTool(
      { name: "ant0_profile_run", arguments: { id: ID, timeout_s: 1 } },
      { signal: abort.signal },
    );
    const rejected = expect(pending).rejects.toThrow();
    await expect.poll(() => daemon.requests.length).toBe(1);
    abort.abort();
    await rejected;
    await expect.poll(() => disconnected).toBe(true);
    expect(daemon.requests.map(({ method, url }) => [method, url])).toEqual([
      ["POST", `/v1/profiles/${ID}/run`],
    ]);
  });

  it("treats a lost or malformed operation response as indeterminate without replay", async () => {
    const daemon = await mockDaemon((_req, res) => res.end(`{${SECRET}`));
    cleanups.push(daemon.close);
    const sdk = await sdkClient(daemon.home);
    cleanups.push(sdk.close);
    const result = await sdk.client.callTool({ name: "ant0_profile_run", arguments: { id: ID } });
    expect(result.structuredContent).toEqual({
      error: "mcp.indeterminate",
      message: "operation outcome is unknown; check the current state before retrying",
    });
    expect(JSON.stringify(result)).not.toContain(SECRET);
    expect(daemon.requests.map(({ method, url }) => [method, url])).toEqual([
      ["POST", `/v1/profiles/${ID}/run`],
    ]);
  });

  it("keeps CDP start and bulk paths out of the MCP transport while the CLI keeps them", async () => {
    const daemon = await mockDaemon((_req, res) =>
      res.end(JSON.stringify({ updated: 1, errors: [] })),
    );
    cleanups.push(daemon.close);
    const connection = { origin: `http://127.0.0.1:${daemon.port}`, token: "local-token" };
    const lifetime = new AbortController().signal;
    const forbidden = [
      () =>
        daemonClient(connection, lifetime).POST("/v1/profiles/{id}/start", {
          params: { path: { id: ID } },
          body: {},
        }),
      () =>
        daemonClient(connection, lifetime).POST("/v1/profiles/bulk-start", { body: { ids: [ID] } }),
      () =>
        daemonClient(connection, lifetime).POST("/v1/profiles/bulk-stop", { body: { ids: [ID] } }),
      // The status route (CDP endpoint) is reachable only from the local-route table, never in key mode.
      () =>
        daemonClient({ ...connection, apiKey: true }, lifetime).GET("/v1/profiles/{id}/status", {
          params: { path: { id: ID } },
        }),
    ];
    for (const call of forbidden)
      await expect(call()).rejects.toThrow("invalid local daemon configuration");
    expect(daemon.requests).toEqual([]);
    // The same transport still serves the CLI's explicit CDP and bulk actions.
    const cli = daemonClient(connection, lifetime, "api");
    await cli.POST("/v1/profiles/bulk-stop", { body: { ids: [ID] } });
    expect(daemon.requests.map(({ method, url }) => [method, url])).toEqual([
      ["POST", "/v1/profiles/bulk-stop"],
    ]);
  });

  it("uses the requested run timeout plus exactly ten seconds of transport margin", () => {
    expect(requestTimeoutMs("GET", `/v1/profiles/${ID}/run`, "")).toBe(10_000);
    expect(requestTimeoutMs("POST", `/v1/profiles/${ID}/run`, "{}")).toBe(70_000);
    expect(requestTimeoutMs("POST", `/v1/profiles/${ID}/run`, '{"timeout_s":1}')).toBe(11_000);
    expect(requestTimeoutMs("POST", `/v1/profiles/${ID}/run`, '{"timeout_s":600}')).toBe(610_000);
    expect(requestTimeoutMs("POST", "/v1/profiles/bulk-start", '{"ids":["a","b"]}')).toBe(130_000);
  });

  it("keeps the read preset byte-compatible", () => {
    expect([...readScopes]).toEqual(["status:read", "profiles:read", "proxies:read"]);
  });
});
