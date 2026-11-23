import { Client, InMemoryTransport } from "@modelcontextprotocol/client";
import { Server } from "@modelcontextprotocol/server";
import { afterEach, describe, expect, it, vi } from "vitest";
import { watchPeer } from "../src/peer-watchdog.js";
import { mockDaemon, rawClient, sdkClient } from "./helpers.js";

const cleanups: (() => Promise<void>)[] = [];
afterEach(async () => {
  for (const close of cleanups.splice(0).reverse()) await close();
  vi.useRealTimers();
});

async function setup() {
  let disconnected = 0;
  const daemon = await mockDaemon((_req, res) => {
    res.writeHead(200);
    res.write("{");
    res.on("close", () => {
      disconnected++;
    });
  });
  cleanups.push(daemon.close);
  const peer = rawClient(daemon.home);
  cleanups.push(async () => {
    if (peer.child.exitCode === null) peer.child.kill("SIGKILL");
    await peer.closed;
  });
  return { daemon, peer, disconnected: () => disconnected };
}

describe("standard MCP ping peer watchdog", () => {
  it.each(["idle", "active HTTP"])(
    "output-only closure %s aborts/exits within five seconds without another client write",
    async (phase) => {
      const { daemon, peer, disconnected } = await setup();
      await peer.initialize();
      if (phase === "active HTTP") {
        peer.request("tools/call", { name: "ant0_daemon_status" });
        await expect.poll(() => daemon.requests.length).toBe(1);
      }
      const time = Date.now();
      peer.child.stdout.destroy();
      // Keep stdin OPEN; neither ping nor any other client command follows this closure.
      let exit: number | null | undefined;
      void peer.closed.then((result) => {
        exit = result.code;
      });
      await expect.poll(() => exit, { timeout: 4800 }).toBe(1);
      expect(Date.now() - time).toBeLessThan(5000);
      if (phase === "active HTTP") expect(disconnected()).toBe(1);
      expect(peer.stderr()).toBe("mcp: MCP output failed\n");
    },
    7000,
  );

  it.each(["idle", "active HTTP"])(
    "a nonresponding peer %s has at most one outstanding ping and exits within five seconds",
    async (phase) => {
      const { daemon, peer, disconnected } = await setup();
      peer.respondToPing(false);
      await peer.initialize();
      if (phase === "active HTTP") {
        peer.request("tools/call", { name: "ant0_daemon_status" });
        await expect.poll(() => daemon.requests.length).toBe(1);
      }
      const time = Date.now();
      let exit: number | null | undefined;
      void peer.closed.then((result) => {
        exit = result.code;
      });
      await expect.poll(() => exit, { timeout: 4800 }).toBe(1);
      expect(Date.now() - time).toBeLessThan(5000);
      const pings = peer.messages.filter((m) => m.method === "ping");
      expect(pings).toHaveLength(1);
      expect(pings[0]).toEqual({ jsonrpc: "2.0", id: 0, method: "ping" });
      if (phase === "active HTTP") expect(disconnected()).toBe(1);
      expect(peer.stderr()).toBe("mcp: MCP peer did not answer ping\n");
    },
    6500,
  );

  it("writes no request before the first client message, then pings once the client has initialized", async () => {
    // The first message selects the era; a 2026-07-28 client may open with server/discover and
    // servers must not write requests to it. So there is nothing to ping before that message.
    const { peer } = await setup();
    await new Promise((resolve) => setTimeout(resolve, 2500));
    expect(peer.messages).toEqual([]);
    expect(peer.child.exitCode).toBeNull();
    await peer.initialize();
    await expect
      .poll(() => peer.messages.filter((m) => m.method === "ping").length, { timeout: 3800 })
      .toBeGreaterThanOrEqual(2);
    expect((await peer.response(peer.request("tools/list"))).result.tools).toHaveLength(32);
    expect(peer.stderr()).toBe("");
  });

  it("the official SDK answers repeated standard pings while idle", async () => {
    const daemon = await mockDaemon();
    cleanups.push(daemon.close);
    const sdk = await sdkClient(daemon.home);
    cleanups.push(sdk.close);
    const times: number[] = [];
    sdk.client.setRequestHandler("ping", () => {
      times.push(Date.now());
      return {};
    });
    await expect.poll(() => times.length, { timeout: 4800 }).toBeGreaterThanOrEqual(4);
    for (let i = 1; i < times.length; i++) expect(times[i]! - times[i - 1]!).toBeLessThan(1300);
    expect((await sdk.client.listTools()).tools).toHaveLength(32);
    expect(daemon.requests).toEqual([]);
    expect(sdk.stderr()).toBe("");
  }, 6500);

  it("clears interval/SDK deadlines on cancellation and never accumulates a second outstanding ping", async () => {
    const [serverTransport, clientTransport] = InMemoryTransport.createLinkedPair();
    const server = new Server({ name: "test", version: "1" });
    const client = new Client({ name: "test", version: "1" });
    await server.connect(serverTransport);
    await client.connect(clientTransport);
    let pings = 0;
    client.setRequestHandler("ping", () => {
      pings++;
      return new Promise(() => {});
    });
    vi.useFakeTimers();
    const lifetime = new AbortController();
    const failed = vi.fn();
    watchPeer(server, lifetime.signal, failed);
    await vi.advanceTimersByTimeAsync(3900);
    expect(pings).toBe(1);
    expect(failed).not.toHaveBeenCalled();
    lifetime.abort();
    await vi.advanceTimersByTimeAsync(10_000);
    expect(failed).not.toHaveBeenCalled();
    expect(pings).toBe(1);
    expect(vi.getTimerCount()).toBe(0);
    await client.close();
    await server.close();
  });

  it("enforces the exact three-second response deadline, stops its timer, and consumes the SDK rejection", async () => {
    const [serverTransport, clientTransport] = InMemoryTransport.createLinkedPair();
    const server = new Server({ name: "test", version: "1" });
    const client = new Client({ name: "test", version: "1" });
    await server.connect(serverTransport);
    await client.connect(clientTransport);
    let pings = 0;
    client.setRequestHandler("ping", () => {
      pings++;
      return new Promise(() => {});
    });
    vi.useFakeTimers();
    const failed = vi.fn();
    watchPeer(server, new AbortController().signal, failed);
    await vi.advanceTimersByTimeAsync(3999);
    expect(pings).toBe(1);
    expect(failed).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(1);
    expect(failed).toHaveBeenCalledTimes(1);
    expect(vi.getTimerCount()).toBe(0);
    await vi.advanceTimersByTimeAsync(5000);
    expect(pings).toBe(1);
    await client.close();
    await server.close();
  });
});
