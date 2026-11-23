import { existsSync } from "node:fs";
import type { ServerResponse } from "node:http";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";
import { entry, mockDaemon, payload, rawClient } from "./helpers.js";

const cli = fileURLToPath(new URL("../dist/bin.js", import.meta.url));
const held = fileURLToPath(new URL("./fixtures/serve-held-drain.mjs", import.meta.url));
const delayedAck = fileURLToPath(new URL("./fixtures/serve-delayed-ack.mjs", import.meta.url));
const cleanups: (() => Promise<void>)[] = [];
afterEach(async () => {
  for (const close of cleanups.splice(0).reverse()) await close();
});
const ids = [0, "", 42, "42", -7, "ordinary", "ant0/in/1", "last"];
const call = (id: string | number) => ({
  jsonrpc: "2.0",
  id,
  method: "tools/call",
  params: { name: "ant0_daemon_status" },
});
const cancel = (id: string | number) => ({
  jsonrpc: "2.0",
  method: "notifications/cancelled",
  params: { requestId: id },
});
const frames = (messages: unknown[]) => messages.map((m) => JSON.stringify(m) + "\n").join("");

async function setup(kind: "package" | "cli" | "held" | "ack-initialize" | "ack-terminal") {
  if (!existsSync(cli)) throw new Error("build first: pnpm build");
  const active = new Set<ServerResponse>();
  let peak = 0;
  let closed = 0;
  const daemon = await mockDaemon((_req, res) => {
    active.add(res);
    peak = Math.max(peak, active.size);
    res.on("close", () => {
      active.delete(res);
      closed++;
    });
    res.writeHead(200, { "content-type": "application/json" });
    res.write("{");
  });
  cleanups.push(daemon.close);
  const args =
    kind === "cli"
      ? [cli, "serve", "--stdio", "--home", daemon.home]
      : kind === "ack-initialize" || kind === "ack-terminal"
        ? [delayedAck, daemon.home, kind]
        : [kind === "held" ? held : entry, daemon.home];
  // Natural package/CLI reproductions use ordinary stdio only, exactly like native SDK clients.
  const peer = rawClient(daemon.home, args, true, kind !== "package" && kind !== "cli");
  cleanups.push(async () => {
    peer.child.stdin.end();
    const kill = setTimeout(() => peer.child.kill("SIGKILL"), 2000);
    try {
      await peer.closed;
    } finally {
      clearTimeout(kill);
    }
  });
  const metrics: { stage: string; active: number; waiting: number; submitted: number }[] = [];
  const acknowledgements: (number | string)[] = [];
  let writerReaped = false;
  peer.child.on("message", (message: any) => {
    if (message.type === "permits") metrics.push(message);
    if (message.type === "ack-held") acknowledgements.push(message.id);
    if (message.type === "writer-reaped") writerReaped = true;
  });
  await peer.initialize();
  return {
    daemon,
    peer,
    active,
    peak: () => peak,
    closed: () => closed,
    metrics,
    acknowledgements,
    writerReaped: () => writerReaped,
    complete() {
      for (const response of active) response.end(JSON.stringify(payload("/v1/health")).slice(1));
    },
  };
}

describe("full-capacity cancellation and replacement admission", () => {
  it.each(["output", "backpressure"] as const)(
    "%s during a held terminal ACK still aborts eight admitted HTTP calls and reaps the writer",
    async (failure) => {
      const test = await setup("ack-initialize");
      await expect.poll(() => test.acknowledgements).toEqual([1]);
      test.peer.child.stdin.write(frames(ids.map(call)));
      await expect.poll(() => test.daemon.requests.length).toBe(8);
      expect(test.active.size).toBe(8);
      const started = Date.now();
      if (failure === "output") test.peer.child.send({ type: "kill-writer" });
      // With no release, the original one-second output deadline must still apply even though
      // initialization no longer consumes an admission slot. Keep the existing deadline bound.
      await expect.poll(() => test.peer.child.exitCode, { timeout: 2300 }).toBe(1);
      expect(Date.now() - started).toBeLessThan(2300);
      await test.peer.closed;
      await expect.poll(() => test.active.size).toBe(0);
      expect(test.daemon.requests).toHaveLength(8);
      expect(test.peak()).toBe(8);
      expect(test.writerReaped()).toBe(true);
      expect(test.peer.writerPid()).toBeGreaterThan(0);
      expect(() => process.kill(test.peer.writerPid()!, 0)).toThrow();
      expect(test.peer.stderr()).toBe(
        failure === "output" ? "mcp: MCP output failed\n" : "mcp: MCP output stalled\n",
      );
    },
  );

  it.each(["initialize", "terminal"] as const)(
    "admits eight calls after the %s response reaches stdout with its writer ACK held, but rejects a ninth",
    async (stage) => {
      const test = await setup(stage === "initialize" ? "ack-initialize" : "ack-terminal");
      const initialRequests = stage === "terminal" ? 1 : 0;
      if (stage === "terminal") {
        test.peer.send(call(100));
        await expect.poll(() => test.daemon.requests.length).toBe(1);
        test.complete();
        expect((await test.peer.response(100)).result.structuredContent.ok).toBe(true);
        await expect.poll(() => test.active.size).toBe(0);
      }
      await expect.poll(() => test.acknowledgements).toEqual([stage === "initialize" ? 1 : 100]);
      test.peer.child.stdin.write(frames(ids.map(call)));
      // Must reach eight BEFORE releasing the ACK. There is no retry or setup delay.
      await expect.poll(() => test.daemon.requests.length).toBe(initialRequests + 8);
      expect(test.active.size).toBe(8);
      const overflow = test.peer.request("tools/call", { name: "ant0_daemon_status" });
      test.peer.child.send({ type: "release-ack" });
      expect((await test.peer.response(overflow)).error.code).toBe(-32000);
      expect(test.daemon.requests).toHaveLength(initialRequests + 8);
      expect(test.peak()).toBe(8);
      test.complete();
      for (const id of ids)
        expect((await test.peer.response(id)).result.structuredContent.ok).toBe(true);
      await test.peer.close();
      expect(test.active.size).toBe(0);
      expect((await test.peer.closed).code).toBe(0);
      expect(test.writerReaped()).toBe(true);
      expect(test.peer.writerPid()).toBeGreaterThan(0);
      expect(() => process.kill(test.peer.writerPid()!, 0)).toThrow();
      expect(test.peer.stderr()).toBe("");
    },
  );

  it.each(["package", "cli"] as const)(
    "%s admits eight same-write replacements after cancelling eight active HTTP calls",
    async (kind) => {
      const test = await setup(kind);
      let current: (string | number)[] = ids;
      test.peer.child.stdin.write(frames(current.map(call)));
      await expect.poll(() => test.daemon.requests.length).toBe(8);
      for (let round = 0; round < 3; round++) {
        const overflow = await test.peer.response(
          test.peer.request("tools/call", { name: "ant0_daemon_status" }),
        );
        expect(overflow.error.code).toBe(-32000);
        expect(test.daemon.requests).toHaveLength((round + 1) * 8);
        const next = round === 1 ? current : ids.map((_id, i) => `replacement-${round}-${i}`);
        // All eight cancellations and replacements are delivered in ONE write, without waiting
        // for a socket close or any microtask between them. Round two also reuses the wire IDs.
        test.peer.child.stdin.write(frames([...current.map(cancel), ...next.map(call)]));
        current = next;
        await expect.poll(() => test.daemon.requests.length).toBe((round + 2) * 8);
        await expect.poll(test.closed).toBe((round + 1) * 8);
        expect(test.active.size).toBe(8);
        expect(test.peak()).toBe(8);
        expect(test.peer.stdout()).not.toContain("mcp.busy");
      }
      test.complete();
      for (const id of current) {
        const response = await test.peer.response(id);
        expect(response.result.isError).not.toBe(true);
        expect(response.result.structuredContent.ok).toBe(true);
      }
      await test.peer.close();
      expect(test.active.size).toBe(0);
      expect(test.peer.stderr()).toBe("");
    },
  );

  it("removes an already queued cancelled request and accepts its reused-ID replacement before held HTTP cleanup releases capacity", async () => {
    const test = await setup("held");
    test.peer.child.stdin.write(frames(ids.map(call)));
    await expect.poll(() => test.daemon.requests.length).toBe(8);
    const queued = ids.map((_id, i) => `queued-${i}`);
    test.peer.child.stdin.write(frames([...ids.map(cancel), ...queued.map(call)]));
    await expect.poll(() => test.metrics.some((m) => m.waiting === 8 && m.active === 8)).toBe(true);
    await expect.poll(test.closed).toBe(8);
    test.peer.child.stdin.write(frames([cancel(queued[0]!), call(queued[0]!)]));
    await expect
      .poll(() =>
        test.metrics.some((m) => m.stage === "submitted" && m.submitted === 17 && m.waiting === 8),
      )
      .toBe(true);
    expect(test.daemon.requests).toHaveLength(8);
    test.peer.child.send({ type: "release-drain" });
    await expect.poll(() => test.daemon.requests.length).toBe(16); // Cancelled waiter never did HTTP.
    expect(test.peak()).toBe(8);
    expect(test.peer.stdout()).not.toContain("mcp.busy");
    test.complete();
    for (const id of queued)
      expect((await test.peer.response(id)).result.structuredContent.ok).toBe(true);
    await test.peer.close();
    expect(test.metrics.at(-1)).toMatchObject({ stage: "drained", active: 0, waiting: 0 });
    expect(test.active.size).toBe(0);
  });

  it("EOF aborts all accepted waiters while cancelled HTTP holders are still draining, without starting queued HTTP", async () => {
    const test = await setup("held");
    test.peer.child.stdin.write(frames(ids.map(call)));
    await expect.poll(() => test.daemon.requests.length).toBe(8);
    test.peer.child.stdin.write(
      frames([...ids.map(cancel), ...ids.map((_id, i) => call(`queued-${i}`))]),
    );
    await expect.poll(() => test.metrics.some((m) => m.waiting === 8 && m.active === 8)).toBe(true);
    await test.peer.close();
    expect(test.metrics.find((m) => m.stage === "closed")).toMatchObject({ active: 8, waiting: 0 });
    expect(test.metrics.at(-1)).toMatchObject({ stage: "drained", active: 0, waiting: 0 });
    expect(test.daemon.requests).toHaveLength(8);
    expect(test.active.size).toBe(0);
    expect((await test.peer.closed).code).toBe(0);
    expect(test.peer.stderr()).toBe("");
  });
});
