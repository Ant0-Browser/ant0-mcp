import { afterEach, describe, expect, it } from "vitest";
import { entry, mockDaemon, rawClient, sdkClient } from "./helpers.js";
import { keyDaemon } from "./key-daemon.js";

const cleanups: (() => Promise<void>)[] = [];
afterEach(async () => {
  for (const close of cleanups.splice(0).reverse()) await close();
});

const KEY_TOOLS = [
  "ant0_daemon_status",
  "ant0_licence_status",
  "ant0_profile_detail",
  "ant0_profile_run",
  "ant0_profile_status",
  "ant0_profile_stop",
  "ant0_profiles_list",
  "ant0_proxies_list",
  "ant0_sessions_list",
];

const ENVELOPE = {
  "io.modelcontextprotocol/protocolVersion": "2026-07-28",
  "io.modelcontextprotocol/clientCapabilities": {},
  "io.modelcontextprotocol/clientInfo": { name: "test", version: "1" },
};
const modern = (extra: Record<string, unknown> = {}) => ({ ...extra, _meta: { ...ENVELOPE } });

async function rawPeer(home: string) {
  const peer = rawClient(home);
  cleanups.push(async () => {
    if (peer.child.exitCode === null) peer.child.kill("SIGKILL");
    await peer.closed;
  });
  return peer;
}

describe.each(["legacy", "modern"] as const)(
  "official SDK client, %s era, over real stdio",
  (era) => {
    it("lists all 32 tools in local mode and calls one", async () => {
      const daemon = await mockDaemon();
      cleanups.push(daemon.close);
      const sdk = await sdkClient(daemon.home, [entry, daemon.home], era);
      cleanups.push(sdk.close);
      const { tools } = await sdk.client.listTools();
      expect(tools).toHaveLength(32);
      const result = await sdk.client.callTool({ name: "ant0_daemon_status", arguments: {} });
      expect(result.isError).not.toBe(true);
      expect(result.structuredContent).toMatchObject({ ok: true });
      expect(sdk.stderr()).toBe("");
    });

    it("lists exactly the nine scoped-key tools in key mode and refuses a local tool", async () => {
      const { daemon, env } = await keyDaemon();
      cleanups.push(daemon.close);
      const sdk = await sdkClient(daemon.home, [entry, daemon.home], era, env);
      cleanups.push(sdk.close);
      const { tools } = await sdk.client.listTools();
      expect(tools.map((tool) => tool.name).sort()).toEqual(KEY_TOOLS);
      const denied = await sdk.client.callTool({ name: "ant0_page_snapshot", arguments: {} });
      expect(denied.isError).toBe(true);
      expect(denied.structuredContent).toMatchObject({ error: "mcp.forbidden" });
      expect(sdk.stderr()).toBe("");
    });
  },
);

describe("2026-07-28 on the wire", () => {
  it("answers server/discover, serves per-request _meta statelessly, and never writes a request", async () => {
    const daemon = await mockDaemon();
    cleanups.push(daemon.close);
    const peer = await rawPeer(daemon.home);
    const discover = await peer.response(peer.request("server/discover", modern()));
    expect(discover.result.supportedVersions).toContain("2026-07-28");
    expect(discover.result.capabilities).toEqual({ tools: {} });
    const list = await peer.response(peer.request("tools/list", modern()));
    expect(list.result.tools).toHaveLength(32);
    expect(list.result.resultType).toBe("complete");
    expect(list.result.cacheScope).toBe("private");
    // ping is gone from 2026-07-28 and servers may not send requests: idle for several watchdog
    // intervals, nothing but responses may appear.
    await new Promise((resolve) => setTimeout(resolve, 2500));
    expect(peer.messages.every((m) => !("method" in m))).toBe(true);
    await peer.close();
    expect(peer.stderr()).toBe("");
  });

  it("exits 0 on stdin EOF with a modern connection idle, and aborts a pending call", async () => {
    let disconnected = 0;
    const daemon = await mockDaemon((_req, res) => {
      res.writeHead(200, { "content-type": "application/json" });
      res.write("{");
      res.on("close", () => {
        disconnected++;
      });
    });
    cleanups.push(daemon.close);
    const peer = await rawPeer(daemon.home);
    await peer.response(peer.request("server/discover", modern()));
    peer.request("tools/call", modern({ name: "ant0_daemon_status" }));
    await expect.poll(() => daemon.requests.length).toBe(1);
    peer.child.stdin.end();
    const exit = await peer.closed;
    expect(exit.code).toBe(0);
    await expect.poll(() => disconnected).toBe(1);
    expect(peer.stderr()).toBe("");
  });

  it("exits 0 on EOF for an idle modern connection that never called anything", async () => {
    const daemon = await mockDaemon();
    cleanups.push(daemon.close);
    const peer = await rawPeer(daemon.home);
    await peer.response(peer.request("tools/list", modern()));
    peer.child.stdin.end();
    expect((await peer.closed).code).toBe(0);
    expect(peer.stderr()).toBe("");
  });

  it("answers an unsupported revision with -32022 and the supported list, on every request", async () => {
    const daemon = await mockDaemon();
    cleanups.push(daemon.close);
    const peer = await rawPeer(daemon.home);
    const bad = (version: unknown) => ({
      _meta: { ...ENVELOPE, "io.modelcontextprotocol/protocolVersion": version },
    });
    const first = await peer.response(peer.request("tools/list", bad("2099-01-01")));
    expect(first.error).toEqual({
      code: -32022,
      message: "MCP request rejected",
      data: { supported: ["2026-07-28"] },
    });
    // Pin the connection, then try again: SDK 2.4.0 itself stops checking at this point.
    expect((await peer.response(peer.request("tools/list", modern()))).result.tools).toHaveLength(
      32,
    );
    for (const version of ["2099-01-01", "2025-11-25", 7]) {
      const again = await peer.response(peer.request("tools/list", bad(version)));
      expect(again.error).toEqual({
        code: -32022,
        message: "MCP request rejected",
        data: { supported: ["2026-07-28"] },
      });
    }
    expect((await peer.response(peer.request("tools/list", modern()))).result.tools).toHaveLength(
      32,
    );
    expect(peer.stderr()).toBe("");
  });
});

describe("2025-11-25 clients (initialize)", () => {
  it("a raw initialize client gets 2025-11-25, no 2026 fields, and the ping watchdog", async () => {
    const daemon = await mockDaemon();
    cleanups.push(daemon.close);
    const peer = await rawPeer(daemon.home);
    const init = await peer.response(
      peer.request("initialize", {
        protocolVersion: "2025-11-25",
        capabilities: {},
        clientInfo: { name: "test", version: "1" },
      }),
    );
    expect(init.result.protocolVersion).toBe("2025-11-25");
    peer.send({ jsonrpc: "2.0", method: "notifications/initialized" });
    const list = await peer.response(peer.request("tools/list"));
    expect(list.result.tools).toHaveLength(32);
    expect(list.result.resultType).toBeUndefined();
    await expect
      .poll(() => peer.messages.filter((m) => m.method === "ping").length, { timeout: 3000 })
      .toBeGreaterThanOrEqual(1);
    await peer.close();
    expect(peer.stderr()).toBe("");
  });

  it("server/discover followed by initialize (a dual-era fallback) leaks nothing and keeps one watchdog", async () => {
    const daemon = await mockDaemon();
    cleanups.push(daemon.close);
    const peer = await rawPeer(daemon.home);
    await peer.response(peer.request("server/discover", modern()));
    await peer.initialize();
    expect((await peer.response(peer.request("tools/list"))).result.tools).toHaveLength(32);
    // The discarded probe instance closed on fallback; that must not end the connection.
    await new Promise((resolve) => setTimeout(resolve, 1500));
    expect(peer.child.exitCode).toBeNull();
    peer.respondToPing(false);
    let exit: number | null | undefined;
    void peer.closed.then((result) => {
      exit = result.code;
    });
    await expect.poll(() => exit, { timeout: 4800 }).toBe(1);
    // Exactly one watchdog: it answered some pings, then one unanswered ping ended it.
    const pings = peer.messages.filter((m) => m.method === "ping");
    expect(new Set(pings.map((m) => m.id)).size).toBe(pings.length);
    expect(peer.stderr()).toBe("mcp: MCP peer did not answer ping\n");
  }, 8000);

  it("a modern probe that falls back does not abort calls on the legacy connection", async () => {
    const daemon = await mockDaemon();
    cleanups.push(daemon.close);
    const peer = await rawPeer(daemon.home);
    await peer.response(peer.request("server/discover", modern()));
    await peer.initialize();
    const call = await peer.response(peer.request("tools/call", { name: "ant0_daemon_status" }));
    expect(call.result.isError).toBeUndefined();
    expect(call.result.structuredContent.ok).toBe(true);
    await peer.close();
    expect(peer.stderr()).toBe("");
  });
});
