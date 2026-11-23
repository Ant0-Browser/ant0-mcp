import { fstatSync, write } from "node:fs";
import { isatty } from "node:tty";
import { LIMITS } from "./limits.js";
import { outputDescriptorKind } from "./output-descriptor.js";

/** Private, side-effect-free on import. The bootstrap or ESM child entry calls this once. */
export function runOutputWorker(): void {
  if (!process.connected || typeof process.send !== "function") process.exit(1);
  // An IPC disconnect must stop this process even if its OS stdout write is blocked. fs.write
  // runs that potentially blocking work off this child's event loop; the parent can independently
  // kill the entire child at its deadline. No worker-thread termination is relied upon.
  process.on("disconnect", () => process.exit(0));
  process.on("uncaughtException", () => process.exit(1));
  process.on("unhandledRejection", () => process.exit(1));

  function send(message: object): void {
    if (!process.connected || !process.send) process.exit(1);
    process.send(message, (error) => {
      if (error) process.exit(1);
    });
  }

  let busy = false;
  let lastId = 0;
  process.on("message", (message: unknown) => {
    if (!message || typeof message !== "object" || busy) process.exit(1);
    const value = message as Record<string, unknown>;
    if (
      value.type !== "write" ||
      !Number.isSafeInteger(value.id) ||
      (value.id as number) <= lastId ||
      !Buffer.isBuffer(value.bytes) ||
      value.bytes.length > LIMITS.envelopeBytes
    )
      process.exit(1);
    const bytes = value.bytes;
    const id = value.id as number;
    lastId = id;
    busy = true;
    let offset = 0;
    const attempt = () => {
      write(1, bytes, offset, bytes.length - offset, null, (error, written) => {
        if (error) {
          // Inherited POSIX pipes may be nonblocking. Keep one bounded envelope and retry;
          // Windows synchronous pipe writes remain interruptible by killing this whole process.
          if (error.code === "EAGAIN" || error.code === "EWOULDBLOCK" || error.code === "EINTR") {
            setTimeout(attempt, 1);
            return;
          }
          process.exit(1);
        }
        offset += written;
        if (offset < bytes.length) {
          setTimeout(attempt, 1);
          return;
        }
        busy = false;
        send({ type: "ack", id });
      });
    };
    attempt();
  });

  try {
    // Inspect the inherited descriptor using raw libuv mode bits. On Windows a real pipe can
    // report mode 4096 while BOTH Stats.isFIFO() and Stats.isSocket() return false.
    const stat = fstatSync(1);
    const descriptor = outputDescriptorKind(stat.mode, isatty(1));
    if (descriptor === undefined) {
      send({ type: "unsupported" });
    } else send({ type: "ready", descriptor });
  } catch {
    process.exit(1);
  }
}
