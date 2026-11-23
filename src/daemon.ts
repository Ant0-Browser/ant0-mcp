import { createAnt0Client, type Ant0Client } from "./api/index.js";
import { request } from "node:http";
import { keyMode, type Connection } from "./connection.js";
import { McpFailure, type FailureCode } from "./errors.js";
import { LIMITS } from "./limits.js";
import { assertCredentialUnchangedAsync } from "./credential-file.js";
import { localRequestAllowed, mapDaemonError, matchLocalRoute } from "./local-routes.js";

// Profile path segments: MCP tools always send a UUID, while the CLI may also pass an exact name.
const UUID = "[0-9a-f-]{36}";
const PROFILE_REF = "[^/]+";
const LOCAL_READ_PATH = new RegExp(
  `^/v1/(health|licence|automation/status|profiles/${UUID}|inventory/(?:proxies|profiles(?:/${UUID})?))$`,
);
/** Delegated inventory reads (unchanged from the earlier credential format). */
const KEY_READ_PATH = new RegExp(
  `^/v1/(automation/status|inventory/(?:proxies|profiles(?:/${PROFILE_REF})?))$`,
);
/** The CLI additionally inspects the endpoint-free lifecycle of a run it could not confirm. */
const CLI_READ_PATH = new RegExp(
  `^/v1/(automation/status|inventory/(?:proxies|profiles(?:/${PROFILE_REF})?)|profiles/${PROFILE_REF}/run)$`,
);
/** Operations: MCP drives one saved profile; CDP start and bulk stay explicit CLI actions. */
const MCP_OPERATION_PATH = new RegExp(`^/v1/profiles/${UUID}/(?:run|stop)$`);
const CLI_OPERATION_PATH = new RegExp(
  `^/v1/profiles/(?:${PROFILE_REF}/(?:run|start|stop)|bulk-(?:start|stop))$`,
);

function parsedBody(text: string): Record<string, unknown> | undefined {
  try {
    const value: unknown = JSON.parse(text);
    return value !== null && typeof value === "object" && !Array.isArray(value)
      ? (value as Record<string, unknown>)
      : undefined;
  } catch {
    return undefined;
  }
}

/** Long launches get only their requested daemon timeout plus a ten-second transport margin. */
export function requestTimeoutMs(method: string, path: string, body: string): number {
  if (method !== "POST") return LIMITS.httpMs;
  const value = parsedBody(body);
  const ids = value?.ids;
  if (/\/bulk-(?:start|stop)$/.test(path)) {
    return Array.isArray(ids) && ids.length >= 1 && ids.length <= 50
      ? ids.length * 60_000 + 10_000
      : LIMITS.httpMs;
  }
  if (/\/(?:run|start)$/.test(path)) {
    const requested = value?.timeout_s;
    const seconds =
      requested === undefined
        ? 60
        : typeof requested === "number" &&
            Number.isInteger(requested) &&
            requested >= 1 &&
            requested <= 600
          ? requested
          : 0;
    return seconds === 0 ? LIMITS.httpMs : seconds * 1_000 + 10_000;
  }
  return 70_000;
}

/** Typed API client with a direct, non-proxying HTTP transport and no redirects or retries. */
export function daemonClient(
  connection: Connection,
  lifetime: AbortSignal,
  consumer: "api" | "mcp" = "mcp",
): Ant0Client {
  const boundedFetch: typeof fetch = async (input) => {
    if (!(input instanceof Request)) throw new McpFailure("internal");
    const url = new URL(input.url);
    const method = input.method;
    // Local-bearer-only routes (identity tools). Key-mode connections never consult this table,
    // so their allowlists below are unchanged.
    const local =
      consumer === "mcp" && !keyMode(connection)
        ? matchLocalRoute(method, url.pathname)
        : undefined;
    const body =
      method === "POST" || (local !== undefined && method === "PATCH")
        ? Buffer.from(await input.clone().arrayBuffer())
        : Buffer.alloc(0);
    if (body.length > LIMITS.bodyBytes) throw new McpFailure("configuration");
    const mutation =
      (method === "POST" &&
        (consumer === "mcp" ? MCP_OPERATION_PATH : CLI_OPERATION_PATH).test(url.pathname)) ||
      (local !== undefined && local.method !== "GET" && local.readOnly !== true);
    const allowedRead = !keyMode(connection)
      ? LOCAL_READ_PATH
      : consumer === "mcp"
        ? KEY_READ_PATH
        : CLI_READ_PATH;
    const inventoryQuery = /^\/v1\/inventory\/(?:profiles|proxies)$/.test(url.pathname);
    if (
      url.origin !== connection.origin ||
      url.username ||
      url.password ||
      url.hash ||
      (local
        ? !localRequestAllowed(local, url, body, (text) => parsedBody(text) !== undefined)
        : !((method === "GET" && allowedRead.test(url.pathname)) || mutation) ||
          (method === "GET" && body.length !== 0) ||
          (method === "POST" &&
            (url.searchParams.size !== 0 || !parsedBody(body.toString("utf8")))) ||
          [...url.searchParams.keys()].some(
            (key) =>
              !inventoryQuery ||
              !["limit", "offset", "q", "group", "tag", "running", "trashed"].includes(key),
          ))
    )
      throw new McpFailure("configuration");
    // Raw PNG bytes (screenshots) get their own cap; every other body keeps 1 MiB.
    const bodyLimit = local?.binary ? LIMITS.screenshotBytes : LIMITS.bodyBytes;
    const timeout = local ? 70_000 : requestTimeoutMs(method, url.pathname, body.toString("utf8"));
    const deadline = AbortSignal.timeout(timeout);
    const signal = AbortSignal.any([lifetime, input.signal, deadline]);
    const credentialCheck = async () => {
      if (!connection.credential) return;
      try {
        await assertCredentialUnchangedAsync(connection.credential, signal);
      } catch {
        throw new McpFailure(
          deadline.aborted ? "deadline" : signal.aborted ? "cancelled" : "configuration",
        );
      }
    };
    if (connection.credential) {
      await credentialCheck();
    }

    const response = await new Promise<Response>((resolve, reject) => {
      if (signal.aborted) return reject(new McpFailure("cancelled"));
      let settled = false;
      const finish = (code?: FailureCode, body?: Buffer) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        signal.removeEventListener("abort", abort);
        if (code) {
          req.destroy();
          void drained.then(() => reject(new McpFailure(code)));
        } else {
          try {
            let response: Response;
            if (local?.binary) {
              response = new Response(new Uint8Array(body!), {
                headers: { "content-type": "image/png" },
              });
            } else {
              const text = new TextDecoder("utf-8", { fatal: true }).decode(body!);
              if (!local?.text) JSON.parse(text);
              response = new Response(text, {
                headers: { "content-type": local?.text ? "text/plain" : "application/json" },
              });
            }
            void drained.then(() => resolve(response));
          } catch {
            req.destroy();
            void drained.then(() =>
              reject(new McpFailure(mutation ? "indeterminate" : "response")),
            );
          }
        }
      };
      const abort = () =>
        finish(mutation ? "indeterminate" : deadline.aborted ? "deadline" : "cancelled");
      const req = request(url, {
        method,
        agent: false,
        maxHeaderSize: 16 * 1024,
        headers: {
          authorization: `Bearer ${connection.token}`,
          accept: "application/json",
          "accept-encoding": "identity",
          ...(body.length > 0 ? { "content-type": "application/json" } : {}),
          ...(keyMode(connection) ? { "x-ant0-consumer": consumer } : {}),
        },
      });
      // Keep the handler's permit until the local request has closed, not merely until destroy()
      // was requested. agent:false also closes successful requests rather than pooling sockets.
      const drained = new Promise<void>((resolve) => req.once("close", resolve));
      const timer = setTimeout(() => finish(mutation ? "indeterminate" : "deadline"), timeout);
      signal.addEventListener("abort", abort, { once: true });
      req.on("error", () => finish(mutation ? "indeterminate" : "unavailable"));
      req.on("response", (res) => {
        res.on("error", () => finish(mutation ? "indeterminate" : "response"));
        const status = res.statusCode;
        const stopRoute = method === "POST" && /^\/v1\/profiles\/[^/]+\/stop$/.test(url.pathname);
        const expectedStatus = local?.status ?? (stopRoute ? 204 : 200);
        if (
          local &&
          (status === 400 ||
            status === 409 ||
            status === 422 ||
            status === 423 ||
            (local.page && (status === 408 || status === 403)))
        ) {
          // Read only the daemon's error `code`; no message, details or other field is kept.
          const chunks: Buffer[] = [];
          let size = 0;
          res.on("data", (chunk: Buffer) => {
            size += chunk.length;
            if (size > LIMITS.bodyBytes) return finish("upstream");
            chunks.push(chunk);
          });
          res.on("end", () =>
            finish(mapDaemonError(status, Buffer.concat(chunks, size), local.page === true)),
          );
          res.on("close", () => {
            if (!res.complete) finish("upstream");
          });
          return;
        }
        if (status !== expectedStatus) {
          res.destroy();
          return finish(
            status === 401
              ? "unauthorized"
              : status === 403
                ? "forbidden"
                : status === 404
                  ? "not_found"
                  : local && status === 503
                    ? "unavailable"
                    : "upstream",
          );
        }
        if (res.headers["content-encoding"] && res.headers["content-encoding"] !== "identity") {
          return finish(mutation ? "indeterminate" : "response");
        }
        if (Number(res.headers["content-length"]) > bodyLimit)
          return finish(mutation ? "indeterminate" : "body_limit");
        const chunks: Buffer[] = [];
        let size = 0;
        res.on("data", (chunk: Buffer) => {
          size += chunk.length;
          if (size > bodyLimit) return finish(mutation ? "indeterminate" : "body_limit");
          chunks.push(chunk);
        });
        res.on("end", () => {
          if (settled) return;
          if (expectedStatus === 204) {
            if (size !== 0) return finish("indeterminate");
            settled = true;
            clearTimeout(timer);
            signal.removeEventListener("abort", abort);
            // Only a stop answer may carry the sync state, and only the two known values pass.
            const sync = res.headers["ant0-sync"];
            const headers =
              stopRoute && (sync === "done" || sync === "pending") ? { "ant0-sync": sync } : {};
            void drained.then(() => resolve(new Response(null, { status: 204, headers })));
            return;
          }
          finish(undefined, Buffer.concat(chunks, size));
        });
        res.on("close", () => {
          if (!res.complete) finish(mutation ? "indeterminate" : "response");
        });
      });
      req.end(body);
    });
    // A credential that changed mid-flight invalidates the reply, never the effect already applied.
    try {
      await credentialCheck();
    } catch (error) {
      throw mutation ? new McpFailure("indeterminate") : error;
    }
    return response;
  };
  return createAnt0Client({
    baseUrl: connection.origin,
    token: connection.token,
    fetch: boundedFetch,
  });
}
