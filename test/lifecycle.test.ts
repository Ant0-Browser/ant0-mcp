import { PassThrough, Writable } from "node:stream";
import { afterEach, describe, expect, it } from "vitest";
import { BoundedStdioTransport } from "../src/transport.js";
import { LIMITS } from "../src/limits.js";
import { mockDaemon, rawClient, sdkClient, SECRET, profile, inventoryProfile } from "./helpers.js";

const cleanups: (() => Promise<void>)[] = [];
afterEach(async () => {
  for (const close of cleanups.splice(0).reverse()) await close();
});

async function stalled() {
  let disconnected = 0;
  const daemon = await mockDaemon((_req, res) => {
    res.writeHead(200, { "content-type": "application/json" });
    res.write("{");
    res.on("close", () => {
      disconnected++;
    });
  });
  cleanups.push(daemon.close);
  return { daemon, disconnected: () => disconnected };
}

async function raw(home: string) {
  const peer = rawClient(home);
  cleanups.push(async () => {
    if (peer.child.exitCode === null) peer.child.kill("SIGKILL");
    await peer.closed;
  });
  await peer.initialize();
  return peer;
}

async function exited(peer: ReturnType<typeof rawClient>) {
  let done = false;
  void peer.closed.then(() => {
    done = true;
  });
  await expect.poll(() => done, { timeout: 3000 }).toBe(true);
  return peer.closed;
}

describe("request and process lifecycle", () => {
  it("honors official SDK cancellation, closes the HTTP request promptly, and stays usable", async () => {
    const { daemon, disconnected } = await stalled();
    const sdk = await sdkClient(daemon.home);
    cleanups.push(sdk.close);
    const abort = new AbortController();
    const call = sdk.client.callTool(
      { name: "ant0_profiles_list" },
      {
        signal: abort.signal,
      },
    );
    const rejected = expect(call).rejects.toThrow();
    await expect.poll(() => daemon.requests.length).toBe(1);
    abort.abort();
    await rejected;
    await expect.poll(disconnected, { timeout: 1500 }).toBe(1);
    expect((await sdk.client.listTools()).tools).toHaveLength(32);
    expect(sdk.stderr()).toBe("");
  });

  it.each(["EOF", "partial EOF"])("%s aborts pending HTTP and exits promptly", async (kind) => {
    const { daemon, disconnected } = await stalled();
    const peer = await raw(daemon.home);
    peer.request("tools/call", { name: "ant0_sessions_list" });
    await expect.poll(() => daemon.requests.length).toBe(1);
    if (kind === "EOF") peer.child.stdin.end();
    else peer.child.stdin.end("{unfinished");
    const exit = await exited(peer);
    expect(exit.code).toBe(kind === "partial EOF" ? 1 : 0);
    await expect.poll(disconnected).toBe(1);
    expect(peer.stderr()).toBe(kind === "partial EOF" ? "mcp: invalid MCP input frame\n" : "");
  });

  it.each(["SIGINT", "SIGTERM"] as const)(
    "%s terminates the process, HTTP socket and owned writer using native platform semantics",
    async (signal) => {
      const { daemon, disconnected } = await stalled();
      const peer = await raw(daemon.home);
      await expect.poll(peer.writerPid).toBeDefined();
      const writerPid = peer.writerPid()!;
      peer.request("tools/call", { name: "ant0_daemon_status" });
      await expect.poll(() => daemon.requests.length).toBe(1);
      peer.child.kill(signal);
      const exit = await exited(peer);
      // child.kill is TerminateProcess on Windows; it does NOT call the installed JS handlers.
      if (process.platform === "win32") expect(exit).toEqual({ code: null, signal });
      else expect(exit).toEqual({ code: 0, signal: null });
      await expect.poll(disconnected).toBe(1);
      await expect
        .poll(
          () => {
            try {
              process.kill(writerPid, 0);
              return true;
            } catch (error) {
              if ((error as NodeJS.ErrnoException).code === "ESRCH") return false;
              throw error;
            }
          },
          { timeout: 2000 },
        )
        .toBe(false);
      expect(peer.stderr()).toBe("");
    },
  );

  it("allows eight concurrent calls, rejects overflow without HTTP, and frees cancelled slots", async () => {
    const { daemon, disconnected } = await stalled();
    const peer = await raw(daemon.home);
    const ids = Array.from({ length: 8 }, () =>
      peer.request("tools/call", { name: "ant0_proxies_list" }),
    );
    await expect.poll(() => daemon.requests.length).toBe(8);
    const overflow = await peer.response(peer.request("tools/call", { name: "ant0_proxies_list" }));
    expect(overflow.error).toEqual({ code: -32000, message: "Too many concurrent calls" });
    expect(daemon.requests).toHaveLength(8);
    for (const requestId of ids)
      peer.send({
        jsonrpc: "2.0",
        method: "notifications/cancelled",
        params: { requestId, reason: SECRET },
      });
    await expect.poll(disconnected).toBe(8);
    peer.request("tools/call", { name: "ant0_daemon_status" });
    await expect.poll(() => daemon.requests.length).toBe(9);
    expect(peer.stdout()).not.toContain(SECRET);
    expect(peer.stderr()).toBe("");
    peer.child.stdin.end();
    await exited(peer);
  });

  it("applies the ten-second deadline through an unfinished body", async () => {
    const { daemon, disconnected } = await stalled();
    const sdk = await sdkClient(daemon.home);
    cleanups.push(sdk.close);
    const started = Date.now();
    const result = await sdk.client.callTool({ name: "ant0_daemon_status" });
    expect(result.structuredContent!.error).toBe("mcp.deadline");
    expect(Date.now() - started).toBeGreaterThanOrEqual(9800);
    expect(Date.now() - started).toBeLessThan(12_000);
    await expect.poll(disconnected).toBe(1);
  }, 15_000);

  it.each([
    "not json\n",
    "[]\n",
    "\n",
    '{"jsonrpc":"2.0","id":{},"method":"ping"}\n',
    Buffer.from([0xff, 0x0a]),
  ])("malformed frames terminate and abort HTTP (%s)", async (frame) => {
    const { daemon, disconnected } = await stalled();
    const peer = await raw(daemon.home);
    peer.request("tools/call", { name: "ant0_daemon_status" });
    await expect.poll(() => daemon.requests.length).toBe(1);
    peer.child.stdin.write(frame);
    expect((await exited(peer)).code).toBe(1);
    await expect.poll(disconnected).toBe(1);
    expect(peer.stderr()).toBe("mcp: invalid MCP input frame\n");
  });

  it("rejects duplicate in-flight IDs rather than losing cancellation ownership", async () => {
    const { daemon, disconnected } = await stalled();
    const peer = await raw(daemon.home);
    const id = peer.request("tools/call", { name: "ant0_daemon_status" });
    await expect.poll(() => daemon.requests.length).toBe(1);
    peer.send({ jsonrpc: "2.0", id, method: "ping" });
    expect((await exited(peer)).code).toBe(1);
    await expect.poll(disconnected).toBe(1);
  });

  it("accepts an exact 1 MiB frame, multiple frames/chunk and split UTF-8, then rejects an oversized partial frame", async () => {
    const daemon = await mockDaemon();
    cleanups.push(daemon.close);
    const peer = await raw(daemon.home);
    const prefix = '{"jsonrpc":"2.0","id":100,"method":"ping","params":{"data":"';
    const suffix = '"}}';
    const exact =
      prefix + "x".repeat(LIMITS.frameBytes - Buffer.byteLength(prefix + suffix)) + suffix;
    peer.child.stdin.write(exact + "\n");
    expect((await peer.response(100)).result).toEqual({});
    const frame = Buffer.from(
      '{"jsonrpc":"2.0","id":101,"method":"ping","params":{"data":"💡"}}\n',
    );
    const at = frame.indexOf(Buffer.from("💡")) + 1;
    peer.child.stdin.write(frame.subarray(0, at));
    peer.child.stdin.write(
      Buffer.concat([
        frame.subarray(at),
        Buffer.from('{"jsonrpc":"2.0","id":102,"method":"ping"}\n'),
      ]),
    );
    expect((await peer.response(101)).result).toEqual({});
    expect((await peer.response(102)).result).toEqual({});
    peer.child.stdin.write("x".repeat(LIMITS.frameBytes + 1));
    expect((await exited(peer)).code).toBe(1);
    expect(peer.stderr()).toBe("mcp: MCP input frame exceeds limit\n");
  });

  it("replaces SDK protocol validation errors with bounded fixed messages", async () => {
    const daemon = await mockDaemon();
    cleanups.push(daemon.close);
    const peer = await raw(daemon.home);
    const response = await peer.response(peer.request("tools/call", { name: { secret: SECRET } }));
    expect(response.error.message).toBe("MCP request rejected");
    expect(peer.stdout()).not.toContain(SECRET);
    expect(daemon.requests).toHaveLength(0);
    peer.child.stdin.end();
    await exited(peer);
  });

  it("broken stdout aborts an active HTTP request and exits", async () => {
    const { daemon, disconnected } = await stalled();
    const peer = await raw(daemon.home);
    peer.request("tools/call", { name: "ant0_daemon_status" });
    await expect.poll(() => daemon.requests.length).toBe(1);
    peer.child.stdout.destroy();
    expect((await exited(peer)).code).toBe(1);
    await expect.poll(disconnected).toBe(1);
    expect(peer.stderr()).toBe("mcp: MCP output failed\n");
  });

  it("persistent real pipe backpressure terminates within the output deadline", async () => {
    const daemon = await mockDaemon((_req, res) =>
      res.end(
        JSON.stringify({
          items: Array.from({ length: 100 }, (_, i) => {
            const id = `12345678-1234-4234-8234-${String(i).padStart(12, "0")}`;
            return {
              ...inventoryProfile,
              profile: { ...profile, id, name: "x".repeat(256) },
              lifecycle: { ...inventoryProfile.lifecycle, profile_id: id },
            };
          }),
          total: 100,
        }),
      ),
    );
    cleanups.push(daemon.close);
    const peer = await raw(daemon.home);
    peer.child.stdout.pause();
    let exit: number | null | undefined;
    peer.child.on("exit", (code) => {
      exit = code;
    });
    for (let i = 0; i < 8; i++)
      peer.request("tools/call", { name: "ant0_profiles_list", arguments: { limit: 100 } });
    await expect.poll(() => exit, { timeout: 3000 }).toBe(1);
    peer.child.stdout.resume();
    await exited(peer);
    expect(peer.stderr()).toBe("mcp: MCP output stalled\n");
  });

  it("also bounds writes whose Writable callback never completes, even when write returns true", async () => {
    const input = new PassThrough();
    const output = new Writable({ write() {} });
    const transport = new BoundedStdioTransport(input, output);
    await transport.start();
    const send = transport.send({ jsonrpc: "2.0", id: 1, method: "ping" });
    const rejected = expect(send).rejects.toMatchObject({ code: "backpressure" });
    expect((await transport.done)?.code).toBe("backpressure");
    await rejected;
  });
});
