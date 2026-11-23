import type { Readable, Writable } from "node:stream";
import {
  deserializeMessage,
  isJSONRPCRequest,
  serializeMessage,
  type JSONRPCMessage,
  type RequestId,
  type Transport,
} from "@modelcontextprotocol/server";
import { McpFailure, type FailureCode } from "./errors.js";
import { LIMITS } from "./limits.js";
import { OutputWriter, type OutputWorkerCommand } from "./output-writer.js";

interface PendingRequest {
  readonly wireId: RequestId;
  readonly sdkId: string;
  responseQueued: boolean;
}

interface CancelledParams {
  requestId?: RequestId;
  reason?: string;
  [key: string]: unknown;
}

/** The two fields of `notifications/cancelled` that this transport reads; anything else throws. */
function cancelledNotification(message: JSONRPCMessage): {
  jsonrpc: "2.0";
  method: string;
  params: CancelledParams;
} {
  const params = "params" in message ? (message.params as unknown) : undefined;
  if (!params || typeof params !== "object" || Array.isArray(params)) throw new Error("frame");
  const { requestId, reason } = params as CancelledParams;
  if (requestId !== undefined && typeof requestId !== "string" && typeof requestId !== "number")
    throw new Error("frame");
  if (reason !== undefined && typeof reason !== "string") throw new Error("frame");
  return { jsonrpc: "2.0", method: "notifications/cancelled", params: params as CancelledParams };
}

/** Request `_meta` key that carries the per-request protocol revision (2026-07-28). */
const PROTOCOL_VERSION_KEY = "io.modelcontextprotocol/protocolVersion";
/** The only revision a request envelope may name; this adapter serves no other per-request one. */
export const MODERN_VERSIONS = ["2026-07-28"] as const;

/** The protocol revision a request envelope claims, if it claims one. */
function claimedVersion(message: JSONRPCMessage): unknown {
  const params = "params" in message ? (message.params as unknown) : undefined;
  if (!params || typeof params !== "object") return undefined;
  const meta = (params as { _meta?: unknown })._meta;
  if (!meta || typeof meta !== "object") return undefined;
  return (meta as Record<string, unknown>)[PROTOCOL_VERSION_KEY];
}

/** SDK transport with byte-bounded framing and writes. The SDK owns protocol and cancellation. */
export class BoundedStdioTransport implements Transport {
  onclose?: () => void;
  onerror?: (error: Error) => void;
  onmessage?: NonNullable<Transport["onmessage"]>;
  readonly done: Promise<McpFailure | undefined>;
  /** Aborted the moment the transport shuts down (EOF, failure or close), before `done` settles. */
  readonly closedSignal: AbortSignal;
  private readonly closeController = new AbortController();
  private finish!: (failure?: McpFailure) => void;
  private closed = false;
  private started = false;
  private frame = Buffer.allocUnsafe(LIMITS.frameBytes);
  private size = 0;
  private pending = new Map<RequestId, PendingRequest>();
  private sdkRequests = new Map<string, PendingRequest>();
  private nextRequestId = 0;
  private writes = new Set<(error?: McpFailure) => void>();
  private outputBytes = 0;
  private writer: OutputWriter | undefined;
  private closing: Promise<void> | undefined;

  constructor(
    private readonly input: Readable,
    private readonly output: Writable,
    private readonly outputWorkerCommand?: OutputWorkerCommand,
  ) {
    this.closedSignal = this.closeController.signal;
    this.done = new Promise((resolve) => {
      this.finish = resolve;
    });
  }

  async start(): Promise<void> {
    if (this.started || this.closed) throw new McpFailure("input");
    this.started = true;
    if (this.output === process.stdout) {
      this.writer = new OutputWriter(
        process.stdout.fd,
        (code) => this.fail(code),
        this.outputWorkerCommand,
      );
      await this.writer.start();
    }
    if (this.closed) return;
    this.input.on("data", this.onData);
    this.input.on("error", this.onInputError);
    this.input.on("end", this.onEnd);
    this.input.on("close", this.onEnd);
    this.output.on("error", this.onOutputError);
    this.output.on("close", this.onOutputClose);
    if (this.input.readableEnded || this.input.destroyed) this.onEnd();
    else if (this.output.destroyed || this.output.writableEnded) this.fail("output");
  }

  private onData = (data: Buffer | string) => {
    const chunk = typeof data === "string" ? Buffer.from(data) : data;
    let start = 0;
    while (!this.closed && start < chunk.length) {
      const newline = chunk.indexOf(10, start);
      const end = newline === -1 ? chunk.length : newline;
      const length = end - start;
      if (this.size + length > LIMITS.frameBytes) return this.fail("frame_limit");
      chunk.copy(this.frame, this.size, start, end);
      this.size += length;
      if (newline === -1) return;
      try {
        const text = new TextDecoder("utf-8", { fatal: true }).decode(
          this.frame.subarray(0, this.size),
        );
        const message = deserializeMessage(text);
        this.size = 0;
        // The SDK schema already validates wire IDs, including 0 and the empty string. Keep
        // every valid ID within the frame bound; strings and numbers occupy distinct map keys.
        if ("method" in message && message.method.length > 128) return this.fail("frame");
        if (isJSONRPCRequest(message)) {
          if (this.pending.has(message.id)) return this.fail("frame");
          // SDK 2.4.0 stops checking the revision once a connection is pinned to 2026-07-28
          // (an issue in the MCP SDK). Reject an envelope naming any other revision, on every
          // request, with the answer the SDK gives on the first one.
          const claimed = claimedVersion(message);
          if (claimed !== undefined && !(MODERN_VERSIONS as readonly unknown[]).includes(claimed)) {
            void this.writeMessage({
              jsonrpc: "2.0",
              id: message.id,
              error: {
                code: -32022,
                message: "Unsupported protocol version",
                data: { supported: [...MODERN_VERSIONS] },
              },
            }).catch(() => {});
            start = end + 1;
            continue;
          }
          if (
            [...this.pending.values()].filter((entry) => !entry.responseQueued).length >=
            LIMITS.concurrentCalls
          ) {
            void this.writeMessage({
              jsonrpc: "2.0",
              id: message.id,
              error: { code: -32000, message: "Too many concurrent calls" },
            }).catch(() => {});
          } else {
            if (this.nextRequestId === Number.MAX_SAFE_INTEGER) return this.fail("input");
            const entry = {
              wireId: message.id,
              sdkId: `ant0/in/${++this.nextRequestId}`,
              responseQueued: false,
            };
            this.pending.set(entry.wireId, entry);
            this.sdkRequests.set(entry.sdkId, entry);
            // Distinct, truthy IDs also avoid SDK 1.30.0's falsy-ID cancellation bug. Generations
            // are never reused, even when the caller immediately reuses a cancelled wire ID.
            this.onmessage?.({ ...message, id: entry.sdkId });
          }
        } else if ("method" in message && message.method === "notifications/cancelled") {
          const cancelled = cancelledNotification(message);
          const wireId = cancelled.params.requestId;
          const entry = wireId === undefined ? undefined : this.pending.get(wireId);
          if (entry) {
            // Release at the protocol boundary for ALL methods, including SDK validation and
            // pre-handler cancellation. Late responses/write callbacks only know the old entry.
            this.finishRequest(entry);
            this.onmessage?.({
              jsonrpc: "2.0",
              method: cancelled.method,
              params: { ...cancelled.params, requestId: entry.sdkId },
            });
          }
        } else this.onmessage?.(message);
      } catch {
        return this.fail("frame");
      }
      start = end + 1;
    }
  };

  private onEnd = () => {
    if (this.size) this.fail("frame");
    else void this.close();
  };
  private onInputError = () => this.fail("input");
  private onOutputError = () => this.fail("output");
  private onOutputClose = () => this.fail("output");

  async send(message: JSONRPCMessage): Promise<void> {
    if (this.closed) throw new McpFailure("output");
    if (!("method" in message) && "id" in message) {
      const entry = typeof message.id === "string" ? this.sdkRequests.get(message.id) : undefined;
      // The SDK can complete an old request after cancellation/reuse. Never deliver that result
      // under a replacement request's wire ID, nor let its callback free the replacement slot.
      if (!entry || entry.responseQueued) return;
      await this.writeMessage({ ...message, id: entry.wireId }, entry);
    } else {
      // Server-originated pings and their cancellation notifications have an independent ID
      // namespace. Inbound responses likewise go straight to the SDK, not through this map.
      await this.writeMessage(message);
    }
  }

  private async writeMessage(message: JSONRPCMessage, entry?: PendingRequest): Promise<void> {
    if (this.closed) throw new McpFailure("output");
    // SDK validation errors can contain caller data; neither those messages nor data escape.
    if ("error" in message) {
      const code = [
        -32700, -32600, -32601, -32602, -32603, -32000, -32020, -32021, -32022,
      ].includes(message.error.code)
        ? message.error.code
        : -32603;
      message = {
        jsonrpc: "2.0",
        id: message.id,
        error: {
          code,
          message: code === -32000 ? "Too many concurrent calls" : "MCP request rejected",
          // 2026-07-28 negotiation: a modern client needs the supported list to pick a revision.
          // Only this fixed, non-caller-derived list is ever forwarded.
          ...(code === -32022 ? { data: { supported: [...MODERN_VERSIONS] } } : {}),
        },
      };
    }
    const text = serializeMessage(message);
    const bytes = Buffer.byteLength(text);
    if (
      // Tool results retain their independent 256 KiB limit. The envelope may also echo a
      // caller ID up to the input frame bound; it is never included in a tool result itself.
      bytes > LIMITS.envelopeBytes ||
      this.outputBytes + bytes > LIMITS.outputBytes ||
      this.writes.size >= LIMITS.outputWrites
    ) {
      this.fail("backpressure");
      throw new McpFailure("backpressure");
    }
    this.outputBytes += bytes;
    await new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => this.fail("backpressure"), LIMITS.outputMs);
      const finish = (error?: McpFailure) => {
        if (!this.writes.delete(finish)) return;
        clearTimeout(timer);
        this.outputBytes -= bytes;
        if (entry) this.finishRequest(entry);
        if (error) reject(error);
        else resolve();
      };
      this.writes.add(finish);
      // The peer can receive this terminal response before the writer's IPC ack reaches us.
      // It no longer occupies admission capacity, but its ID/generation and output budget stay
      // owned until ack/cancellation. Queued records remain bounded by the output queue limits.
      if (entry) entry.responseQueued = true;
      try {
        // Callback means the bytes were handed off, unlike write()'s boolean. A stalled pipe is
        // bounded by both aggregate queued bytes and a deadline, including when write() is true.
        const written = (error?: Error | null) => {
          if (error) this.fail("output");
          else finish();
        };
        if (this.writer) this.writer.write(text, written);
        else this.output.write(text, written); // Only explicitly injected asynchronous streams.
      } catch {
        this.fail("output");
      }
    });
  }

  fail(code: FailureCode): void {
    this.shutdown(new McpFailure(code));
  }

  private finishRequest(entry: PendingRequest): void {
    if (this.pending.get(entry.wireId) === entry) this.pending.delete(entry.wireId);
    if (this.sdkRequests.get(entry.sdkId) === entry) this.sdkRequests.delete(entry.sdkId);
  }

  async close(): Promise<void> {
    this.shutdown();
    await this.closing;
  }

  private shutdown(failure?: McpFailure): void {
    if (this.closed) return;
    this.closed = true;
    this.closeController.abort();
    this.input.off("data", this.onData);
    this.input.off("end", this.onEnd);
    this.input.off("close", this.onEnd);
    this.input.pause();
    this.input.destroy();
    // Keep the fixed error handlers until stream destruction completes (late EPIPE is possible).
    this.output.off("close", this.onOutputClose);
    this.frame = Buffer.alloc(0);
    this.pending.clear();
    this.sdkRequests.clear();
    for (const finish of this.writes) finish(failure ?? new McpFailure("cancelled"));
    this.closing = this.writer?.close() ?? Promise.resolve();
    // Parent stdout has never been written. No Socket _destroy override or blocking flush is
    // needed; only the child's inherited fd performs writes, on both Windows and Linux.
    if (this.output !== process.stdout) this.output.destroy();
    else (this.output as Writable & { unref?: () => void }).unref?.();
    this.onclose?.();
    void this.closing.then(() => this.finish(failure));
  }
}
