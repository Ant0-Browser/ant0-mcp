import { spawn, type ChildProcess } from "node:child_process";
import { isAbsolute } from "node:path";
import { fileURLToPath } from "node:url";
import { McpFailure, type FailureCode } from "./errors.js";
import { LIMITS } from "./limits.js";

/** Internal product dependency, never populated from CLI flags, environment or MCP input. */
export interface OutputWorkerCommand {
  readonly executable: string;
  readonly args: readonly string[];
}

interface Write {
  readonly id: number;
  readonly bytes: Buffer;
  readonly timer: ReturnType<typeof setTimeout>;
  readonly callback: (error?: McpFailure) => void;
}

/** An owned, independently killable stdout writer. The parent never writes the inherited fd. */
export class OutputWriter {
  private child: ChildProcess | undefined;
  private started = false;
  private stopping = false;
  private ready = false;
  private failure: McpFailure | undefined;
  private startupTimer: ReturnType<typeof setTimeout> | undefined;
  private resolveReady = () => {};
  private rejectReady: (error: McpFailure) => void = () => {};
  private resolveReaped!: () => void;
  private readonly reaped = new Promise<void>((resolve) => {
    this.resolveReaped = resolve;
  });
  private readonly queue: Write[] = [];
  private current: Write | undefined;
  private queuedBytes = 0;
  private sequence = 0;
  private descriptor: "pipe" | "socket" | undefined;
  private readonly command: OutputWorkerCommand;

  constructor(
    private readonly fd: number,
    private readonly failed: (code: FailureCode) => void,
    command?: OutputWorkerCommand,
  ) {
    const executable = command?.executable ?? process.execPath;
    const args = command
      ? [...command.args]
      : [fileURLToPath(new URL("./output-worker.js", import.meta.url))];
    if (
      !isAbsolute(executable) ||
      executable.includes("\0") ||
      args.some((arg) => typeof arg !== "string" || arg.includes("\0"))
    )
      throw new McpFailure("output");
    this.command = Object.freeze({ executable, args: Object.freeze(args) });
  }

  /** Lifecycle observations for tests; neither is sent over MCP or included in diagnostics. */
  get pid(): number | undefined {
    return this.child?.pid;
  }
  get descriptorKind(): "pipe" | "socket" | undefined {
    return this.descriptor;
  }

  async start(): Promise<void> {
    if (this.started || this.stopping) throw new McpFailure("output");
    this.started = true;
    const ready = new Promise<void>((resolve, reject) => {
      this.resolveReady = resolve;
      this.rejectReady = reject;
    });
    // Also cover cancellation during startup, before the caller resumes its await.
    void ready.catch(() => {});
    this.startupTimer = setTimeout(() => this.fail("output"), LIMITS.writerStartupMs);
    try {
      // Do not inherit NODE_OPTIONS, inspector flags, application credentials or home settings.
      const env: NodeJS.ProcessEnv = {};
      for (const key of ["SystemRoot", "WINDIR", "SystemDrive", "TEMP", "TMP"]) {
        if (process.env[key] !== undefined) env[key] = process.env[key];
      }
      this.child = spawn(this.command.executable, this.command.args, {
        env,
        stdio: ["ignore", this.fd, "ignore", "ipc"],
        serialization: "advanced",
        detached: false,
        windowsHide: true,
      });
      this.child.on("message", this.onMessage);
      this.child.on("error", () => this.fail("output"));
      this.child.on("disconnect", () => {
        if (!this.stopping) this.fail("output");
      });
      this.child.on("close", () => {
        if (!this.stopping) this.fail("output");
        this.resolveReaped();
      });
    } catch {
      this.fail("output");
      this.resolveReaped();
    }
    await ready;
  }

  write(text: string, callback: (error?: McpFailure) => void): void {
    if (this.stopping || !this.started) {
      callback(this.failure ?? new McpFailure("output"));
      return;
    }
    const size = Buffer.byteLength(text);
    if (
      size > LIMITS.envelopeBytes ||
      this.queuedBytes + size > LIMITS.outputBytes ||
      this.queue.length >= LIMITS.outputWrites ||
      this.sequence === Number.MAX_SAFE_INTEGER
    ) {
      this.fail("backpressure");
      callback(new McpFailure("backpressure"));
      return;
    }
    const entry: Write = {
      id: ++this.sequence,
      bytes: Buffer.from(text),
      timer: setTimeout(() => this.fail("backpressure"), LIMITS.outputMs),
      callback,
    };
    this.queuedBytes += size;
    this.queue.push(entry);
    this.pump();
  }

  private pump(): void {
    if (!this.ready || this.stopping || this.current || !this.queue.length) return;
    const entry = this.queue[0]!;
    this.current = entry;
    try {
      // Exactly one envelope is in IPC/the worker at a time. A send callback only acknowledges
      // IPC delivery; only the child's explicit ack acknowledges the actual stdout write.
      this.child!.send({ type: "write", id: entry.id, bytes: entry.bytes }, (error) => {
        if (error && !this.stopping && this.current === entry) this.fail("output");
      });
    } catch {
      this.fail("output");
    }
  }

  private onMessage = (message: unknown) => {
    if (this.stopping) return;
    if (!message || typeof message !== "object") return this.fail("output");
    const value = message as Record<string, unknown>;
    if (value.type === "unsupported" && !this.ready) return this.fail("stdio");
    if (
      value.type === "ready" &&
      !this.ready &&
      (value.descriptor === "pipe" || value.descriptor === "socket")
    ) {
      this.ready = true;
      this.descriptor = value.descriptor;
      clearTimeout(this.startupTimer);
      this.resolveReady();
      this.pump();
    } else if (value.type === "ack" && this.current && value.id === this.current.id) {
      const entry = this.current;
      this.current = undefined;
      this.queue.shift();
      this.queuedBytes -= entry.bytes.length;
      clearTimeout(entry.timer);
      entry.callback();
      this.pump();
    } else this.fail("output");
  };

  private fail(code: FailureCode): void {
    if (this.stopping) return;
    this.failure = new McpFailure(code);
    this.rejectReady(this.failure);
    // Notify the transport first, so HTTP/ping cancellation is immediate, not delayed by reaping.
    try {
      this.failed(code);
    } finally {
      void this.close();
    }
  }

  /** No detachment/unref: await the owned ChildProcess close event, including on every failure. */
  async close(): Promise<void> {
    if (!this.stopping) {
      this.stopping = true;
      clearTimeout(this.startupTimer);
      const error = this.failure ?? new McpFailure("cancelled");
      this.rejectReady(error);
      this.current = undefined;
      this.queuedBytes = 0;
      for (const entry of this.queue.splice(0)) {
        clearTimeout(entry.timer);
        entry.callback(error);
      }
      if (this.child) {
        if (this.child.exitCode === null && this.child.signalCode === null) {
          // Node uses TerminateProcess for SIGKILL on Windows. Only this owned child is targeted.
          this.child.kill("SIGKILL");
        }
      } else this.resolveReaped();
    }
    await this.reaped;
  }
}
