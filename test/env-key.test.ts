import { rmSync } from "node:fs";
import { join } from "node:path";
import { Client } from "@modelcontextprotocol/client";
import { getDefaultEnvironment, StdioClientTransport } from "@modelcontextprotocol/client/stdio";
import { afterEach, describe, expect, it } from "vitest";
import { discoverConnection } from "../src/connection.js";
import { ID, SECRET, TOKEN, entry, inventoryProfile, mockDaemon } from "./helpers.js";
import { createKey, keyStatus, readyFile } from "./key-helpers.js";

const KEY = createKey.credential;
const cleanups: (() => Promise<void>)[] = [];
afterEach(async () => {
  for (const close of cleanups.splice(0).reverse()) await close();
});

async function daemonFor(status: unknown) {
  const daemon = await mockDaemon((req, res) => {
    const url = new URL(req.url!, "http://localhost");
    const data =
      url.pathname === "/v1/automation/status"
        ? status
        : url.pathname === `/v1/inventory/profiles/${ID}`
          ? inventoryProfile
          : url.pathname === "/v1/inventory/proxies"
            ? { items: [inventoryProfile.proxy], total: 1 }
            : { items: [inventoryProfile], total: 1 };
    res.end(JSON.stringify(data));
  });
  cleanups.push(daemon.close);
  rmSync(join(daemon.home, "ant0d.pid"));
  return daemon;
}

async function envClient(daemon: { home: string; port: number }, key: string) {
  const transport = new StdioClientTransport({
    command: process.execPath,
    args: [entry, daemon.home],
    env: { ...getDefaultEnvironment(), ANT0_API_KEY: key, ANT0D_PORT: String(daemon.port) },
    stderr: "pipe",
  });
  let stderr = "";
  transport.stderr!.on("data", (chunk) => {
    stderr += chunk.toString();
  });
  const client = new Client({ name: "ant0-test", version: "1.0.0" });
  await client.connect(transport);
  cleanups.push(() => client.close());
  return { client, stderr: () => stderr };
}

describe("ANT0_API_KEY discovery", () => {
  it("uses the environment key, never the master bearer, and keeps it out of argv", async () => {
    const daemon = await daemonFor(keyStatus(readyFile()));
    const connection = discoverConnection({
      home: daemon.home,
      env: { ANT0_API_KEY: KEY, ANT0D_PORT: String(daemon.port) },
    });
    expect(connection).toMatchObject({ token: KEY, apiKey: true });
    expect(connection.token).not.toBe(TOKEN);
    expect(connection.credential).toBeUndefined();
  });

  it.each([
    ["empty", ""],
    ["master bearer", TOKEN],
    ["wrong prefix", KEY.replace("ant0_sk_v1_", "ant0_sk_v2_")],
    ["non-canonical secret", `${KEY.slice(0, -1)}9`],
    ["trailing newline", `${KEY}\n`],
  ])("rejects a %s key without falling back to ant0d.token", async (_label, key) => {
    const daemon = await daemonFor(keyStatus(readyFile()));
    expect(() =>
      discoverConnection({
        home: daemon.home,
        env: { ANT0_API_KEY: key, ANT0D_PORT: String(daemon.port) },
      }),
    ).toThrow("invalid local daemon configuration");
    expect(daemon.requests).toEqual([]);
  });

  it("never combines the environment key with a stdin key", async () => {
    const daemon = await daemonFor(keyStatus(readyFile()));
    const env = { ANT0D_PORT: String(daemon.port) };
    expect(() =>
      discoverConnection({ home: daemon.home, apiKey: KEY, env: { ...env, ANT0_API_KEY: KEY } }),
    ).toThrow("invalid local daemon configuration");
    expect(discoverConnection({ home: daemon.home, apiKey: KEY, env })).toMatchObject({
      token: KEY,
      apiKey: true,
    });
    expect(daemon.requests).toEqual([]);
  });
});

describe("official MCP client with ANT0_API_KEY", () => {
  it("learns scopes from the key status and sends only the key with the MCP consumer", async () => {
    const daemon = await daemonFor(keyStatus(readyFile()));
    const { client, stderr } = await envClient(daemon, KEY);
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
      expect(JSON.stringify(result)).not.toContain(KEY);
      expect(JSON.stringify(result)).not.toContain(KEY.slice(-43));
      expect(JSON.stringify(result)).not.toContain(TOKEN);
      expect(JSON.stringify(result)).not.toContain(SECRET);
    }
    expect(daemon.requests[0]!.url).toBe("/v1/automation/status");
    expect(
      daemon.requests.every((r) => r.authorization === `Bearer ${KEY}` && r.consumer === "mcp"),
    ).toBe(true);
    expect(stderr()).not.toContain(KEY);
  });

  it("advertises only the tools the key's scopes allow", async () => {
    const file = readyFile();
    file.create.scopes = ["status:read", "proxies:read"];
    const daemon = await daemonFor(keyStatus(file));
    const { client } = await envClient(daemon, KEY);
    const { tools } = await client.listTools();
    expect(tools.map((tool) => tool.name).sort()).toEqual([
      "ant0_daemon_status",
      "ant0_licence_status",
      "ant0_proxies_list",
    ]);
    const denied = await client.callTool({ name: "ant0_profiles_list", arguments: {} });
    expect(denied.isError).toBe(true);
  });

  it.each([
    ["another key's status", { ...keyStatus(readyFile()).principal, key_id: ID }],
    ["no status scope", { ...keyStatus(readyFile()).principal, scopes: ["profiles:read"] }],
  ])("refuses to serve on %s", async (_label, principal) => {
    const daemon = await daemonFor({ ...keyStatus(readyFile()), principal });
    await expect(envClient(daemon, KEY)).rejects.toThrow();
    expect(daemon.requests.map((r) => r.url)).toEqual(["/v1/automation/status"]);
  });

  it("fails closed when the daemon refuses the key", async () => {
    const daemon = await mockDaemon((_req, res) => {
      res.writeHead(401);
      res.end(JSON.stringify({ error: "unauthorized", message: SECRET }));
    });
    cleanups.push(daemon.close);
    rmSync(join(daemon.home, "ant0d.pid"));
    await expect(envClient(daemon, KEY)).rejects.toThrow();
    expect(daemon.requests.every((r) => r.authorization === `Bearer ${KEY}`)).toBe(true);
  });
});
