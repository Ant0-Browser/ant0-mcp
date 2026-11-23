import { describe, expect, it } from "vitest";
import { CallPermits } from "../src/call-permits.js";

function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

describe("bounded cancellation-aware call permits", () => {
  it("holds eight executing leases through cancellation/drain and admits eight replacements in FIFO order", async () => {
    const permits = new CallPermits();
    const signals = Array.from({ length: 8 }, () => new AbortController());
    const drains = signals.map(deferred);
    const order: number[] = [];
    let executing = 0;
    let peak = 0;
    const old = signals.map((abort, i) =>
      permits.run(abort.signal, async () => {
        executing++;
        peak = Math.max(peak, executing);
        try {
          await drains[i]!.promise;
        } finally {
          executing--;
        }
      }),
    );
    await Promise.resolve();
    expect(executing).toBe(8);
    for (const signal of signals) signal.abort();
    const replacements = signals.map((_abort, i) =>
      permits.run(new AbortController().signal, async () => {
        executing++;
        peak = Math.max(peak, executing);
        order.push(i);
        await Promise.resolve();
        executing--;
      }),
    );
    await expect(permits.run(new AbortController().signal, async () => {})).rejects.toMatchObject({
      code: "busy",
    });
    expect(order).toEqual([]);
    expect(executing).toBe(8); // Aborting a holder is not releasing its still-draining lease.
    drains[0]!.resolve();
    await Promise.all(replacements);
    expect(order).toEqual([0, 1, 2, 3, 4, 5, 6, 7]);
    expect(peak).toBe(8);
    for (const drain of drains) drain.resolve();
    await Promise.all(old);
    expect(executing).toBe(0);
  });

  it("immediately removes aborted waiters so a full queue can accept a replacement without executing the cancelled action", async () => {
    const permits = new CallPermits();
    const drain = deferred();
    const holders = Array.from({ length: 8 }, () =>
      permits.run(new AbortController().signal, () => drain.promise),
    );
    const signals = Array.from({ length: 8 }, () => new AbortController());
    const order: number[] = [];
    const waiters = signals.map((abort, i) =>
      permits.run(abort.signal, async () => {
        order.push(i);
      }),
    );
    const cancelled = expect(waiters[3]).rejects.toMatchObject({ code: "cancelled" });
    signals[3]!.abort();
    const replacement = permits.run(new AbortController().signal, async () => {
      order.push(8);
    });
    await cancelled;
    expect(order).toEqual([]);
    drain.resolve();
    await Promise.all([...holders, ...waiters.filter((_w, i) => i !== 3), replacement]);
    expect(order).toEqual([0, 1, 2, 4, 5, 6, 7, 8]);
  });

  it("lifetime cancellation empties all waiters immediately while holders retain their leases until finally", async () => {
    const permits = new CallPermits();
    const lifetime = new AbortController();
    const drain = deferred();
    const holders = Array.from({ length: 8 }, () =>
      permits.run(lifetime.signal, () => drain.promise),
    );
    await Promise.resolve();
    let started = 0;
    const waiters = Array.from({ length: 8 }, () =>
      permits.run(lifetime.signal, async () => {
        started++;
      }),
    );
    const rejected = waiters.map((waiter) =>
      expect(waiter).rejects.toMatchObject({ code: "cancelled" }),
    );
    lifetime.abort();
    await Promise.all(rejected);
    drain.resolve();
    await Promise.all(holders);
    expect(started).toBe(0);
    await Promise.all(
      Array.from({ length: 8 }, () =>
        permits.run(new AbortController().signal, async () => {
          started++;
        }),
      ),
    );
    expect(started).toBe(8);
  });

  it("releases granted-before-start cancellations and throwing actions exactly once", async () => {
    const permits = new CallPermits();
    let started = 0;
    const abort = new AbortController();
    const cancelled = permits.run(abort.signal, async () => {
      started++;
    });
    abort.abort();
    await expect(cancelled).rejects.toMatchObject({ code: "cancelled" });
    await expect(
      permits.run(new AbortController().signal, async () => {
        throw new Error("test");
      }),
    ).rejects.toThrow("test");
    expect(started).toBe(0);
    const drain = deferred();
    const holders = Array.from({ length: 8 }, () =>
      permits.run(new AbortController().signal, async () => {
        started++;
        await drain.promise;
      }),
    );
    await Promise.resolve();
    const waiter = permits.run(new AbortController().signal, async () => {
      started++;
    });
    await Promise.resolve();
    expect(started).toBe(8);
    drain.resolve();
    await Promise.all([...holders, waiter]);
    expect(started).toBe(9);
  });
});
