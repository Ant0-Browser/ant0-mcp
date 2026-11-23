import { McpFailure } from "./errors.js";
import { LIMITS } from "./limits.js";

interface Waiter {
  readonly signal: AbortSignal;
  readonly resolve: (release: () => void) => void;
  readonly reject: (error: McpFailure) => void;
  readonly abort: () => void;
}

/** Eight executing handlers and at most eight accepted replacements waiting for HTTP drain. */
export class CallPermits {
  private active = 0;
  private readonly waiting = new Set<Waiter>(); // Insertion order is the admission FIFO.

  async run<T>(signal: AbortSignal, action: () => Promise<T>): Promise<T> {
    const release = await this.acquire(signal);
    try {
      // Cancellation can happen after grant but before this continuation starts. The permit
      // still has exactly one owner; no HTTP is started for that cancelled request.
      if (signal.aborted) throw new McpFailure("cancelled");
      return await action();
    } finally {
      release();
    }
  }

  private acquire(signal: AbortSignal): Promise<() => void> {
    if (signal.aborted) return Promise.reject(new McpFailure("cancelled"));
    if (this.active < LIMITS.concurrentCalls && this.waiting.size === 0) {
      return Promise.resolve(this.grant());
    }
    if (this.waiting.size >= LIMITS.concurrentCalls) return Promise.reject(new McpFailure("busy"));
    return new Promise((resolve, reject) => {
      const waiter: Waiter = {
        signal,
        resolve,
        reject,
        abort: () => {
          if (!this.waiting.delete(waiter)) return;
          signal.removeEventListener("abort", waiter.abort);
          reject(new McpFailure("cancelled"));
        },
      };
      this.waiting.add(waiter);
      signal.addEventListener("abort", waiter.abort, { once: true });
    });
  }

  private grant(): () => void {
    this.active++;
    let released = false;
    return () => {
      if (released) return;
      released = true;
      this.active--;
      this.drain();
    };
  }

  private drain(): void {
    while (this.active < LIMITS.concurrentCalls && this.waiting.size) {
      const waiter = this.waiting.values().next().value!;
      this.waiting.delete(waiter);
      waiter.signal.removeEventListener("abort", waiter.abort);
      if (waiter.signal.aborted) waiter.reject(new McpFailure("cancelled"));
      else waiter.resolve(this.grant());
    }
  }
}
