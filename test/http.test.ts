import { request as httpRequest, createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { exportJWK, generateKeyPair, SignJWT, type JWK } from "jose";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { McpFailure } from "../src/errors.js";
import {
  httpOptionsFromEnv,
  serveHttp,
  toolsForHttpScope,
  type HttpOptions,
  type HttpServerHandle,
} from "../src/http.js";
import { ID, TOKEN, mockDaemon } from "./helpers.js";
import { KEY, READ_SCOPES, keyDaemon } from "./key-daemon.js";
import type { KeyScope } from "../src/key-contract.js";

const seen = vi.hoisted(() => ({ headers: [] as string[][] }));
vi.mock("@modelcontextprotocol/server", async (importOriginal) => {
  const original = await importOriginal<typeof import("@modelcontextprotocol/server")>();
  return {
    ...original,
    createMcpHandler: ((factory: any, options: any) =>
      original.createMcpHandler((ctx: any) => {
        seen.headers.push([...(ctx.requestInfo?.headers.keys() ?? [])]);
        return factory(ctx);
      }, options)) as typeof original.createMcpHandler,
  };
});

const ISSUER = "https://auth.example.test";
const RESOURCE = "https://mcp.example.test/mcp";
const METADATA = "https://mcp.example.test/.well-known/oauth-protected-resource/mcp";
const READ_TOOLS = [
  "ant0_daemon_status",
  "ant0_licence_status",
  "ant0_profile_detail",
  "ant0_profile_status",
  "ant0_profiles_list",
  "ant0_proxies_list",
  "ant0_sessions_list",
];
const RUN_TOOLS = ["ant0_profile_run", "ant0_profile_stop"];

const cleanups: (() => Promise<void>)[] = [];
afterEach(async () => {
  vi.restoreAllMocks();
  for (const close of cleanups.splice(0).reverse()) await close();
});

/** A local issuer: one signing key and a JWKS endpoint. No network beyond loopback. */
async function issuer() {
  const good = await generateKeyPair("ES256");
  const other = await generateKeyPair("ES256");
  const jwk: JWK = { ...(await exportJWK(good.publicKey)), kid: "k1", alg: "ES256", use: "sig" };
  const jwks: Server = createServer((_req, res) => {
    res.setHeader("content-type", "application/json");
    res.end(JSON.stringify({ keys: [jwk] }));
  });
  await new Promise<void>((resolve) => jwks.listen(0, "127.0.0.1", resolve));
  cleanups.push(() => new Promise<void>((resolve) => jwks.close(() => resolve())));
  const url = `http://127.0.0.1:${(jwks.address() as AddressInfo).port}/jwks`;
  const sign = (
    claims: Record<string, unknown> = {},
    options: { key?: CryptoKey; iss?: string; aud?: string | string[]; exp?: number | string } = {},
  ) => {
    const jwt = new SignJWT({ scope: "ant0.read", client_id: "client-1", ...claims })
      .setProtectedHeader({ alg: "ES256", kid: "k1" })
      .setIssuer(options.iss ?? ISSUER)
      .setAudience(options.aud ?? RESOURCE)
      .setSubject("user-1")
      .setIssuedAt()
      .setExpirationTime(options.exp ?? "5m");
    return jwt.sign(options.key ?? good.privateKey);
  };
  return { jwksUrl: url, sign, wrongKey: other.privateKey };
}

async function start(
  overrides: Partial<HttpOptions> = {},
  scopes: KeyScope[] = undefined as unknown as KeyScope[],
) {
  const auth = await issuer();
  const { daemon, env } = await keyDaemon(scopes);
  cleanups.push(daemon.close);
  const handle: HttpServerHandle = await serveHttp({
    home: daemon.home,
    env,
    listenPort: 0,
    resource: RESOURCE,
    authorizationServers: [{ issuer: ISSUER, jwksUrl: auth.jwksUrl }],
    ...overrides,
  });
  cleanups.push(handle.close);
  return { auth, daemon, handle };
}

const ENVELOPE = {
  "io.modelcontextprotocol/protocolVersion": "2026-07-28",
  "io.modelcontextprotocol/clientCapabilities": {},
  "io.modelcontextprotocol/clientInfo": { name: "test", version: "1" },
};

async function rpc(
  handle: HttpServerHandle,
  method: string,
  params: Record<string, unknown>,
  token?: string,
  headers: Record<string, string> = {},
) {
  const response = await fetch(handle.url, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      accept: "application/json, text/event-stream",
      "mcp-protocol-version": "2026-07-28",
      "mcp-method": method,
      ...(method === "tools/call" ? { "mcp-name": String(params.name) } : {}),
      ...(token ? { authorization: `Bearer ${token}` } : {}),
      ...headers,
    },
    body: JSON.stringify({
      jsonrpc: "2.0",
      id: 1,
      method,
      params: { ...params, _meta: ENVELOPE },
    }),
  });
  const text = await response.text();
  let json: any;
  try {
    json = JSON.parse(text);
  } catch {
    const data = text.split("\n").find((line) => line.startsWith("data:"));
    json = data ? JSON.parse(data.slice(5)) : undefined;
  }
  return { status: response.status, headers: response.headers, json, text };
}

const names = (result: { json: any }) =>
  (result.json.result.tools as { name: string }[]).map((t) => t.name).sort();

describe("HTTP mode refuses to start", () => {
  let stderr: ReturnType<typeof vi.spyOn>;
  beforeEach(() => {
    stderr = vi.spyOn(process.stderr, "write").mockImplementation(() => true);
  });
  const refusal = async (promise: Promise<unknown>) => {
    const error = await promise.then(
      () => undefined,
      (e: unknown) => e,
    );
    expect(error).toBeInstanceOf(McpFailure);
    expect((error as McpFailure).code).toBe("configuration");
    return stderr.mock.calls.map((call) => String(call[0])).join("");
  };

  it("without a delegated key (local bearer mode)", async () => {
    const daemon = await mockDaemon();
    cleanups.push(daemon.close);
    const auth = await issuer();
    const text = await refusal(
      serveHttp({
        home: daemon.home,
        listenPort: 0,
        resource: RESOURCE,
        authorizationServers: [{ issuer: ISSUER, jwksUrl: auth.jwksUrl }],
      }),
    );
    expect(text).toContain("delegated API key");
    expect(daemon.requests).toEqual([]);
    expect(text).not.toContain(TOKEN);
  });

  it("without an authorization server", async () => {
    const { daemon, env } = await keyDaemon();
    cleanups.push(daemon.close);
    const text = await refusal(
      serveHttp({
        home: daemon.home,
        env,
        listenPort: 0,
        resource: RESOURCE,
        authorizationServers: [],
      }),
    );
    expect(text).toContain("authorization server");
    expect(daemon.requests).toEqual([]);
  });

  it("on a non-loopback address without the explicit allow flag", async () => {
    const auth = await issuer();
    const { daemon, env } = await keyDaemon();
    cleanups.push(daemon.close);
    const text = await refusal(
      serveHttp({
        home: daemon.home,
        env,
        host: "0.0.0.0",
        listenPort: 0,
        resource: RESOURCE,
        authorizationServers: [{ issuer: ISSUER, jwksUrl: auth.jwksUrl }],
      }),
    );
    expect(text).toContain("loopback");
  });

  it.each(["http://mcp.example.test/mcp", "https://mcp.example.test/mcp#frag", "not a url", ""])(
    "with the resource URL %j",
    async (resource) => {
      const auth = await issuer();
      const { daemon, env } = await keyDaemon();
      cleanups.push(daemon.close);
      await refusal(
        serveHttp({
          home: daemon.home,
          env,
          listenPort: 0,
          resource,
          authorizationServers: [{ issuer: ISSUER, jwksUrl: auth.jwksUrl }],
        }),
      );
    },
  );

  it.each([
    "app.example.test",
    "app.example.test:8443",
    "https://app.example.test/path",
    "ftp://a.test",
    "*",
  ])("with the malformed allowed origin %j", async (origin) => {
    const auth = await issuer();
    const { daemon, env } = await keyDaemon();
    cleanups.push(daemon.close);
    await refusal(
      serveHttp({
        home: daemon.home,
        env,
        listenPort: 0,
        resource: RESOURCE,
        authorizationServers: [{ issuer: ISSUER, jwksUrl: auth.jwksUrl }],
        allowedOrigins: [origin],
      }),
    );
  });

  it("with an insecure JWKS or issuer URL", async () => {
    const { daemon, env } = await keyDaemon();
    cleanups.push(daemon.close);
    await refusal(
      serveHttp({
        home: daemon.home,
        env,
        listenPort: 0,
        resource: RESOURCE,
        authorizationServers: [{ issuer: ISSUER, jwksUrl: "http://keys.example.test/jwks" }],
      }),
    );
  });
});

describe("HTTP configuration from the environment", () => {
  it("is off unless ANT0_MCP_HTTP=1", () => {
    expect(httpOptionsFromEnv({})).toBeUndefined();
    expect(httpOptionsFromEnv({ ANT0_MCP_HTTP: "true" })).toBeUndefined();
  });

  it("reads host, port, resource, paired issuers and origins; defaults to no non-loopback", () => {
    const options = httpOptionsFromEnv({
      ANT0_MCP_HTTP: "1",
      ANT0_MCP_HTTP_PORT: "27181",
      ANT0_MCP_RESOURCE: RESOURCE,
      ANT0_MCP_AUTH_ISSUERS: "https://a.test, https://b.test",
      ANT0_MCP_AUTH_JWKS_URLS: "https://a.test/jwks,https://b.test/jwks",
      ANT0_MCP_ALLOWED_ORIGINS: "https://app.test",
    })!;
    expect(options).toMatchObject({
      listenPort: 27181,
      allowNonLoopback: false,
      resource: RESOURCE,
      allowedOrigins: ["https://app.test"],
      authorizationServers: [
        { issuer: "https://a.test", jwksUrl: "https://a.test/jwks" },
        { issuer: "https://b.test", jwksUrl: "https://b.test/jwks" },
      ],
    });
    expect(options.host).toBeUndefined();
  });

  it("rejects unpaired issuers and a bad port", () => {
    vi.spyOn(process.stderr, "write").mockImplementation(() => true);
    expect(() =>
      httpOptionsFromEnv({ ANT0_MCP_HTTP: "1", ANT0_MCP_AUTH_ISSUERS: "https://a.test" }),
    ).toThrow(McpFailure);
    expect(() => httpOptionsFromEnv({ ANT0_MCP_HTTP: "1", ANT0_MCP_HTTP_PORT: "0" })).toThrow(
      McpFailure,
    );
  });
});

describe("scope map", () => {
  it("ant0.read is the seven read tools, ant0.run is run and stop, anything else is nothing", () => {
    expect([...toolsForHttpScope("ant0.read")].sort()).toEqual(READ_TOOLS);
    expect([...toolsForHttpScope("ant0.run")].sort()).toEqual(RUN_TOOLS);
    expect(toolsForHttpScope("ant0.admin")).toEqual([]);
    expect(toolsForHttpScope("profiles:read")).toEqual([]);
    for (const scope of ["ant0.read", "ant0.run"])
      for (const name of toolsForHttpScope(scope))
        expect(name).not.toMatch(/page|cdp|cookies|identity/);
  });
});

describe("HTTP resource server", () => {
  it("serves RFC 9728 protected resource metadata, path-specific and at the root, without a token", async () => {
    const { handle, auth } = await start();
    const base = new URL(handle.url).origin;
    for (const path of [
      "/.well-known/oauth-protected-resource/mcp",
      "/.well-known/oauth-protected-resource",
    ]) {
      const response = await fetch(`${base}${path}`);
      expect(response.status).toBe(200);
      expect(response.headers.get("content-type")).toContain("application/json");
      expect(await response.json()).toEqual({
        resource: RESOURCE,
        authorization_servers: [ISSUER],
        scopes_supported: ["ant0.read", "ant0.run"],
        bearer_methods_supported: ["header"],
        resource_name: "Ant0 MCP",
      });
    }
    expect(auth.jwksUrl).toContain("/jwks");
    expect((await fetch(`${base}/other`)).status).toBe(404);
    expect(
      (await fetch(`${base}/.well-known/oauth-protected-resource`, { method: "POST" })).status,
    ).toBe(405);
  });

  it("answers 401 with a resource_metadata challenge when there is no token", async () => {
    const { handle, daemon } = await start();
    const result = await rpc(handle, "tools/list", {});
    expect(result.status).toBe(401);
    const challenge = result.headers.get("www-authenticate")!;
    expect(challenge).toMatch(/^Bearer /);
    expect(challenge).toContain(`resource_metadata="${METADATA}"`);
    expect(daemon.requests.filter((r) => r.url !== "/v1/automation/status")).toEqual([]);
  });

  it("answers 401 invalid_token for a bad signature, wrong audience, wrong issuer, expired, unsigned and non-JWT tokens", async () => {
    const { handle, auth } = await start();
    const unsigned = `${Buffer.from('{"alg":"none"}').toString("base64url")}.${Buffer.from(
      JSON.stringify({
        iss: ISSUER,
        aud: RESOURCE,
        scope: "ant0.read",
        exp: Math.floor(Date.now() / 1000) + 300,
      }),
    ).toString("base64url")}.`;
    const cases: Record<string, string> = {
      "bad signature": await auth.sign({}, { key: auth.wrongKey }),
      "wrong audience": await auth.sign({}, { aud: "https://other.example.test/mcp" }),
      "audience list without us": await auth.sign(
        {},
        { aud: ["https://a.test", "https://b.test"] },
      ),
      "wrong issuer": await auth.sign({}, { iss: "https://evil.example.test" }),
      expired: await auth.sign({}, { exp: Math.floor(Date.now() / 1000) - 600 }),
      unsigned: unsigned,
      "not a jwt": "ant0_sk_v1_not-a-jwt",
      "huge token": "a".repeat(10_000),
    };
    for (const [label, token] of Object.entries(cases)) {
      const result = await rpc(handle, "tools/list", {}, token);
      expect(result.status, label).toBe(401);
      const challenge = result.headers.get("www-authenticate")!;
      expect(challenge, label).toContain("invalid_token");
      expect(challenge, label).toContain(`resource_metadata="${METADATA}"`);
      expect(result.text, label).not.toContain(token);
    }
  });

  it("accepts a token whose audience list contains the resource, with a trailing slash too", async () => {
    const { handle, auth } = await start();
    for (const aud of [[RESOURCE, "https://other.test"], `${RESOURCE}/`]) {
      const result = await rpc(handle, "tools/list", {}, await auth.sign({}, { aud }));
      expect(result.status).toBe(200);
    }
  });

  it("answers 403 insufficient_scope when the token carries none of this server's scopes", async () => {
    const { handle, auth } = await start();
    const result = await rpc(handle, "tools/list", {}, await auth.sign({ scope: "openid email" }));
    expect(result.status).toBe(403);
    const challenge = result.headers.get("www-authenticate")!;
    expect(challenge).toContain("insufficient_scope");
    expect(challenge).toContain('scope="ant0.read"');
    expect(challenge).toContain(`resource_metadata="${METADATA}"`);
  });

  it("lists only the tools the token scopes allow, within the key's own tools", async () => {
    const { handle, auth } = await start();
    const list = async (scope: string) =>
      names(await rpc(handle, "tools/list", {}, await auth.sign({ scope })));
    expect(await list("ant0.read")).toEqual(READ_TOOLS);
    expect(await list("ant0.run")).toEqual(RUN_TOOLS);
    expect(await list("ant0.read ant0.run")).toEqual([...READ_TOOLS, ...RUN_TOOLS].sort());
    expect(await list("ant0.read openid")).toEqual(READ_TOOLS);
    // scp as an array is the other common claim shape.
    const viaScp = await rpc(
      handle,
      "tools/list",
      {},
      await auth.sign({ scope: undefined, scp: ["ant0.run"] }),
    );
    expect(names(viaScp)).toEqual(RUN_TOOLS);
  });

  it("never exceeds the key: a read-only key with a read+run token lists the seven read tools", async () => {
    const { handle, auth } = await start({}, READ_SCOPES);
    const result = await rpc(
      handle,
      "tools/list",
      {},
      await auth.sign({ scope: "ant0.read ant0.run" }),
    );
    expect(names(result)).toEqual(READ_TOOLS);
    const run = await rpc(
      handle,
      "tools/call",
      { name: "ant0_profile_run", arguments: { id: ID } },
      await auth.sign({ scope: "ant0.read ant0.run" }),
    );
    expect(run.json.result.isError).toBe(true);
    expect(run.json.result.structuredContent.error).toBe("mcp.forbidden");
  });

  it("calls an allowed tool, refuses a tool outside the token scope and any local tool, and never reaches the daemon for them", async () => {
    const { handle, auth, daemon } = await start();
    const read = await auth.sign({ scope: "ant0.read" });
    const ok = await rpc(handle, "tools/call", { name: "ant0_daemon_status", arguments: {} }, read);
    expect(ok.status).toBe(200);
    expect(ok.json.result.isError).toBeUndefined();
    expect(ok.json.result.structuredContent).toBeDefined();
    const before = daemon.requests.length;
    const run = await rpc(
      handle,
      "tools/call",
      { name: "ant0_profile_run", arguments: { id: ID } },
      read,
    );
    expect(run.status).toBe(403);
    expect(run.headers.get("www-authenticate")).toContain('scope="ant0.run"');
    // Even a token with every scope cannot reach a local-only tool (the key has none).
    const all = await auth.sign({ scope: "ant0.read ant0.run" });
    for (const name of [
      "ant0_page_snapshot",
      "ant0_session_cdp",
      "ant0_profile_create",
      "ant0_cookies_export",
    ]) {
      const local = await rpc(handle, "tools/call", { name, arguments: {} }, all);
      expect(local.json.result.isError, name).toBe(true);
      expect(local.json.result.structuredContent.error, name).toBe("mcp.forbidden");
    }
    expect(daemon.requests.length).toBe(before);
  });

  it("serves a 2025-11-25 stateless client the same scope-narrowed tool list", async () => {
    const { handle, auth } = await start();
    const response = await fetch(handle.url, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        accept: "application/json, text/event-stream",
        authorization: `Bearer ${await auth.sign({ scope: "ant0.read" })}`,
      },
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/list", params: {} }),
    });
    const text = await response.text();
    expect(response.status, text).toBe(200);
    const json = JSON.parse(text.includes("data:") ? text.split("data:")[1]!.trim() : text);
    expect(names({ json })).toEqual(READ_TOOLS);
  });

  it("uses only its own key toward ant0d and never forwards the OAuth token", async () => {
    const { handle, auth, daemon } = await start();
    const token = await auth.sign({ scope: "ant0.read ant0.run" });
    await rpc(handle, "tools/list", {}, token);
    for (const name of ["ant0_daemon_status", "ant0_profiles_list", "ant0_profile_run"])
      await rpc(
        handle,
        "tools/call",
        { name, arguments: name === "ant0_profile_run" ? { id: ID } : {} },
        token,
      );
    expect(daemon.requests.length).toBeGreaterThan(2);
    for (const entry of daemon.requests) {
      expect(entry.authorization).toBe(`Bearer ${KEY}`);
      expect(JSON.stringify(entry)).not.toContain(token);
      expect(JSON.stringify(entry)).not.toContain(token.split(".")[1]!);
    }
  });

  it("rejects a disallowed Origin, accepts none or an allowlisted one, and never sends a wildcard", async () => {
    const { handle, auth } = await start({ allowedOrigins: ["https://app.example.test"] });
    const token = await auth.sign();
    const bad = await rpc(handle, "tools/list", {}, token, { origin: "https://evil.example.test" });
    expect(bad.status).toBe(403);
    const nullOrigin = await rpc(handle, "tools/list", {}, token, { origin: "null" });
    expect(nullOrigin.status).toBe(403);
    const good = await rpc(handle, "tools/list", {}, token, { origin: "https://app.example.test" });
    expect(good.status).toBe(200);
    expect(good.headers.get("access-control-allow-origin")).toBe("https://app.example.test");
    const none = await rpc(handle, "tools/list", {}, token);
    expect(none.status).toBe(200);
    expect(none.headers.get("access-control-allow-origin")).toBeNull();
    const base = new URL(handle.url).origin;
    const pre = await fetch(`${base}/mcp`, {
      method: "OPTIONS",
      headers: { origin: "https://evil.example.test", "access-control-request-method": "POST" },
    });
    expect(pre.status).toBe(403);
  });

  it("rejects every Origin by default, even on the metadata route", async () => {
    const { handle, auth } = await start();
    const result = await rpc(handle, "tools/list", {}, await auth.sign(), {
      origin: "http://127.0.0.1",
    });
    expect(result.status).toBe(403);
    const meta = await fetch(`${new URL(handle.url).origin}/.well-known/oauth-protected-resource`, {
      headers: { origin: "https://evil.example.test" },
    });
    expect(meta.status).toBe(403);
  });

  it("rejects an unknown Host header (DNS rebinding)", async () => {
    const { handle } = await start();
    const url = new URL(handle.url);
    const status = await new Promise<number>((resolve, reject) => {
      const req = httpRequest(
        {
          host: "127.0.0.1",
          port: url.port,
          path: "/mcp",
          method: "POST",
          headers: { host: "evil.example.test" },
        },
        (res) => {
          res.resume();
          resolve(res.statusCode ?? 0);
        },
      );
      req.on("error", reject);
      req.end("{}");
    });
    expect(status).toBe(403);
  });

  it.each(["GET", "DELETE", "PUT"])(
    "answers %s with 405 and Allow: POST, with and without a token",
    async (method) => {
      const { handle, auth } = await start();
      for (const token of [undefined, await auth.sign()]) {
        const response = await fetch(handle.url, {
          method,
          headers: token ? { authorization: `Bearer ${token}` } : {},
        });
        expect(response.status).toBe(405);
        expect(response.headers.get("allow")).toBe("POST");
      }
    },
  );

  it("bounds the body: 413 over the limit, and an oversized unauthenticated body is never read as a request", async () => {
    const { handle, auth, daemon } = await start({ maxBodyBytes: 2048 });
    const token = await auth.sign();
    const big = await fetch(handle.url, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        authorization: `Bearer ${token}`,
        "mcp-protocol-version": "2026-07-28",
      },
      body: JSON.stringify({ pad: "x".repeat(5000) }),
    });
    expect(big.status).toBe(413);
    const anonymous = await fetch(handle.url, { method: "POST", body: "x".repeat(5000) });
    expect(anonymous.status).toBe(401);
    expect(daemon.requests.filter((r) => r.url !== "/v1/automation/status")).toEqual([]);
  });

  it("does not echo the verifier's reason or the token in any error body", async () => {
    const { handle, auth } = await start();
    const token = await auth.sign({}, { key: auth.wrongKey });
    const result = await rpc(handle, "tools/list", {}, token);
    expect(result.text).not.toContain(token);
    expect(result.text.toLowerCase()).not.toContain("signature");
    expect(result.text).not.toContain("JWS");
  });

  it("compares the whole origin: another port or scheme of an allowed host is refused", async () => {
    const { handle, auth } = await start({
      allowedOrigins: ["https://app.example.test", "http://localhost:3000"],
    });
    const token = await auth.sign();
    for (const origin of [
      "https://app.example.test:9999",
      "http://app.example.test",
      "https://app.example.test/",
      "http://localhost:3001",
      "http://localhost",
    ])
      expect((await rpc(handle, "tools/list", {}, token, { origin })).status, origin).toBe(403);
    for (const origin of ["https://app.example.test", "http://localhost:3000"])
      expect((await rpc(handle, "tools/list", {}, token, { origin })).status, origin).toBe(200);
  });

  it("refuses subscriptions/listen without opening a stream or reaching the daemon", async () => {
    const { handle, auth, daemon } = await start();
    const before = daemon.requests.length;
    const result = await rpc(handle, "subscriptions/listen", {}, await auth.sign());
    expect(result.json.error.code).toBe(-32601);
    expect(result.headers.get("content-type")).toContain("application/json");
    expect(daemon.requests.length).toBe(before);
  });

  it("never leaks SDK error text, caller values or zod issues in a JSON-RPC error", async () => {
    const { handle, auth } = await start();
    const token = await auth.sign();
    const bad = await rpc(
      handle,
      "tools/call",
      { name: 42, arguments: "SECRET-CALLER-VALUE" },
      token,
    );
    expect(bad.json.error).toEqual({ code: -32602, message: "MCP request rejected" });
    expect(bad.text).not.toMatch(/SECRET-CALLER-VALUE|expected|invalid_type|zod/i);
    const unknown = await rpc(handle, "no/such/method", { secret: "SECRET-CALLER-VALUE" }, token);
    expect(unknown.json.error.message).toBe("MCP request rejected");
    expect(unknown.text).not.toContain("SECRET-CALLER-VALUE");
    expect(unknown.text).not.toContain("no/such/method");
    const version = await rpc(handle, "tools/list", {}, token, {
      "mcp-protocol-version": "2099-01-01",
    });
    expect(version.text).not.toContain("2099-01-01");
    if (version.json?.error?.code === -32022)
      expect(version.json.error.data).toEqual({ supported: ["2026-07-28"] });
  });

  it("answers 403 insufficient_scope with the needed scope for a key-allowed tool the token does not cover", async () => {
    const { handle, auth, daemon } = await start();
    const before = daemon.requests.length;
    const run = await rpc(
      handle,
      "tools/call",
      { name: "ant0_profile_run", arguments: { id: ID } },
      await auth.sign({ scope: "ant0.read" }),
    );
    expect(run.status).toBe(403);
    const challenge = run.headers.get("www-authenticate")!;
    expect(challenge).toContain('error="insufficient_scope"');
    expect(challenge).toContain('scope="ant0.run"');
    expect(challenge).toContain(`resource_metadata="${METADATA}"`);
    const read = await rpc(
      handle,
      "tools/call",
      { name: "ant0_daemon_status", arguments: {} },
      await auth.sign({ scope: "ant0.run" }),
    );
    expect(read.status).toBe(403);
    expect(read.headers.get("www-authenticate")).toContain('scope="ant0.read"');
    expect(daemon.requests.length).toBe(before);
  });

  it("keeps 200 mcp.forbidden for tools the key itself lacks", async () => {
    const { handle, auth } = await start({}, READ_SCOPES);
    const run = await rpc(
      handle,
      "tools/call",
      { name: "ant0_profile_run", arguments: { id: ID } },
      await auth.sign({ scope: "ant0.read" }),
    );
    expect(run.status).toBe(200);
    expect(run.json.result.structuredContent.error).toBe("mcp.forbidden");
  });

  it("advertises the supported scopes in the 401 challenge", async () => {
    const { handle } = await start();
    for (const token of [undefined, "garbage"]) {
      const result = await rpc(handle, "tools/list", {}, token);
      expect(result.status).toBe(401);
      expect(result.headers.get("www-authenticate")).toContain('scope="ant0.read ant0.run"');
    }
  });

  it("strips the Authorization header before the SDK sees the request", async () => {
    const { handle, auth } = await start();
    seen.headers.length = 0;
    const result = await rpc(handle, "tools/list", {}, await auth.sign());
    expect(result.status).toBe(200);
    expect(seen.headers.length).toBeGreaterThan(0);
    for (const keys of seen.headers) {
      expect(keys).toContain("content-type");
      expect(keys).not.toContain("authorization");
    }
  });

  it("rejects HS256 tokens keyed with the public key or a shared secret, and alg none", async () => {
    const { handle, auth } = await start();
    const claims = () =>
      new SignJWT({ scope: "ant0.read" })
        .setIssuer(ISSUER)
        .setAudience(RESOURCE)
        .setIssuedAt()
        .setExpirationTime("5m");
    const publicJwk = JSON.stringify((await (await fetch(auth.jwksUrl)).json()) as unknown);
    const secrets = [
      new TextEncoder().encode(publicJwk),
      new TextEncoder().encode("shared-secret-0123456789"),
    ];
    for (const secret of secrets)
      for (const kid of [undefined, "k1"]) {
        const token = await claims()
          .setProtectedHeader({ alg: "HS256", ...(kid ? { kid } : {}) })
          .sign(secret);
        const result = await rpc(handle, "tools/list", {}, token);
        expect(result.status).toBe(401);
        expect(result.headers.get("www-authenticate")).toContain("invalid_token");
      }
    const none = (header: object) =>
      `${Buffer.from(JSON.stringify(header)).toString("base64url")}.${Buffer.from(
        JSON.stringify({
          iss: ISSUER,
          aud: RESOURCE,
          scope: "ant0.read",
          exp: Math.floor(Date.now() / 1000) + 300,
        }),
      ).toString("base64url")}.`;
    for (const header of [{ alg: "none" }, { alg: "none", kid: "k1" }, { alg: "None" }])
      expect((await rpc(handle, "tools/list", {}, none(header))).status).toBe(401);
  });
});
