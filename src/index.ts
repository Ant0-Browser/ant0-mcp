import type { Readable, Writable } from "node:stream";
import {
  serveStdio as serveSdkStdio,
  type StdioServerHandle,
} from "@modelcontextprotocol/server/stdio";
import { discoverConnection, type Connection, type DiscoveryOptions } from "./connection.js";
import { daemonClient } from "./daemon.js";
import { McpFailure, safeFailure } from "./errors.js";
import { CallPermits } from "./call-permits.js";
import { toolsForCredential } from "./tools.js";
import { buildServer } from "./server.js";
import { resolveGrant } from "./grant.js";
import { resolveHome } from "./api/index.js";
import { startExportSweeper } from "./export-files.js";
import { BoundedStdioTransport } from "./transport.js";
import { watchPeer } from "./peer-watchdog.js";
import type { OutputWorkerCommand } from "./output-writer.js";

export { McpFailure } from "./errors.js";
export { discoverConnection, canonicalOrigin } from "./connection.js";
export { daemonClient } from "./daemon.js";
export { keyMode } from "./connection.js";
export { resolveGrant } from "./grant.js";
export { serveHttp, httpOptionsFromEnv } from "./http.js";
export type { AuthorizationServer, HttpOptions, HttpServerHandle } from "./http.js";
export type { OutputWorkerCommand } from "./output-writer.js";

export interface ServeOptions extends DiscoveryOptions {
  stdin?: Readable;
  stdout?: Writable;
  signal?: AbortSignal;
}

/** Serve one stdio connection. Resolves on EOF/signal; rejects with fixed diagnostics only. */
export async function serveStdio(
  options: ServeOptions = {},
  outputWorkerCommand?: OutputWorkerCommand,
): Promise<void> {
  const lifetime = new AbortController();
  const transport = new BoundedStdioTransport(
    options.stdin ?? process.stdin,
    options.stdout ?? process.stdout,
    outputWorkerCommand,
  );
  transport.closedSignal.addEventListener("abort", () => lifetime.abort(), { once: true });
  const stop = () => {
    lifetime.abort();
    void transport.close();
  };
  const permits = new CallPermits();
  let stopSweeper: (() => void) | undefined;
  let handle: StdioServerHandle | undefined;
  try {
    const connection = discoverConnection(options);
    const home = resolveHome({
      ...(options.home !== undefined ? { home: options.home } : {}),
      env: options.env ?? process.env,
    });
    // Real 24 h retention: sweep at start and hourly, not only when a new export is written.
    stopSweeper = startExportSweeper(home);
    const client = daemonClient(connection, lifetime.signal);
    const grant = await resolveGrant(connection, client, "mcp", lifetime.signal);
    const tools = toolsForCredential(grant);
    const parts = { client, tools, grant, home, permits, lifetime: lifetime.signal };
    process.on("SIGINT", stop);
    process.on("SIGTERM", stop);
    options.signal?.addEventListener("abort", stop, { once: true });
    if (options.signal?.aborted) return;
    const failed = (error: Error) =>
      transport.fail(error instanceof McpFailure ? error.code : "input");
    // The factory runs once for the `server/discover` probe and again if the client falls back to
    // `initialize`, so everything resolved above is shared and nothing here is started once-only.
    // The probe instance is closed on fallback; its close must not end the connection (transport
    // shutdown does that, through `closedSignal`).
    handle = serveSdkStdio(
      (ctx) => {
        const server = buildServer(parts);
        server.onerror = failed;
        // ping and server-to-client requests exist only on `initialize` connections; a modern
        // (2026-07-28) connection ends on stdin EOF, which the transport already detects.
        if (ctx.era === "legacy") {
          // Starts after the writer is up (the transport starts before the first message), so a
          // ping can never precede the writer's startup budget.
          const stopWatching = watchPeer(server, lifetime.signal, () => transport.fail("peer"));
          server.onclose = stopWatching;
        }
        return server;
      },
      { transport, legacy: "serve", onerror: failed },
    );
    const failure = await transport.done;
    if (failure) throw failure;
  } catch (error) {
    if (lifetime.signal.aborted && error instanceof McpFailure && error.code === "cancelled")
      return;
    throw safeFailure(error);
  } finally {
    stopSweeper?.();
    lifetime.abort();
    await handle?.close().catch(() => {});
    await transport.close();
    process.off("SIGINT", stop);
    process.off("SIGTERM", stop);
    options.signal?.removeEventListener("abort", stop);
  }
}
