import { spawn } from "node:child_process";
import { closeSync, mkdtempSync, openSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";
import { LIMITS } from "../src/limits.js";
import { OutputWriter } from "../src/output-writer.js";

const fixture = fileURLToPath(new URL("./fixtures/output-parent.mjs", import.meta.url));
const cleanups: (() => Promise<void>)[] = [];
afterEach(async () => {
  for (const close of cleanups.splice(0).reverse()) await close();
});

function alive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ESRCH") return false;
    throw error;
  }
}

async function parent(mode?: string, fd?: number) {
  const child = spawn(process.execPath, [fixture, ...(mode ? [mode] : [])], {
    stdio: ["ignore", fd ?? "pipe", "pipe", "ipc"],
    serialization: "advanced",
    env: {
      ...process.env,
      ANT0_HOME: "TEST_PRIVATE_HOME",
      ANT0_TEST_SECRET: "TEST_PRIVATE_TOKEN",
      NODE_OPTIONS: "--no-warnings",
    },
  });
  const messages: any[] = [];
  const chunks: Buffer[] = [];
  let stderr = "";
  child.stdout?.on("data", (chunk: Buffer) => chunks.push(chunk));
  child.stderr!.on("data", (chunk: Buffer) => {
    stderr += chunk.toString();
  });
  child.on("message", (message) => messages.push(message));
  child.on("error", () => {});
  const closed = new Promise<number | null>((resolve) => child.on("close", resolve));
  const send = (message: unknown) => {
    if (child.connected) child.send(message as object, () => {});
  };
  cleanups.push(async () => {
    send({ type: "close" });
    // This also exercises the worker's IPC-disconnect cleanup if an assertion interrupted a test.
    const kill = setTimeout(() => child.kill("SIGKILL"), 2000);
    await closed;
    clearTimeout(kill);
  });
  await expect
    .poll(() => messages.find((m) => m.type === "ready" || m.type === "closed"), { timeout: 2500 })
    .toBeDefined();
  const ready = messages.find((m) => m.type === "ready" || m.type === "closed");
  return {
    child,
    send,
    messages,
    ready,
    closed,
    stderr: () => stderr,
    stdout: () => Buffer.concat(chunks).toString("utf8"),
  };
}

function frame(size: number): string {
  const prefix = '{"jsonrpc":"2.0","id":1,"result":{"padding":"';
  const suffix = '"}}\n';
  return prefix + "x".repeat(size - prefix.length - suffix.length) + suffix;
}

async function pausedParent() {
  const peer = await parent();
  peer.send({ type: "pause-writer" });
  await expect.poll(() => peer.messages.some((m) => m.type === "paused")).toBe(true);
  return peer;
}

async function assertReaped(peer: Awaited<ReturnType<typeof parent>>, code: number) {
  await expect.poll(() => peer.child.exitCode, { timeout: 2500 }).toBe(code);
  expect(await peer.closed).toBe(code);
  expect(alive(peer.ready.writerPid)).toBe(false);
  expect(peer.messages.some((m) => m.type === "closed")).toBe(true);
  expect(peer.stderr()).toBe("");
}

describe("owned output writer process", () => {
  it("snapshots an injected self-entry command while retaining minimal environment and ordered acks", async () => {
    const peer = await parent("self");
    expect(peer.ready.type).toBe("ready");
    expect(peer.ready.argv).toEqual([
      process.execPath,
      fileURLToPath(new URL("./fixtures/output-self.mjs", import.meta.url)),
      "--ant0-internal=mcp-output-worker-v1",
    ]);
    if (process.platform === "linux") {
      const env = readFileSync(`/proc/${peer.ready.writerPid}/environ`, "utf8");
      expect(env).not.toMatch(/ANT0_|NODE_OPTIONS|TEST_PRIVATE_HOME|TEST_PRIVATE_TOKEN/);
    }
    for (let id = 0; id < 3; id++) peer.send({ type: "write", id, text: `frame ${id} 💡\n` });
    await expect.poll(() => peer.messages.filter((m) => m.type === "written").length).toBe(3);
    expect(peer.messages.filter((m) => m.type === "written").map((m) => [m.id, m.error])).toEqual([
      [0, undefined],
      [1, undefined],
      [2, undefined],
    ]);
    await expect.poll(peer.stdout).toBe("frame 0 💡\nframe 1 💡\nframe 2 💡\n");
    peer.send({ type: "close" });
    await assertReaped(peer, 0);
  });

  it.each(["silent", "malformed", "early-exit", "disconnect"])(
    "bounds and reaps injected %s startup failure",
    async (mode) => {
      const started = Date.now();
      const peer = await parent(mode);
      await assertReaped(peer, 1);
      expect(Date.now() - started).toBeLessThan(2500);
      expect(peer.messages.find((m) => m.type === "failure")).toMatchObject({ code: "output" });
      expect(peer.stdout()).toBe("");
    },
  );

  it("retains unsupported-descriptor failure and reaping with the injected entry", async () => {
    const dir = mkdtempSync(join(tmpdir(), "ant0-output-file-"));
    cleanups.push(async () => rmSync(dir, { recursive: true, force: true }));
    const path = join(dir, "stdout");
    const fd = openSync(path, "w");
    let peer: Awaited<ReturnType<typeof parent>>;
    try {
      peer = await parent("self", fd);
    } finally {
      closeSync(fd);
    }
    await assertReaped(peer, 1);
    expect(peer.messages.find((m) => m.type === "failure")).toMatchObject({ code: "stdio" });
    expect(readFileSync(path, "utf8")).toBe("");
  });

  it("rejects a relative worker executable before spawn", () => {
    expect(() => new OutputWriter(1, () => {}, { executable: "node", args: [] })).toThrow(
      "MCP output failed",
    );
  });

  it("uses the inherited pipe/socket fd, private ESM dist entry, minimal environment, and ordered write acknowledgements", async () => {
    const peer = await parent();
    expect(["pipe", "socket"]).toContain(peer.ready.descriptor);
    expect(peer.ready.argv).toHaveLength(2);
    expect(peer.ready.argv[1].replaceAll("\\", "/")).toMatch(/\/dist\/output-worker\.js$/);
    expect(JSON.stringify(peer.ready.argv)).not.toMatch(/TEST_PRIVATE_HOME|TEST_PRIVATE_TOKEN/);
    if (process.platform === "linux") {
      const env = readFileSync(`/proc/${peer.ready.writerPid}/environ`, "utf8");
      expect(env).not.toMatch(/ANT0_|NODE_OPTIONS|TEST_PRIVATE_HOME|TEST_PRIVATE_TOKEN/);
    }
    const frames = [0, 1, 2].map(
      (id) =>
        JSON.stringify({ jsonrpc: "2.0", id, result: { label: "💡é\r\n".repeat(8000) } }) + "\n",
    );
    frames.forEach((text, id) => peer.send({ type: "write", text, id }));
    await expect.poll(() => peer.messages.filter((m) => m.type === "written").length).toBe(3);
    await expect.poll(peer.stdout).toBe(frames.join(""));
    expect(peer.messages.filter((m) => m.type === "written").map((m) => [m.id, m.error])).toEqual([
      [0, undefined],
      [1, undefined],
      [2, undefined],
    ]);
    peer.send({ type: "close" });
    await assertReaped(peer, 0);
  });

  it("kills and reaps a writer stalled on a real unread output pipe at the one-second deadline", async () => {
    const peer = await parent();
    peer.child.stdout!.pause();
    const started = Date.now();
    peer.send({ type: "write", id: 1, text: frame(LIMITS.envelopeBytes) });
    await expect.poll(() => peer.child.exitCode, { timeout: 2300 }).toBe(1);
    expect(Date.now() - started).toBeLessThan(2300);
    expect(peer.messages.find((m) => m.type === "failure")).toMatchObject({ code: "backpressure" });
    peer.child.stdout!.resume();
    await assertReaped(peer, 1);
  });

  it("broken output stops and reaps only the owned writer", async () => {
    const peer = await parent();
    peer.child.stdout!.destroy();
    peer.send({ type: "write", id: 1, text: frame(64) });
    await assertReaped(peer, 1);
    expect(peer.messages.find((m) => m.type === "failure")).toMatchObject({ code: "output" });
  });

  it("an unexpected writer exit is a stable output failure and is reaped", async () => {
    const peer = await parent();
    peer.send({ type: "kill-writer" });
    await assertReaped(peer, 1);
    expect(peer.messages.find((m) => m.type === "failure")).toMatchObject({ code: "output" });
  });

  it("rejects an oversized envelope before IPC/stdout and reaps the writer", async () => {
    const peer = await parent();
    peer.send({ type: "write", id: 1, text: frame(LIMITS.envelopeBytes + 1) });
    await assertReaped(peer, 1);
    expect(peer.stdout()).toBe("");
    expect(peer.messages.find((m) => m.type === "failure")).toMatchObject({ code: "backpressure" });
  });

  it.each(["SIGINT", "SIGTERM"] as const)(
    "%s leaves no owned writer running after native parent termination",
    async (signal) => {
      const peer = await parent();
      peer.child.stdout!.pause();
      peer.send({ type: "write", id: 1, text: frame(LIMITS.envelopeBytes) });
      await expect.poll(() => peer.child.stdout!.readableLength).toBeGreaterThan(0);
      peer.child.kill(signal);
      await expect
        .poll(() => peer.child.exitCode !== null || peer.child.signalCode !== null, {
          timeout: 2500,
        })
        .toBe(true);
      peer.child.stdout!.resume();
      const code = await peer.closed;
      if (process.platform === "win32") {
        expect(code).toBeNull();
        expect(peer.child.signalCode).toBe(signal);
        // The parent was forcibly terminated. Worker shutdown comes from IPC disconnect,
        // not from the parent's stop()/close() callback or a claimed graceful exit code.
        expect(peer.messages.some((m) => m.type === "closed")).toBe(false);
      } else {
        expect(code).toBe(0);
        expect(peer.child.signalCode).toBeNull();
        expect(peer.messages.some((m) => m.type === "closed")).toBe(true);
      }
      await expect.poll(() => alive(peer.ready.writerPid), { timeout: 2000 }).toBe(false);
      expect(peer.stderr()).toBe("");
    },
  );

  it.skipIf(process.platform === "win32")(
    "kills/reaps an independently frozen child, even when it cannot process IPC or run JS timers",
    async () => {
      const peer = await pausedParent();
      const started = Date.now();
      peer.send({ type: "write", id: 1, text: frame(64) });
      await assertReaped(peer, 1);
      expect(Date.now() - started).toBeLessThan(2300);
      expect(peer.messages.find((m) => m.type === "failure")).toMatchObject({
        code: "backpressure",
      });
    },
  );

  it.skipIf(process.platform === "win32")(
    "enforces the 32-write IPC queue bound including its in-flight entry",
    async () => {
      const peer = await pausedParent();
      for (let id = 0; id < LIMITS.outputWrites + 1; id++)
        peer.send({ type: "write", id, text: frame(64) });
      await assertReaped(peer, 1);
      expect(peer.messages.filter((m) => m.type === "written")).toHaveLength(
        LIMITS.outputWrites + 1,
      );
      expect(peer.messages.find((m) => m.type === "failure")).toMatchObject({
        code: "backpressure",
      });
      expect(peer.stdout()).toBe("");
    },
  );

  it.skipIf(process.platform === "win32")(
    "enforces the 2 MiB queued-byte bound including IPC's in-flight entry",
    async () => {
      const peer = await pausedParent();
      peer.send({ type: "write", id: 1, text: frame(LIMITS.outputBytes / 2) });
      peer.send({ type: "write", id: 2, text: frame(LIMITS.outputBytes / 2) });
      peer.send({ type: "write", id: 3, text: frame(64) });
      await assertReaped(peer, 1);
      expect(peer.messages.filter((m) => m.type === "written")).toHaveLength(3);
      expect(peer.messages.find((m) => m.type === "failure")).toMatchObject({
        code: "backpressure",
      });
    },
  );

  it.skipIf(process.platform === "win32")(
    "cancellation kills/reaps a frozen in-flight writer without waiting for an ack",
    async () => {
      const peer = await pausedParent();
      peer.send({ type: "write", id: 1, text: frame(64) });
      peer.send({ type: "close" });
      await assertReaped(peer, 0);
      expect(peer.messages.find((m) => m.type === "written")).toMatchObject({ error: "cancelled" });
    },
  );

  it.skipIf(process.platform !== "linux")(
    "parent death cannot leave a live blocked output writer behind",
    async () => {
      const peer = await parent();
      peer.child.stdout!.pause();
      peer.send({ type: "write", id: 1, text: frame(LIMITS.envelopeBytes) });
      // Wait for bytes, so the worker really has entered the write/retry path.
      await expect.poll(() => peer.child.stdout!.readableLength).toBeGreaterThan(0);
      peer.child.kill("SIGKILL");
      const running = () => {
        try {
          // A killed parent cannot reap an adopted child; init owns that wait. A zombie has no
          // live worker, fd or write. Ordinary shutdown tests above require actual reaping.
          return !readFileSync(`/proc/${peer.ready.writerPid}/stat`, "utf8")
            .split(") ")[1]!
            .startsWith("Z ");
        } catch (error) {
          if ((error as NodeJS.ErrnoException).code === "ENOENT") return false;
          throw error;
        }
      };
      await expect.poll(running, { timeout: 2000 }).toBe(false);
      peer.child.stdout!.resume();
      await peer.closed;
    },
  );
});
