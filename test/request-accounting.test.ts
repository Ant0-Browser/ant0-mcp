import { PassThrough, Writable } from "node:stream";
import { afterEach, describe, expect, it } from "vitest";
import { BoundedStdioTransport } from "../src/transport.js";
import { LIMITS } from "../src/limits.js";
import { mockDaemon, payload, rawClient, sdkClient } from "./helpers.js";

const cleanups: (() => Promise<void>)[] = [];
afterEach(async () => {
  for (const close of cleanups.splice(0).reverse()) await close();
});

async function raw(handler?: Parameters<typeof mockDaemon>[0]) {
  const daemon = await mockDaemon(handler);
  cleanups.push(daemon.close);
  const peer = rawClient(daemon.home);
  cleanups.push(async () => {
    if (peer.child.exitCode === null) peer.child.kill("SIGKILL");
    await peer.closed;
  });
  await peer.initialize();
  return { daemon, peer };
}

const request = (id: number | string, method = "tools/list", params?: unknown) => ({
  jsonrpc: "2.0",
  id,
  method,
  ...(params === undefined ? {} : { params }),
});
const cancel = (id: number | string) => ({
  jsonrpc: "2.0",
  method: "notifications/cancelled",
  params: { requestId: id },
});
const frames = (...messages: unknown[]) =>
  messages.map((message) => JSON.stringify(message) + "\n").join("");

async function heldOutput() {
  const input = new PassThrough();
  const callbacks: ((error?: Error | null) => void)[] = [];
  const outputText: string[] = [];
  const output = new Writable({
    write(chunk, _encoding, done) {
      outputText.push(chunk.toString());
      callbacks.push(done);
    },
  });
  const transport = new BoundedStdioTransport(input, output);
  const accepted: any[] = [];
  transport.onmessage = (message) => accepted.push(message);
  cleanups.push(() => transport.close());
  await transport.start();
  return { input, output, callbacks, outputText, transport, accepted };
}

describe("SDK-independent request accounting and ID generations", () => {
  it.each(["result", "error"] as const)(
    "a queued terminal %s frees admission before ACK, retains its ID, and cannot be sent twice",
    async (kind) => {
      const { input, callbacks, outputText, transport, accepted } = await heldOutput();
      input.write(frames(request("completed")));
      const sdkId = accepted[0].id;
      const response = {
        jsonrpc: "2.0" as const,
        id: sdkId,
        ...(kind === "result" ? { result: {} } : { error: { code: -32602, message: "private" } }),
      };
      const written = transport.send(response);
      const rejected = expect(written).rejects.toMatchObject({ code: "frame" });
      await transport.send(response); // Only one terminal envelope per generation.
      expect(outputText).toHaveLength(1);
      input.write(frames(...Array.from({ length: 8 }, (_, i) => request(i))));
      input.write(frames(request("overflow")));
      expect(accepted.filter((m) => "id" in m)).toHaveLength(9);
      expect(callbacks).toHaveLength(1); // No output ACK, including for the terminal response.
      // Retiring admission is not permission to reuse an ID whose write is still owned.
      input.write(frames(request("completed")));
      expect((await transport.done)?.code).toBe("frame");
      await rejected;
      expect(accepted.filter((m) => "id" in m)).toHaveLength(9);
    },
  );

  it("ACK cleanup allows ID reuse, while old results cannot complete or free the new generation", async () => {
    const { input, callbacks, outputText, transport, accepted } = await heldOutput();
    input.write(frames(request("reused")));
    const oldId = accepted[0].id;
    const written = transport.send({ jsonrpc: "2.0", id: oldId, result: {} });
    callbacks.shift()!();
    await written;
    input.write(frames(request("reused")));
    const newId = accepted[1].id;
    expect(newId).not.toBe(oldId);
    await transport.send({ jsonrpc: "2.0", id: oldId, result: { stale: true } });
    expect(outputText).toHaveLength(1);
    input.write(frames(...Array.from({ length: 7 }, (_, i) => request(i)), request("overflow")));
    expect(accepted).toHaveLength(9);
    expect(JSON.parse(outputText.at(-1)!)).toMatchObject({
      id: "overflow",
      error: { code: -32000 },
    });
    input.write(frames(cancel("reused"), request("reused")));
    expect(accepted.at(-2).params.requestId).toBe(newId);
    expect(accepted.at(-1).id).not.toBe(newId);
    callbacks.shift()!();
  });

  it.each(["writes", "bytes"] as const)(
    "queued terminal responses and cancellation retain the output %s bound while eight new calls are active",
    async (bound) => {
      const { input, output, callbacks, outputText, transport, accepted } = await heldOutput();
      const count = bound === "writes" ? LIMITS.outputWrites : 2;
      const writes: Promise<string | undefined>[] = [];
      for (let i = 0; i < count; i++) {
        const wireId = `queued-${i}`;
        input.write(frames(request(wireId)));
        const empty = { jsonrpc: "2.0" as const, id: wireId, result: { padding: "" } };
        const size = Buffer.byteLength(JSON.stringify(empty) + "\n");
        const padding = bound === "bytes" ? "x".repeat(LIMITS.outputBytes / 2 - size) : "";
        writes.push(
          transport.send({ ...empty, id: accepted.at(-1).id, result: { padding } }).then(
            () => undefined,
            (error) => error.code as string,
          ),
        );
      }
      expect(accepted).toHaveLength(count);
      expect(callbacks).toHaveLength(1);
      expect(outputText).toHaveLength(1);
      input.write(frames(cancel("queued-0")));
      input.write(frames(...Array.from({ length: 8 }, (_, i) => request(i))));
      expect(accepted.filter((m) => "id" in m)).toHaveLength(count + 8);
      // Rejection of the ninth needs another output envelope: neither cancellation nor ending
      // admission can discard any of the still-unacknowledged writes/bytes to make room for it.
      input.write(frames(request("overflow")));
      expect((await transport.done)?.code).toBe("backpressure");
      expect(await Promise.all(writes)).toEqual(Array(count).fill("backpressure"));
      expect(input.destroyed).toBe(true);
      expect(output.destroyed).toBe(true);
      expect(accepted.filter((m) => "id" in m)).toHaveLength(count + 8);
    },
  );

  it.each(["callback", "stream"] as const)(
    "a late output %s failure terminates all eight newly admitted calls and settles the owned write",
    async (failure) => {
      const { input, output, callbacks, transport, accepted } = await heldOutput();
      input.write(frames(request("completed")));
      const written = transport.send({ jsonrpc: "2.0", id: accepted[0].id, result: {} });
      const rejected = expect(written).rejects.toMatchObject({ code: "output" });
      let closed = 0;
      transport.onclose = () => closed++;
      input.write(frames(...Array.from({ length: 8 }, (_, i) => request(i))));
      expect(accepted).toHaveLength(9);
      if (failure === "callback") callbacks.shift()!(new Error("private write failure"));
      else output.destroy(new Error("private stream failure"));
      expect((await transport.done)?.code).toBe("output");
      await rejected;
      expect(closed).toBe(1);
      expect(input.destroyed).toBe(true);
      expect(output.destroyed).toBe(true);
      await expect(
        transport.send({ jsonrpc: "2.0", id: accepted[1].id, result: {} }),
      ).rejects.toMatchObject({ code: "output" });
    },
  );

  it.each(["tools/list", "ping", "invalid tools/call", "unknown method"])(
    "reclaims eight same-chunk cancellations for %s, including pre-handler failures",
    async (kind) => {
      const { daemon, peer } = await raw();
      const method = kind === "invalid tools/call" ? "tools/call" : kind;
      const params = kind === "invalid tools/call" ? { name: {} } : undefined;
      for (let round = 0; round < 3; round++) {
        peer.child.stdin.write(
          Array.from({ length: 8 }, (_, i) => {
            const id = [0, "", 2, "2", -3, "ordinary", "ant0/in/1", "last"][i]!;
            return frames(request(id, method, params), cancel(id));
          }).join(""),
        );
        peer.send(request(100 + round));
        const response = await peer.response(100 + round);
        expect(response.error).toBeUndefined();
        expect(response.result.tools).toHaveLength(32);
      }
      expect(daemon.requests).toHaveLength(0);
      expect(peer.stderr()).toBe("");
    },
  );

  it("keeps the official SDK client usable after eight cancelled listTools calls", async () => {
    const daemon = await mockDaemon();
    cleanups.push(daemon.close);
    const sdk = await sdkClient(daemon.home);
    cleanups.push(sdk.close);
    const send = sdk.transport.send.bind(sdk.transport);
    let held: Parameters<typeof send>[0] | undefined;
    // Hold just the request until its cancellation exists, then send both in the same stdio
    // write. This reproduces cancellation before any SDK handler, without timer luck.
    sdk.transport.send = async (message) => {
      if ("method" in message && message.method === "tools/list") {
        held = message;
        return;
      }
      if ("method" in message && message.method === "notifications/cancelled" && held) {
        const child = (
          sdk.transport as unknown as { _process: { stdin: { write(text: string): void } } }
        )._process;
        child.stdin.write(frames(held, message));
        held = undefined;
        return;
      }
      return send(message);
    };
    for (let i = 0; i < 8; i++) {
      const abort = new AbortController();
      const pending = sdk.client.listTools({}, { signal: abort.signal });
      const rejected = expect(pending).rejects.toThrow();
      await Promise.resolve();
      abort.abort();
      await rejected;
    }
    sdk.transport.send = send;
    expect((await sdk.client.listTools()).tools).toHaveLength(32);
    expect(sdk.stderr()).toBe("");
  });

  it("aborts real HTTP for 0, empty, numeric/string and ordinary IDs, then immediately reuses them correctly", async () => {
    let started = 0;
    let aborted = 0;
    const { peer } = await raw((_req, res) => {
      started++;
      if (started % 2) {
        res.writeHead(200);
        res.write("{");
        res.on("close", () => {
          aborted++;
        });
      } else res.end(JSON.stringify(payload("/v1/health")));
    });
    for (const id of [0, "", 42, "42", -9, "ordinary", "ant0/in/1"]) {
      const count = started;
      const closes = aborted;
      peer.send(request(id, "tools/call", { name: "ant0_daemon_status" }));
      await expect.poll(() => started).toBe(count + 1);
      const time = Date.now();
      peer.child.stdin.write(
        frames(cancel(id), request(id, "tools/call", { name: "ant0_daemon_status" })),
      );
      await expect.poll(() => aborted, { timeout: 1000 }).toBe(closes + 1);
      expect(Date.now() - time).toBeLessThan(1000);
      const response = await peer.response(id);
      expect(response.id).toBe(id);
      expect(response.result.structuredContent).toEqual({
        ok: true,
        version: "0.1.0",
        uptime_s: 7,
      });
      expect(
        peer.messages.filter((message) => message.id === id && !("method" in message)),
      ).toHaveLength(1);
    }
    expect(peer.stderr()).toBe("");
  });

  it("keeps numeric 0 and string 0 distinct with all eight HTTP slots occupied and heartbeat traffic", async () => {
    let aborted = 0;
    const { daemon, peer } = await raw((_req, res) => {
      res.writeHead(200);
      res.write("{");
      res.on("close", () => {
        aborted++;
      });
    });
    const ids = [0, "0", "", "a", "b", "c", "d", "e"];
    for (const id of ids) peer.send(request(id, "tools/call", { name: "ant0_daemon_status" }));
    await expect.poll(() => daemon.requests.length).toBe(8);
    await expect
      .poll(() => peer.messages.filter((m) => m.method === "ping").length, { timeout: 2800 })
      .toBeGreaterThanOrEqual(2);
    expect((await peer.response(peer.request("tools/list"))).error.code).toBe(-32000);
    peer.send(cancel(0));
    await expect.poll(() => aborted).toBe(1);
    peer.send(request(0, "tools/call", { name: "ant0_daemon_status" }));
    await expect.poll(() => daemon.requests.length).toBe(9);
    peer.send(cancel("0"));
    await expect.poll(() => aborted).toBe(2);
    expect(peer.child.exitCode).toBeNull();
  });

  it("echoes long valid Unicode IDs within the input frame bound", async () => {
    const { peer } = await raw();
    const id = "💡".repeat(80_000);
    peer.send(request(id, "ping"));
    expect(await peer.response(id)).toEqual({ jsonrpc: "2.0", id, result: {} });
  });

  it("a late old result/write callback cannot deliver or release a reused ID's slot", async () => {
    const input = new PassThrough();
    const callbacks: (() => void)[] = [];
    const outputText: string[] = [];
    const output = new Writable({
      write(chunk, _encoding, done) {
        outputText.push(chunk.toString());
        callbacks.push(done);
      },
    });
    const transport = new BoundedStdioTransport(input, output);
    const accepted: any[] = [];
    transport.onmessage = (message) => {
      accepted.push(message);
    };
    await transport.start();
    try {
      input.write(frames(request("reused")));
      const oldId = accepted[0].id;
      const oldWrite = transport.send({ jsonrpc: "2.0", id: oldId, result: {} });
      input.write(frames(cancel("reused"), request("reused")));
      const newId = accepted[2].id;
      expect(newId).not.toBe(oldId);
      expect(accepted[1].params.requestId).toBe(oldId);
      await transport.send({ jsonrpc: "2.0", id: oldId, result: { stale: true } });
      expect(outputText).toHaveLength(1);
      callbacks.shift()!();
      await oldWrite;
      for (let i = 0; i < 7; i++) input.write(frames(request(i)));
      input.write(frames(request("overflow")));
      expect(accepted.filter((message) => "id" in message)).toHaveLength(9); // old + replacement + seven
      expect(JSON.parse(outputText.at(-1)!)).toMatchObject({
        id: "overflow",
        error: { code: -32000 },
      });
      input.write(frames(cancel("reused")));
      expect(accepted.at(-1).params.requestId).toBe(newId);
      callbacks.shift()!();
    } finally {
      await transport.close();
    }
  });
});
