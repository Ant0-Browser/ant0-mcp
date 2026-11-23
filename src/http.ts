import { createServer, type IncomingMessage, type Server as HttpServer } from "node:http";
import type { AddressInfo } from "node:net";
import { createRemoteJWKSet, decodeJwt, jwtVerify, type JWTPayload } from "jose";
import {
  OAuthError,
  OAuthErrorCode,
  bearerAuthChallengeResponse,
  createMcpHandler,
  getOAuthProtectedResourceMetadataUrl,
  hostHeaderValidationResponse,
  requireBearerAuth,
  type AuthInfo,
  type McpHttpHandler,
  type OAuthTokenVerifier,
} from "@modelcontextprotocol/server";
import { resolveHome } from "./api/index.js";
import { CallPermits } from "./call-permits.js";
import { discoverConnection, keyMode, type DiscoveryOptions } from "./connection.js";
import { daemonClient } from "./daemon.js";
import { McpFailure, safeFailure } from "./errors.js";
import { startExportSweeper } from "./export-files.js";
import { resolveGrant } from "./grant.js";
import { buildServer } from "./server.js";
import { toolScope, toolsForCredential } from "./tools.js";
import { MODERN_VERSIONS } from "./transport.js";

/** OAuth scopes this resource server understands. Nothing else widens or changes the tool set. */
export const HTTP_SCOPE_READ = "ant0.read";
export const HTTP_SCOPE_RUN = "ant0.run";
export const HTTP_SCOPES: readonly string[] = [HTTP_SCOPE_READ, HTTP_SCOPE_RUN];

/**
 * The tools one token scope may reach, before intersecting with the key's own grant:
 * `ant0.read` is every key read tool (status, licence, profiles, sessions, proxies) and
 * `ant0.run` is profile_run and profile_stop. No scope reaches a local-only tool.
 */
export function toolsForHttpScope(scope: string): readonly string[] {
  const wanted =
    scope === HTTP_SCOPE_READ
      ? (keyScope: string) => keyScope.endsWith(":read")
      : scope === HTTP_SCOPE_RUN
        ? (keyScope: string) => keyScope === "profiles:run" || keyScope === "profiles:stop"
        : () => false;
  return toolsForCredential()
    .map((tool) => tool.name)
    .filter((name) => {
      const keyScope = toolScope(name);
      return keyScope !== undefined && keyScope !== "local" && wanted(keyScope);
    });
}

export interface AuthorizationServer {
  /** The `iss` a token must carry, and the value listed in the protected resource metadata. */
  issuer: string;
  /** Where the issuer's signing keys (a JWKS) are fetched. https, or loopback for local tests. */
  jwksUrl: string;
}

export interface HttpOptions extends DiscoveryOptions {
  /** Listen address. Default 127.0.0.1; anything else needs `allowNonLoopback`. */
  host?: string;
  /** Listen port. Default 27180; 0 picks a free port (programmatic use only). */
  listenPort?: number;
  allowNonLoopback?: boolean;
  /**
   * The canonical URL of this MCP endpoint (RFC 8707 resource). A token's audience must equal
   * it. Its path is the endpoint path. https, or http only for a loopback host.
   */
  resource: string;
  authorizationServers: readonly AuthorizationServer[];
  /**
   * Full origins (scheme, host and port, e.g. `https://app.example.test:8443`) allowed to call
   * from browser or extension contexts. Default none. Entries are compared whole; a bare
   * hostname is refused at start.
   */
  allowedOrigins?: readonly string[];
  /** Largest accepted request body in bytes. Default 1 MiB. */
  maxBodyBytes?: number;
  signal?: AbortSignal;
}

export interface HttpServerHandle {
  readonly url: string;
  readonly port: number;
  close(): Promise<void>;
}

const DEFAULT_PORT = 27180;
const MAX_TOKEN_CHARS = 8192;
const ALGORITHMS = [
  "RS256",
  "RS384",
  "RS512",
  "PS256",
  "PS384",
  "PS512",
  "ES256",
  "ES384",
  "ES512",
  "EdDSA",
];
const LOOPBACK_HOSTS = new Set(["127.0.0.1", "localhost", "::1", "[::1]"]);

function refuse(reason: string): never {
  // The reason goes to stderr (never a protocol stream); the thrown failure stays fixed.
  process.stderr.write(`ant0-mcp: ${reason}\n`);
  throw new McpFailure("configuration");
}

function loopbackHost(host: string): boolean {
  return LOOPBACK_HOSTS.has(host) || /^127\.\d{1,3}\.\d{1,3}\.\d{1,3}$/.test(host);
}

function csv(value: string | undefined): string[] {
  return (value ?? "")
    .split(",")
    .map((part) => part.trim())
    .filter(Boolean);
}

/**
 * HTTP options from the environment, or undefined unless `ANT0_MCP_HTTP=1`.
 * ANT0_MCP_HTTP_HOST / ANT0_MCP_HTTP_PORT (default 127.0.0.1:27180),
 * ANT0_MCP_HTTP_ALLOW_NON_LOOPBACK=1, ANT0_MCP_RESOURCE (canonical resource URL),
 * ANT0_MCP_AUTH_ISSUERS and ANT0_MCP_AUTH_JWKS_URLS (comma lists, same length, paired by
 * position), ANT0_MCP_ALLOWED_ORIGINS (comma list of full origins, e.g. https://app.example.test).
 */
export function httpOptionsFromEnv(
  env: Record<string, string | undefined> = process.env,
): HttpOptions | undefined {
  if (env.ANT0_MCP_HTTP !== "1") return undefined;
  const issuers = csv(env.ANT0_MCP_AUTH_ISSUERS);
  const jwks = csv(env.ANT0_MCP_AUTH_JWKS_URLS);
  if (issuers.length !== jwks.length)
    refuse("ANT0_MCP_AUTH_ISSUERS and ANT0_MCP_AUTH_JWKS_URLS must pair up");
  const port = env.ANT0_MCP_HTTP_PORT;
  if (port !== undefined && !/^[1-9]\d{0,4}$/.test(port)) refuse("invalid ANT0_MCP_HTTP_PORT");
  return {
    env,
    ...(env.ANT0_MCP_HTTP_HOST !== undefined ? { host: env.ANT0_MCP_HTTP_HOST } : {}),
    ...(port !== undefined ? { listenPort: Number(port) } : {}),
    allowNonLoopback: env.ANT0_MCP_HTTP_ALLOW_NON_LOOPBACK === "1",
    resource: env.ANT0_MCP_RESOURCE ?? "",
    authorizationServers: issuers.map((issuer, index) => ({ issuer, jwksUrl: jwks[index]! })),
    allowedOrigins: csv(env.ANT0_MCP_ALLOWED_ORIGINS),
  };
}

/** Normalized origins from the configured list; anything but a bare http(s) origin is refused. */
function parseOrigins(entries: readonly string[]): Set<string> {
  const origins = new Set<string>();
  for (const entry of entries) {
    let url: URL;
    try {
      url = new URL(entry);
    } catch {
      return refuse("ANT0_MCP_ALLOWED_ORIGINS entries must be full origins such as https://host");
    }
    if (
      (url.protocol !== "https:" && url.protocol !== "http:") ||
      url.pathname !== "/" ||
      url.search ||
      url.hash ||
      url.username ||
      url.password
    )
      refuse("ANT0_MCP_ALLOWED_ORIGINS entries must be full origins such as https://host");
    origins.add(url.origin);
  }
  return origins;
}

/** True when an Origin header names exactly one allowed origin (scheme, host and port). */
function originAllowed(header: string, allowed: ReadonlySet<string>): boolean {
  try {
    const url = new URL(header);
    return url.origin === header && allowed.has(url.origin);
  } catch {
    return false;
  }
}

/** Same sanitizing as the stdio transport: fixed text, a code from the known set, no SDK data. */
function sanitizeMessage(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(sanitizeMessage);
  if (typeof value !== "object" || value === null || !("error" in value)) return value;
  const { id, error } = value as { id?: unknown; error?: { code?: unknown } };
  const code = [-32700, -32600, -32601, -32602, -32603, -32000, -32020, -32021, -32022].includes(
    error?.code as number,
  )
    ? (error!.code as number)
    : -32603;
  return {
    jsonrpc: "2.0",
    id: id ?? null,
    error: {
      code,
      message: code === -32000 ? "Too many concurrent calls" : "MCP request rejected",
      ...(code === -32022 ? { data: { supported: [...MODERN_VERSIONS] } } : {}),
    },
  };
}

function sanitizeJsonText(text: string): string {
  try {
    return JSON.stringify(sanitizeMessage(JSON.parse(text)));
  } catch {
    return text;
  }
}

/** Rewrites every JSON-RPC error in a JSON or SSE response; results and other bodies pass. */
async function sanitizeResponse(response: Response): Promise<Response> {
  const type = response.headers.get("content-type") ?? "";
  const headers = new Headers(response.headers);
  headers.delete("content-length");
  if (type.includes("application/json")) {
    const text = await response.text();
    return new Response(sanitizeJsonText(text), { status: response.status, headers });
  }
  if (type.includes("text/event-stream") && response.body) {
    const decoder = new TextDecoder();
    const encoder = new TextEncoder();
    let pending = "";
    const line = (raw: string) =>
      raw.startsWith("data:") ? `data: ${sanitizeJsonText(raw.slice(5).trim())}` : raw;
    const body = response.body.pipeThrough(
      new TransformStream<Uint8Array, Uint8Array>({
        transform(chunk, controller) {
          pending += decoder.decode(chunk, { stream: true });
          const lines = pending.split("\n");
          pending = lines.pop() ?? "";
          if (lines.length > 0)
            controller.enqueue(encoder.encode(lines.map(line).join("\n") + "\n"));
        },
        flush(controller) {
          if (pending) controller.enqueue(encoder.encode(line(pending)));
        },
      }),
    );
    return new Response(body, { status: response.status, headers });
  }
  return response;
}

function strippedResource(url: URL): string {
  const copy = new URL(url.href);
  copy.hash = "";
  return copy.href.replace(/\/$/, "");
}

function parseResource(value: string): URL {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    return refuse("ANT0_MCP_RESOURCE must be the canonical https URL of this endpoint");
  }
  const local = loopbackHost(url.hostname);
  if (
    (url.protocol !== "https:" && !(url.protocol === "http:" && local)) ||
    url.hash ||
    url.search ||
    url.username ||
    url.password
  )
    refuse("the resource URL must be https (http only on loopback) with no query or fragment");
  return url;
}

function parseIssuer(server: AuthorizationServer): { issuer: string; jwks: URL } {
  let issuer: URL;
  let jwks: URL;
  try {
    issuer = new URL(server.issuer);
    jwks = new URL(server.jwksUrl);
  } catch {
    return refuse("an authorization server issuer or JWKS URL is not a URL");
  }
  for (const url of [issuer, jwks])
    if (
      (url.protocol !== "https:" && !(url.protocol === "http:" && loopbackHost(url.hostname))) ||
      url.hash ||
      url.username ||
      url.password
    )
      refuse("authorization server URLs must be https (http only on loopback)");
  // Compare issuers exactly as configured; the value is what the token's iss must equal.
  return { issuer: server.issuer, jwks };
}

/** Verifies a JWT access token against the configured issuers' JWKS. Never forwards the token. */
function jwtVerifier(issuers: { issuer: string; jwks: URL }[], resource: URL): OAuthTokenVerifier {
  const keys = new Map(
    issuers.map(({ issuer, jwks }) => [
      issuer,
      createRemoteJWKSet(jwks, {
        timeoutDuration: 5000,
        cooldownDuration: 30_000,
        cacheMaxAge: 600_000,
      }),
    ]),
  );
  const canonical = strippedResource(resource);
  const invalid = () => new OAuthError(OAuthErrorCode.InvalidToken, "Invalid access token");
  return {
    async verifyAccessToken(token: string): Promise<AuthInfo> {
      if (token.length > MAX_TOKEN_CHARS) throw invalid();
      try {
        // Only picks which configured key set to use; jwtVerify then requires iss to match.
        const claimed = decodeJwt(token).iss;
        const jwks = typeof claimed === "string" ? keys.get(claimed) : undefined;
        if (!jwks) throw invalid();
        const { payload } = await jwtVerify(token, jwks, {
          issuer: claimed as string,
          algorithms: ALGORITHMS,
          requiredClaims: ["exp", "iss", "aud"],
          clockTolerance: 5,
        });
        const audience = ([] as unknown[]).concat(payload.aud);
        const match = audience.some(
          (value) =>
            typeof value === "string" && value.split("#")[0]!.replace(/\/$/, "") === canonical,
        );
        if (!match) throw invalid();
        return authInfo(payload, resource);
      } catch {
        throw invalid();
      }
    },
  };
}

function authInfo(payload: JWTPayload, resource: URL): AuthInfo {
  const scope =
    typeof payload.scope === "string"
      ? payload.scope.split(" ")
      : Array.isArray(payload.scp)
        ? (payload.scp as unknown[])
        : [];
  const clientId = [payload.client_id, payload.azp, payload.sub].find(
    (value): value is string => typeof value === "string",
  );
  return {
    // The access token is deliberately not kept: it is verified here and nothing downstream
    // (the factory context, the daemon client) can read or forward it.
    token: "",
    clientId: clientId ?? "unknown",
    scopes: scope.filter((value): value is string => typeof value === "string" && value !== ""),
    expiresAt: payload.exp!,
    resource,
  };
}

/** Read a body of at most `limit` bytes, or undefined when it is larger (or the client aborts). */
async function boundedBody(req: IncomingMessage, limit: number): Promise<Buffer | undefined> {
  const declared = req.headers["content-length"];
  if (declared !== undefined && (!/^\d+$/.test(declared) || Number(declared) > limit))
    return undefined;
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of req) {
    size += (chunk as Buffer).length;
    if (size > limit) return undefined;
    chunks.push(chunk as Buffer);
  }
  return Buffer.concat(chunks);
}

function webHeaders(req: IncomingMessage): Headers {
  const headers = new Headers();
  for (const [name, value] of Object.entries(req.headers)) {
    if (value === undefined) continue;
    for (const item of Array.isArray(value) ? value : [value]) headers.append(name, item);
  }
  return headers;
}

/**
 * Serve the Streamable HTTP endpoint as an OAuth resource server. Opt-in only; it refuses to
 * start without a delegated API key credential, a canonical resource URL and at least one
 * authorization server. The key (never the OAuth token) is what authenticates to ant0d.
 */
export async function serveHttp(options: HttpOptions): Promise<HttpServerHandle> {
  const host = options.host ?? "127.0.0.1";
  const local = loopbackHost(host);
  if (!local && options.allowNonLoopback !== true)
    refuse(
      "HTTP mode listens on loopback only; a non-loopback address needs ANT0_MCP_HTTP_ALLOW_NON_LOOPBACK=1",
    );
  if (options.authorizationServers.length === 0)
    refuse("HTTP mode needs at least one authorization server (issuer and JWKS URL)");
  const resource = parseResource(options.resource);
  const issuers = options.authorizationServers.map(parseIssuer);
  const maxBody = options.maxBodyBytes ?? 1024 * 1024;
  const lifetime = new AbortController();
  const permits = new CallPermits();
  let stopSweeper: (() => void) | undefined;
  let server: HttpServer | undefined;
  let handler: McpHttpHandler | undefined;
  const closeAll = async () => {
    lifetime.abort();
    stopSweeper?.();
    await handler?.close().catch(() => {});
    if (server?.listening)
      await new Promise<void>((resolve) => {
        server!.close(() => resolve());
        server!.closeAllConnections();
      });
  };
  try {
    const connection = discoverConnection(options);
    // Scoped keys only: with the local bearer the daemon would let every request through.
    if (!keyMode(connection))
      refuse(
        "HTTP mode requires a delegated API key (--credential-file or ANT0_API_KEY), not the local token",
      );
    const home = resolveHome({
      ...(options.home !== undefined ? { home: options.home } : {}),
      env: options.env ?? process.env,
    });
    stopSweeper = startExportSweeper(home);
    const client = daemonClient(connection, lifetime.signal);
    const grant = await resolveGrant(connection, client, "mcp", lifetime.signal);
    if (!grant) refuse("HTTP mode could not resolve the key's scopes");
    const tools = toolsForCredential(grant);
    // Defence in depth: a "local" tool can never be in a scoped key's list.
    if (
      tools.some((tool) => toolScope(tool.name) === "local" || toolScope(tool.name) === undefined)
    )
      throw new McpFailure("internal");

    const resourcePath = resource.pathname;
    const metadataUrl = getOAuthProtectedResourceMetadataUrl(resource);
    const wellKnown = new URL(metadataUrl).pathname;
    const metadata = {
      resource: strippedResource(resource),
      authorization_servers: issuers.map(({ issuer }) => issuer),
      scopes_supported: [...HTTP_SCOPES],
      bearer_methods_supported: ["header"],
      resource_name: "Ant0 MCP",
    };
    const verifier = jwtVerifier(issuers, resource);
    const gate = requireBearerAuth({
      verifier,
      resourceMetadataUrl: metadataUrl,
      expectedResource: resource,
    });
    // Hostnames only (the SDK compares without port). The public resource host may differ from
    // the listen address when a TLS proxy sits in front.
    const listenName = host.includes(":") && !host.startsWith("[") ? `[${host}]` : host;
    const allowedHosts = [
      ...new Set([resource.hostname, listenName, "localhost", "127.0.0.1", "[::1]"]),
    ];
    const allowedOrigins = parseOrigins(options.allowedOrigins ?? []);

    handler = createMcpHandler(
      (ctx) => {
        // The tool set of this one request: the key's tools narrowed by the token's scopes. No
        // authInfo means no tools at all (the gate above makes that unreachable).
        const allowed = new Set<string>();
        for (const scope of ctx.authInfo?.scopes ?? [])
          for (const name of toolsForHttpScope(scope)) allowed.add(name);
        return buildServer({
          client,
          tools,
          grant,
          home,
          permits,
          lifetime: lifetime.signal,
          allowed,
        });
      },
      { maxRequestBodySize: maxBody, legacy: "stateless" },
    );
    const mcp = handler;

    server = createServer(
      {
        maxHeaderSize: 16 * 1024,
        requestTimeout: 30_000,
        headersTimeout: 10_000,
        keepAliveTimeout: 5_000,
      },
      (req, res) => {
        void (async () => {
          const url = new URL(req.url ?? "/", `http://${req.headers.host ?? "localhost"}`);
          const web = new Request(url, { method: req.method ?? "GET", headers: webHeaders(req) });
          const send = async (response: Response, cors = true) => {
            res.statusCode = response.status;
            response.headers.forEach((value, name) => res.setHeader(name, value));
            const origin = req.headers.origin;
            if (cors && typeof origin === "string" && allowedOrigins.size > 0) {
              res.setHeader("Vary", "Origin");
              res.setHeader("Access-Control-Allow-Origin", origin);
              res.setHeader("Access-Control-Expose-Headers", "WWW-Authenticate");
            }
            res.setHeader("Cache-Control", "no-store");
            res.setHeader("X-Content-Type-Options", "nosniff");
            if (!response.body) return void res.end();
            const reader = response.body.getReader();
            res.on("close", () => void reader.cancel().catch(() => {}));
            try {
              for (;;) {
                const { done, value } = await reader.read();
                if (done) break;
                if (!res.write(value)) await new Promise((resolve) => res.once("drain", resolve));
              }
            } catch {
              // The peer went away; the SDK cancels the exchange from the aborted signal.
            }
            res.end();
          };
          const status = (code: number, headers: Record<string, string> = {}) =>
            send(new Response(null, { status: code, headers }), false);
          // DNS-rebinding and cross-origin defences come first, on every route.
          const origin = req.headers.origin;
          const bad =
            hostHeaderValidationResponse(web, allowedHosts) ??
            (typeof origin === "string" && !originAllowed(origin, allowedOrigins)
              ? Response.json({ error: "forbidden_origin" }, { status: 403 })
              : undefined);
          if (bad) return void (await send(bad, false));
          if (
            url.pathname === wellKnown ||
            url.pathname === "/.well-known/oauth-protected-resource"
          ) {
            if (req.method !== "GET" && req.method !== "HEAD")
              return void (await status(405, { Allow: "GET, HEAD" }));
            return void (await send(Response.json(metadata)));
          }
          if (url.pathname !== resourcePath) return void (await status(404));
          if (req.method === "OPTIONS" && typeof req.headers.origin === "string")
            return void (await status(204, {
              "Access-Control-Allow-Methods": "POST",
              "Access-Control-Allow-Headers":
                "authorization, content-type, mcp-protocol-version, mcp-method, mcp-name, accept",
              "Access-Control-Max-Age": "600",
              ...(allowedOrigins.size > 0
                ? { "Access-Control-Allow-Origin": req.headers.origin, Vary: "Origin" }
                : {}),
            }));
          // The 2026-07-28 endpoint is POST only: no GET stream, no DELETE session.
          if (req.method !== "POST") return void (await status(405, { Allow: "POST" }));
          const header = req.headers.authorization;
          if (typeof header === "string" && header.length > MAX_TOKEN_CHARS + 7)
            return void (await send(
              bearerAuthChallengeResponse(
                new OAuthError(OAuthErrorCode.InvalidToken, "Invalid access token"),
                {
                  resourceMetadataUrl: metadataUrl,
                },
              ),
            ));
          const auth = await gate(web);
          if (auth instanceof Response)
            return void (await send(
              auth.status === 401
                ? bearerAuthChallengeResponse(
                    new OAuthError(OAuthErrorCode.InvalidToken, "Invalid access token"),
                    { requiredScopes: [...HTTP_SCOPES], resourceMetadataUrl: metadataUrl },
                  )
                : auth,
            ));
          if (!auth.scopes.some((scope) => HTTP_SCOPES.includes(scope)))
            return void (await send(
              bearerAuthChallengeResponse(
                new OAuthError(OAuthErrorCode.InsufficientScope, "Insufficient scope"),
                {
                  requiredScopes: [HTTP_SCOPE_READ],
                  resourceMetadataUrl: metadataUrl,
                },
              ),
            ));
          const body = await boundedBody(req, maxBody);
          if (body === undefined) return void (await status(413));
          // Peek the (already bounded, in-memory) body: the gate runs before the SDK parses it.
          let peeked: { id?: unknown; method?: unknown; params?: { name?: unknown } } | undefined;
          try {
            const parsed: unknown = JSON.parse(body.toString("utf8"));
            if (typeof parsed === "object" && parsed !== null && !Array.isArray(parsed))
              peeked = parsed as typeof peeked;
          } catch {
            // Not JSON: the SDK answers it.
          }
          // No listChanged capability is advertised, so there is nothing to subscribe to. A
          // listen stream would outlive the token and could hold a connection slot for good.
          if (peeked?.method === "subscriptions/listen")
            return void (await send(
              Response.json(
                {
                  jsonrpc: "2.0",
                  id:
                    typeof peeked.id === "string" || typeof peeked.id === "number"
                      ? peeked.id
                      : null,
                  error: { code: -32601, message: "MCP request rejected" },
                },
                { status: 200 },
              ),
            ));
          // A tool the key grants but the token's scopes do not cover: tell the client which
          // scope to ask for (RFC 6750 step-up). Never reaches the SDK or the daemon.
          if (peeked?.method === "tools/call" && typeof peeked.params?.name === "string") {
            const name = peeked.params.name;
            const covered = auth.scopes.some((scope) => toolsForHttpScope(scope).includes(name));
            const needed = HTTP_SCOPES.find((scope) => toolsForHttpScope(scope).includes(name));
            if (!covered && needed !== undefined && tools.some((tool) => tool.name === name))
              return void (await send(
                bearerAuthChallengeResponse(
                  new OAuthError(OAuthErrorCode.InsufficientScope, "Insufficient scope"),
                  { requiredScopes: [needed], resourceMetadataUrl: metadataUrl },
                ),
              ));
          }
          const abort = new AbortController();
          res.on("close", () => abort.abort());
          const headers = webHeaders(req);
          // No token passthrough: the bearer is not even visible to the MCP layer's request.
          headers.delete("authorization");
          const request = new Request(url, {
            method: "POST",
            headers,
            body: new Uint8Array(body),
            signal: abort.signal,
          });
          let response: Response;
          try {
            response = await mcp.fetch(request, { authInfo: auth });
          } catch {
            response = Response.json(
              {
                jsonrpc: "2.0",
                id: null,
                error: { code: -32603, message: "MCP request rejected" },
              },
              { status: 500 },
            );
          }
          await send(await sanitizeResponse(response));
        })().catch(() => {
          if (!res.headersSent) res.statusCode = 500;
          res.end();
        });
      },
    );
    server.maxConnections = 64;
    await new Promise<void>((resolve, reject) => {
      server!.once("error", reject);
      server!.listen(options.listenPort ?? DEFAULT_PORT, host.replace(/^\[|\]$/g, ""), () =>
        resolve(),
      );
    });
    const port = (server.address() as AddressInfo).port;
    options.signal?.addEventListener("abort", () => void closeAll(), { once: true });
    return {
      url: `http://${host.includes(":") && !host.startsWith("[") ? `[${host}]` : host}:${port}${resourcePath}`,
      port,
      close: closeAll,
    };
  } catch (error) {
    await closeAll();
    throw error instanceof McpFailure ? error : safeFailure(error);
  }
}
