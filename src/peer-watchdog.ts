import type { Server } from "@modelcontextprotocol/server";
import { McpFailure } from "./errors.js";
import { LIMITS } from "./limits.js";

/** Standard MCP ping is legal during initialization. One in flight, with no progress extension. Legacy era only. */
export function watchPeer(server: Server, lifetime: AbortSignal, failed: () => void): () => void {
  let current: AbortController | undefined;
  let stopped = false;
  const stop = () => {
    if (stopped) return;
    stopped = true;
    clearInterval(timer);
    lifetime.removeEventListener("abort", stop);
    current?.abort(new McpFailure("cancelled"));
  };
  const ping = async () => {
    if (stopped || current) return;
    const controller = new AbortController();
    current = controller;
    try {
      // Server.ping() has no RequestOptions parameter. This is the same SDK ping request, with
      // the contract's timeout and a fresh, disposable abort signal. Legacy (initialize)
      // connections only: 2026-07-28 removed ping and server-to-client requests.
      await server.request(
        { method: "ping" },
        {
          timeout: LIMITS.pingResponseMs,
          maxTotalTimeout: LIMITS.pingResponseMs,
          resetTimeoutOnProgress: false,
          signal: controller.signal,
        },
      );
    } catch {
      if (!stopped) {
        current = undefined; // The request has settled; do not cancel it a second time.
        stop();
        failed();
      }
    } finally {
      if (current === controller) current = undefined;
    }
  };
  const tick = () => {
    void ping().catch(() => {
      if (!stopped) failed();
    });
  };
  const timer = setInterval(tick, LIMITS.pingIntervalMs);
  lifetime.addEventListener("abort", stop, { once: true });
  if (lifetime.aborted) stop();
  return stop;
}
