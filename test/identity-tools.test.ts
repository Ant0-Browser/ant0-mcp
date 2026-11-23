import { execFileSync } from "node:child_process";
import {
  chmodSync,
  existsSync,
  linkSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  symlinkSync,
  utimesSync,
  writeFileSync,
} from "node:fs";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { tmpdir } from "node:os";
import { isAbsolute, join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { daemonClient } from "../src/daemon.js";
import {
  cookieExportDir,
  cookieImportDir,
  readImportFile,
  startExportSweeper,
  sweepExports,
  SWEEP_INTERVAL_MS,
  writeCookieExport,
} from "../src/export-files.js";
import { keyScopes, type KeyGrant } from "../src/key-contract.js";
import {
  callTool,
  IDENTITY_TOOLS,
  mapProxyCheckError,
  PROXY_CHECK_ERRORS,
  assertToolAllowed,
  handlerFor,
  TOOLS,
  toolsForCredential,
} from "../src/tools.js";
import { FAILURE_OUTPUT_SCHEMA } from "../src/errors.js";
import { ID } from "./helpers.js";

const SECRET = "SENTINEL_DO_NOT_EXPOSE";
const names = IDENTITY_TOOLS.map((tool) => tool.name);
const grant = (scopes: KeyGrant["scopes"]): KeyGrant => ({ id: ID, credential: "cred", scopes });
const dirs: string[] = [];
const closers: (() => Promise<void>)[] = [];
afterEach(async () => {
  for (const close of closers.splice(0)) await close();
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

interface Seen {
  method: string;
  url: string;
  body: string;
  contentType: string | undefined;
}
async function daemon(respond: (req: IncomingMessage, res: ServerResponse, seen: Seen) => void) {
  const requests: Seen[] = [];
  const server = createServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on("data", (c: Buffer) => chunks.push(c));
    req.on("end", () => {
      const seen = {
        method: req.method!,
        url: req.url!,
        body: Buffer.concat(chunks).toString("utf8"),
        contentType: req.headers["content-type"],
      };
      requests.push(seen);
      respond(req, res, seen);
    });
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  closers.push(async () => {
    server.closeAllConnections();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  });
  const origin = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
  const client = (key = false) =>
    daemonClient(
      { origin, token: "local-token", ...(key ? { apiKey: true as const } : {}) },
      new AbortController().signal,
    );
  return { requests, client };
}
const json = (res: ServerResponse, status: number, body: unknown) => {
  res.writeHead(status, { "content-type": "application/json" });
  res.end(JSON.stringify(body));
};
const run = (
  client: ReturnType<Awaited<ReturnType<typeof daemon>>["client"]>,
  name: string,
  args: unknown,
  extra?: { credential?: KeyGrant; home?: string },
) =>
  callTool(client, name, args, new AbortController().signal, extra?.credential, {
    ...(extra?.home ? { home: extra.home } : {}),
  });
const home = () => {
  const dir = mkdtempSync(join(tmpdir(), "ant0-ident-"));
  dirs.push(dir);
  return dir;
};

describe("local-only exposure", () => {
  it("lists all identity tools for the local bearer and none for any scoped credential", () => {
    expect(names).toHaveLength(11);
    expect(toolsForCredential().map((t) => t.name)).toEqual(TOOLS.map((t) => t.name));
    for (const name of names) expect(toolsForCredential().some((t) => t.name === name)).toBe(true);
    const subsets: (readonly (typeof keyScopes)[number][])[] = [
      keyScopes,
      ...keyScopes.map((scope) => [scope] as const),
      keyScopes.slice(0, 3),
      keyScopes.slice(3),
    ];
    for (const scopes of subsets)
      for (const tool of toolsForCredential(grant(scopes))) expect(names).not.toContain(tool.name);
    expect(toolsForCredential(grant(keyScopes))).toHaveLength(9);
  });

  it("refuses every identity tool for a scoped credential without any daemon request", async () => {
    const d = await daemon((_req, res) => json(res, 200, {}));
    for (const name of names) {
      const result = await run(
        d.client(),
        name,
        { id: ID, name: "x", url: "http://a:1", format: "json", cookies: "x" },
        { credential: grant(keyScopes) },
      );
      expect(result.structuredContent).toMatchObject({ error: "mcp.forbidden" });
    }
    expect(d.requests).toEqual([]);
  });

  it("transport in key mode rejects every new method/path before any network call", async () => {
    const d = await daemon((_req, res) => json(res, 200, {}));
    const c = d.client(true) as any;
    const calls = [
      () => c.POST("/v1/profiles", { body: { name: "x" } }),
      () => c.PATCH("/v1/profiles/{id}", { params: { path: { id: ID } }, body: {} }),
      () => c.POST("/v1/profiles/{id}/duplicate", { params: { path: { id: ID } }, body: {} }),
      () => c.DELETE("/v1/profiles/{id}", { params: { path: { id: ID } } }),
      () => c.POST("/v1/profiles/{id}/restore", { params: { path: { id: ID } }, body: {} }),
      () => c.GET("/v1/profiles/{id}/identity", { params: { path: { id: ID } } }),
      () => c.POST("/v1/proxies", { body: { url: "http://a:1" } }),
      () => c.POST("/v1/proxies/{id}/check", { params: { path: { id: ID } }, body: {} }),
      () => c.POST("/v1/proxies/{id}/change-ip", { params: { path: { id: ID } }, body: {} }),
      () => c.GET("/v1/profiles/{id}/cookies", { params: { path: { id: ID } } }),
      () =>
        c.POST("/v1/profiles/{id}/cookies", { params: { path: { id: ID } }, body: { data: "x" } }),
    ];
    for (const call of calls)
      await expect(call()).rejects.toThrow("invalid local daemon configuration");
    expect(d.requests).toEqual([]);
  });

  it("transport in local mode rejects query strings on delete and unknown cookie queries", async () => {
    const d = await daemon((_req, res) => json(res, 200, []));
    const c = d.client() as any;
    for (const query of [{ permanent: true }, { cloud: "trash" }, { purge: true }])
      await expect(
        c.DELETE("/v1/profiles/{id}", { params: { path: { id: ID }, query } }),
      ).rejects.toThrow("invalid local daemon configuration");
    await expect(
      c.GET("/v1/profiles/{id}/cookies", {
        params: { path: { id: ID }, query: { format: "csv" } },
        parseAs: "text",
      }),
    ).rejects.toThrow("invalid local daemon configuration");
    await expect(
      c.GET("/v1/profiles/{id}/cookies", {
        params: { path: { id: ID }, query: { domain: "a" } },
        parseAs: "text",
      }),
    ).rejects.toThrow("invalid local daemon configuration");
    expect(d.requests).toEqual([]);
  });
});

describe("profile tools", () => {
  const identity = {
    mode: "synthetic",
    persona: {
      compatibility: { os_family: "windows", browser_major: 149 },
      locale: {
        primary_language: "en-US",
        languages: ["en-US", "en"],
        timezone: "America/New_York",
      },
      display: { width: 1920, height: 1080, device_pixel_ratio: 1 },
      graphics: { webgl: { unmasked_vendor: "Google Inc.", unmasked_renderer: "ANGLE X" } },
      fonts: { families: [SECRET] },
    },
    source: null,
    persisted: true,
    warnings: [],
  };

  it("creates with exact body, inline proxy, platform and returns an identity summary", async () => {
    const d = await daemon((req, res) =>
      req.method === "POST"
        ? json(res, 201, { id: ID, name: "P", network: { secret: SECRET } })
        : json(res, 200, identity),
    );
    const result = await run(d.client(), "ant0_profile_create", {
      name: "P",
      platform: "macos",
      proxy: { line: "h:1:u:p" },
      tags: ["a"],
      notes: "n",
      local_folder_id: ID,
    });
    expect(JSON.parse(d.requests[0]!.body)).toEqual({
      name: "P",
      tags: ["a"],
      notes: "n",
      local_folder_id: ID,
      overrides: { platform: "macos" },
      network: { proxy: { line: "h:1:u:p" } },
    });
    expect(d.requests.map((r) => [r.method, r.url])).toEqual([
      ["POST", "/v1/profiles"],
      ["GET", `/v1/profiles/${ID}/identity`],
    ]);
    expect(result.structuredContent).toEqual({
      id: ID,
      name: "P",
      identity: {
        platform: "windows",
        browser_version: "149",
        timezone: "America/New_York",
        locale: "en-US",
        languages: ["en-US", "en"],
        screen: { width: 1920, height: 1080, device_pixel_ratio: 1 },
        gpu: { vendor: "Google Inc.", renderer: "ANGLE X" },
        proxy_country: null,
      },
    });
    expect(JSON.stringify(result)).not.toContain(SECRET);
  });

  it("keeps the created profile when the identity read fails", async () => {
    const d = await daemon((req, res) =>
      req.method === "POST"
        ? json(res, 201, { id: ID, name: "P" })
        : json(res, 500, { error: "internal" }),
    );
    const result = await run(d.client(), "ant0_profile_create", { name: "P" });
    expect(result.structuredContent).toEqual({ id: ID, name: "P", identity: null });
  });

  it("enforces proxy_id/proxy exclusion and update needs a field", async () => {
    const d = await daemon((_req, res) => json(res, 200, {}));
    const bad: [string, unknown][] = [
      ["ant0_profile_create", { name: "P", proxy_id: ID, proxy: { url: "http://a:1" } }],
      ["ant0_profile_update", { id: ID, proxy_id: ID, proxy: { url: "http://a:1" } }],
      ["ant0_profile_update", { id: ID, proxy_id: null, proxy: { url: "http://a:1" } }],
      ["ant0_profile_update", { id: ID }],
      ["ant0_profile_create", { name: "P", proxy: { url: "http://a:1", line: "x" } }],
      ["ant0_proxy_create", { url: "http://a:1", line: "x" }],
      ["ant0_proxy_create", {}],
    ];
    for (const [name, args] of bad)
      expect((await run(d.client(), name, args)).structuredContent).toMatchObject({
        error: "mcp.arguments",
      });
    expect(d.requests).toEqual([]);
  });

  it("updates with a PATCH, null clears the proxy", async () => {
    const d = await daemon((req, res) =>
      req.method === "PATCH" ? json(res, 200, { id: ID, name: "N" }) : json(res, 200, identity),
    );
    await run(d.client(), "ant0_profile_update", {
      id: ID,
      name: "N",
      proxy_id: null,
      local_folder_id: null,
    });
    expect(d.requests[0]).toMatchObject({
      method: "PATCH",
      url: `/v1/profiles/${ID}`,
      contentType: "application/json",
    });
    expect(JSON.parse(d.requests[0]!.body)).toEqual({
      name: "N",
      local_folder_id: null,
      network: { proxy_id: null },
    });
  });

  it("delete sends exactly DELETE with no query and the schema rejects permanent/cloud", async () => {
    const d = await daemon((_req, res) => {
      res.writeHead(204);
      res.end();
    });
    const result = await run(d.client(), "ant0_profile_delete", { id: ID });
    expect(result.structuredContent).toEqual({ id: ID, trashed: true });
    expect(d.requests).toEqual([
      { method: "DELETE", url: `/v1/profiles/${ID}`, body: "", contentType: undefined },
    ]);
    for (const extra of [{ permanent: true }, { cloud: "trash" }, { purge: true }])
      expect(
        (await run(d.client(), "ant0_profile_delete", { id: ID, ...extra })).structuredContent,
      ).toMatchObject({ error: "mcp.arguments" });
    expect(d.requests).toHaveLength(1);
    const schema = IDENTITY_TOOLS.find((t) => t.name === "ant0_profile_delete")!.inputSchema;
    expect(schema.additionalProperties).toBe(false);
    expect(Object.keys(schema.properties!)).toEqual(["id"]);
  });

  it("duplicate and restore send JSON object bodies", async () => {
    const d = await daemon((req, res) =>
      json(res, req.url!.endsWith("duplicate") ? 201 : 200, { id: ID, name: "C", x: SECRET }),
    );
    expect(
      (await run(d.client(), "ant0_profile_duplicate", { id: ID, name: "C" })).structuredContent,
    ).toEqual({ id: ID, name: "C" });
    expect((await run(d.client(), "ant0_profile_restore", { id: ID })).structuredContent).toEqual({
      id: ID,
    });
    expect(d.requests.map((r) => [r.method, r.url, r.body])).toEqual([
      ["POST", `/v1/profiles/${ID}/duplicate`, '{"name":"C"}'],
      ["POST", `/v1/profiles/${ID}/restore`, "{}"],
    ]);
  });

  it("identity returns nulls for a native profile", async () => {
    const d = await daemon((_req, res) =>
      json(res, 200, { ...identity, mode: "native", persona: null }),
    );
    expect((await run(d.client(), "ant0_profile_identity", { id: ID })).structuredContent).toEqual({
      platform: null,
      browser_version: null,
      timezone: null,
      locale: null,
      languages: null,
      screen: null,
      gpu: null,
      proxy_country: null,
    });
  });

  it.each([
    [
      { error: "validation_failed", message: SECRET, details: SECRET },
      400,
      "mcp.invalid_request",
      "The daemon rejected the input.",
    ],
    [
      { error: "profile.running", message: SECRET },
      409,
      "mcp.profile_running",
      "Stop the profile first.",
    ],
    [
      { error: "profile.synced", message: SECRET },
      409,
      "mcp.profile_synced",
      "This profile syncs with the cloud; remove it in the Ant0 app.",
    ],
    [
      { error: "sync.conflict", message: SECRET },
      409,
      "mcp.conflict",
      "The daemon reported a conflict; check the profile and retry.",
    ],
    [{ error: "sync.locked", message: SECRET }, 423, "mcp.upstream", "local daemon request failed"],
    ["not json", 409, "mcp.upstream", "local daemon request failed"],
    [{ error: "profile_not_found", message: SECRET }, 404, "mcp.not_found", "item not found"],
  ])(
    "maps daemon error %j (%i) to %s without leaking fields",
    async (body, status, error, message) => {
      const d = await daemon((_req, res) => {
        res.writeHead(status, { "content-type": "application/json" });
        res.end(typeof body === "string" ? body : JSON.stringify(body));
      });
      const result = await run(d.client(), "ant0_profile_update", { id: ID, name: "N" });
      expect(result.isError).toBe(true);
      expect(result.structuredContent).toEqual({ error, message });
      expect(JSON.stringify(result)).not.toContain(SECRET);
    },
  );

  it("advertises the new failure codes in the output schemas", () => {
    const codes = JSON.stringify(FAILURE_OUTPUT_SCHEMA);
    for (const code of ["invalid_request", "profile_running", "profile_synced", "conflict"])
      expect(codes).toContain(`mcp.${code}`);
  });

  it("marks delete and import destructive and identity/check idempotent", () => {
    const hint = (name: string) => IDENTITY_TOOLS.find((t) => t.name === name)!.annotations!;
    expect(hint("ant0_profile_delete")).toMatchObject({
      destructiveHint: true,
      readOnlyHint: false,
    });
    expect(hint("ant0_cookies_import").destructiveHint).toBe(true);
    expect(hint("ant0_profile_identity").idempotentHint).toBe(true);
    expect(hint("ant0_proxy_check").idempotentHint).toBe(true);
    expect(hint("ant0_profile_create").idempotentHint).toBe(false);
    expect(hint("ant0_proxy_change_ip").idempotentHint).toBe(false);
  });
});

describe("proxy tools never return credentials", () => {
  const proxyBody = {
    id: ID,
    name: "h:1",
    type: "http",
    host: "h",
    port: 1,
    username: SECRET,
    password: SECRET,
    password_ref: SECRET,
    change_ip_url: `http://${SECRET}`,
    url: `http://${SECRET}:${SECRET}@h:1`,
  };
  it("create from a URL returns id, type, host and port without userinfo or name", async () => {
    const d = await daemon((_req, res) => json(res, 201, proxyBody));
    const result = await run(d.client(), "ant0_proxy_create", { url: `http://u:${SECRET}@h:1` });
    expect(result.structuredContent).toEqual({ id: ID, type: "http", host: "h", port: 1 });
    expect(JSON.stringify(result)).not.toContain(SECRET);
    expect(JSON.parse(d.requests[0]!.body)).toEqual({ url: `http://u:${SECRET}@h:1` });
  });
  it("create with a provider line echoes nothing derived from the line", async () => {
    const line = "user:48213:host:8080";
    const d = await daemon((_req, res) =>
      json(res, 201, { ...proxyBody, name: "user:48213", host: "user", port: 48213 }),
    );
    const result = await run(d.client(), "ant0_proxy_create", { line });
    expect(JSON.parse(d.requests[0]!.body)).toEqual({ line });
    expect(result.structuredContent).toEqual({ id: ID, type: "http" });
    for (const part of ["user", "48213", "host", "8080", SECRET])
      expect(JSON.stringify(result)).not.toContain(part);
  });
  it("check maps the result and drops everything else", async () => {
    const d = await daemon((_req, res) =>
      json(res, 200, {
        at: "x",
        ok: true,
        ip: "1.2.3.4",
        country: "DE",
        timezone: "Europe/Berlin",
        latency_ms: 12,
        error: null,
        udp: { ok: SECRET },
        password: SECRET,
      }),
    );
    const result = await run(d.client(), "ant0_proxy_check", { id: ID });
    expect(result.structuredContent).toEqual({
      ok: true,
      ip: "1.2.3.4",
      country: "DE",
      timezone: "Europe/Berlin",
      latency_ms: 12,
    });
    expect(JSON.stringify(result)).not.toContain(SECRET);
    expect(d.requests[0]).toMatchObject({ method: "POST", url: `/v1/proxies/${ID}/check` });
  });
  it("check reports a failed probe", async () => {
    const d = await daemon((_req, res) =>
      json(res, 200, {
        ok: false,
        ip: null,
        country: null,
        timezone: null,
        latency_ms: null,
        error: `cannot connect to proxy ${SECRET}`,
      }),
    );
    const result = await run(d.client(), "ant0_proxy_check", { id: ID });
    expect(result.structuredContent).toEqual({
      ok: false,
      ip: null,
      country: null,
      timezone: null,
      latency_ms: null,
      error: "unreachable",
    });
    expect(JSON.stringify(result)).not.toContain(SECRET);
  });
  it.each([
    ["cannot connect to proxy", "unreachable"],
    ["proxy exit IP lookup failed", "lookup_failed"],
    ["no response through the proxy (exit IP lookup failed)", "lookup_failed"],
    ["upstream SOCKS5 proxy rejected the credentials", "auth_failed"],
    ["upstream SOCKS4 proxy rejected the user ID", "auth_failed"],
    [
      "the SOCKS4 proxy refused the connection (it may not support SOCKS4a host names)",
      "protocol_error",
    ],
    ["connect ETIMEDOUT 1.2.3.4:80", "timeout"],
    ["getaddrinfo ENOTFOUND secret.example", "dns_failed"],
    ["certificate has expired", "tls_failed"],
    ["connect ECONNREFUSED 1.2.3.4:80", "refused"],
    ["proxy relay failed", "other"],
    ["something entirely new with password hunter2", "other"],
  ])("check maps %j to %s", (text, code) => {
    expect(mapProxyCheckError(text)).toBe(code);
    expect(PROXY_CHECK_ERRORS).toContain(code);
  });
  it("change-ip returns the provider status only", async () => {
    const d = await daemon((_req, res) =>
      json(res, 200, { status: 200, body: SECRET, change_ip_url: SECRET }),
    );
    const result = await run(d.client(), "ant0_proxy_change_ip", { id: ID });
    expect(result.structuredContent).toEqual({ status: 200, ok: true });
    expect(JSON.stringify(result)).not.toContain(SECRET);
  });
});

describe("cookies", () => {
  const cookies = [
    { name: "a", value: SECRET, domain: ".example.com" },
    { name: "b", value: SECRET, domain: "www.example.com" },
    { name: "c", value: SECRET, domain: "other.org" },
    { name: "d", value: SECRET, domain: "notexample.com" },
  ];
  const netscape = `# Netscape HTTP Cookie File\n.example.com\tTRUE\t/\tFALSE\t0\ta\t${SECRET}\nother.org\tFALSE\t/\tFALSE\t0\tc\t${SECRET}\n`;

  it("exports json to a private absolute file and returns count and path only", async () => {
    const h = home();
    const d = await daemon((_req, res) => json(res, 200, cookies));
    const before = Date.now();
    const result = await run(
      d.client(),
      "ant0_cookies_export",
      { id: ID, format: "json", domain: "example.com" },
      { home: h },
    );
    const data = result.structuredContent as {
      count: number;
      path: string;
      expires_after_hours: number;
      deletes_at: string;
    };
    expect(d.requests[0]).toMatchObject({
      method: "GET",
      url: `/v1/profiles/${ID}/cookies?format=json`,
    });
    expect(data.count).toBe(2);
    expect(data.expires_after_hours).toBe(24);
    expect(isAbsolute(data.path)).toBe(true);
    expect(data.path.startsWith(join(h, "exports", "cookies"))).toBe(true);
    expect(data.path).toMatch(new RegExp(`${ID}-\\d{8}T\\d{6}Z-[0-9a-f]{4}\\.json$`));
    expect(Math.abs(Date.parse(data.deletes_at) - (before + 24 * 3_600_000))).toBeLessThan(60_000);
    // Structured and text output both state the auto-delete and the full path; no values.
    const text = (result.content[0] as { text: string }).text;
    expect(text).toContain(data.path);
    expect(text).toContain("deleted automatically after 24 hours");
    expect(text).toContain(data.deletes_at);
    expect(JSON.stringify(result)).not.toContain(SECRET);
    expect(Object.keys(data).sort()).toEqual([
      "count",
      "deletes_at",
      "expires_after_hours",
      "path",
    ]);
    expect(IDENTITY_TOOLS.find((t) => t.name === "ant0_cookies_export")!.description).toContain(
      "24 hours",
    );
    expect(JSON.parse(readFileSync(data.path, "utf8")).map((c: any) => c.name)).toEqual(["a", "b"]);
    if (process.platform !== "win32") {
      expect(lstatSync(data.path).mode & 0o777).toBe(0o600);
      expect(lstatSync(cookieExportDir(h)).mode & 0o777).toBe(0o700);
    }
  });

  it("exports netscape text with a domain filter", async () => {
    const h = home();
    const d = await daemon((_req, res) => {
      res.writeHead(200, { "content-type": "text/plain" });
      res.end(netscape);
    });
    const result = await run(
      d.client(),
      "ant0_cookies_export",
      { id: ID, format: "netscape", domain: "example.com" },
      { home: h },
    );
    const data = result.structuredContent as { count: number; path: string };
    expect(d.requests[0]!.url).toBe(`/v1/profiles/${ID}/cookies?format=netscape`);
    expect(data.count).toBe(1);
    expect(data.path.endsWith(".txt")).toBe(true);
    const file = readFileSync(data.path, "utf8");
    expect(file).toContain(".example.com");
    expect(file).not.toContain("other.org");
    expect(JSON.stringify(result)).not.toContain(SECRET);
  });

  it("failed exports carry no cookie data", async () => {
    const h = home();
    const d = await daemon((_req, res) =>
      json(res, 409, { error: "profile.not_running", message: SECRET }),
    );
    const result = await run(
      d.client(),
      "ant0_cookies_export",
      { id: ID, format: "json" },
      { home: h },
    );
    expect(result.structuredContent).toMatchObject({ error: "mcp.conflict" });
    expect(existsSync(join(h, "exports"))).toBe(false);
  });

  it("rejects a path input for export and requires a data directory", async () => {
    const d = await daemon((_req, res) => json(res, 200, []));
    expect(
      (
        await run(
          d.client(),
          "ant0_cookies_export",
          { id: ID, format: "json", path: "/tmp/x" },
          { home: home() },
        )
      ).structuredContent,
    ).toMatchObject({ error: "mcp.arguments" });
    expect(d.requests).toEqual([]);
  });

  it("imports an array, text and a file; exactly one source", async () => {
    const d = await daemon((_req, res) =>
      json(res, 200, { imported: 2, applied: "next_start", extra: SECRET }),
    );
    const r1 = await run(d.client(), "ant0_cookies_import", {
      id: ID,
      cookies: [{ name: "a", value: "v", domain: "x.com" }],
    });
    expect(r1.structuredContent).toEqual({ imported: 2, applied: "next_start" });
    expect(JSON.parse(d.requests[0]!.body)).toEqual({
      format: "json",
      data: '[{"name":"a","value":"v","domain":"x.com"}]',
    });
    await run(d.client(), "ant0_cookies_import", { id: ID, cookies: netscape });
    expect(JSON.parse(d.requests[1]!.body)).toEqual({ format: "auto", data: netscape });
    const h = home();
    const importDir = cookieImportDir(h);
    mkdirSync(importDir, { recursive: true });
    const file = join(importDir, "c.txt");
    writeFileSync(file, netscape);
    await run(d.client(), "ant0_cookies_import", { id: ID, path: file }, { home: h });
    expect(JSON.parse(d.requests[2]!.body).data).toBe(netscape);
    for (const args of [{ id: ID }, { id: ID, cookies: netscape, path: file }]) {
      expect(
        (await run(d.client(), "ant0_cookies_import", args, { home: h })).structuredContent,
      ).toMatchObject({ error: "mcp.arguments" });
    }
    expect(d.requests).toHaveLength(3);
  });
});

describe("export files", () => {
  it("sweeps only our own old regular files and never follows symlinks", () => {
    const h = home();
    const dir = cookieExportDir(h);
    const first = writeCookieExport(h, ID, "json", "[]", new Date("2026-11-01T00:00:00Z"));
    const other = join(dir, "keep-me.txt");
    writeFileSync(other, "x");
    const outside = join(h, "outside.json");
    writeFileSync(outside, "x");
    const oldLink = join(dir, `${ID}-20260101T000000Z-abcd.json`);
    symlinkSync(outside, oldLink);
    const old = new Date("2026-11-01T00:00:00Z");
    for (const p of [first, other, outside]) utimesSync(p, old, old);
    const second = writeCookieExport(h, ID, "txt", "x", new Date("2026-11-08T00:00:00Z"));
    expect(existsSync(first)).toBe(false);
    expect(existsSync(second)).toBe(true);
    expect(existsSync(other)).toBe(true);
    expect(existsSync(outside)).toBe(true);
    expect(lstatSync(oldLink).isSymbolicLink()).toBe(true);
    expect(readdirSync(dir).some((n) => n.endsWith(".tmp"))).toBe(false);
    sweepExports(join(h, "missing"));
    mkdirSync(join(h, "x"));
  });
});

describe("local-only layers, each proven on its own", () => {
  const anyArgs = { id: ID, name: "x", url: "http://a:1", format: "json", cookies: "x" };
  const signal = () => new AbortController().signal;

  it.each(names)(
    "%s: the handler itself refuses a credential (dispatch bypassed)",
    async (name) => {
      const d = await daemon((_req, res) => json(res, 200, {}));
      const handler = handlerFor(name);
      expect(handler).toBeDefined();
      await expect(
        handler!(d.client(), anyArgs, signal(), grant(keyScopes), { home: home() }),
      ).rejects.toMatchObject({ code: "forbidden" });
      expect(d.requests).toEqual([]);
    },
  );

  it.each(names)("%s: the dispatch check refuses every credential", (name) => {
    const subsets = [keyScopes, ...keyScopes.map((scope) => [scope] as const), []];
    for (const scopes of subsets)
      expect(() => assertToolAllowed(name, grant(scopes))).toThrowError(
        expect.objectContaining({ code: "forbidden" }),
      );
    expect(() => assertToolAllowed(name)).not.toThrow();
  });

  it("callTool refuses a credential even where the daemon would answer successfully", async () => {
    const d = await daemon((_req, res) => json(res, 200, { status: 204, id: ID }));
    for (const name of names) {
      const result = await run(d.client(), name, { id: ID }, { credential: grant(keyScopes) });
      expect(result.structuredContent).toMatchObject({ error: "mcp.forbidden" });
    }
    expect(d.requests).toEqual([]);
    // The same stub does answer the local bearer, so the refusal above is the guard's doing.
    const ok = await run(d.client(), "ant0_proxy_change_ip", { id: ID });
    expect(ok.structuredContent).toEqual({ status: 204, ok: true });
    expect(d.requests).toHaveLength(1);
  });

  it("callTool's dispatch check alone stops a tool outside the credential's scopes", async () => {
    // ant0_profile_run has no handler-level guard, so only the dispatch call can refuse it.
    const d = await daemon((_req, res) => json(res, 200, {}));
    const result = await run(
      d.client(),
      "ant0_profile_run",
      { id: ID },
      { credential: grant(["profiles:read"]) },
    );
    expect(result.structuredContent).toMatchObject({ error: "mcp.forbidden" });
    expect(d.requests).toEqual([]);
  });

  it("handlerFor knows only real tools", () => {
    expect(handlerFor("nope")).toBeUndefined();
  });
});

describe("cookie import directory", () => {
  const importOk = (h: string, args: Record<string, unknown>) =>
    daemon((_req, res) => json(res, 200, { imported: 1, applied: "next_start" })).then(
      async (d) => ({
        d,
        result: await run(d.client(), "ant0_cookies_import", { id: ID, ...args }, { home: h }),
      }),
    );
  const failureOf = (r: { structuredContent?: unknown }) => JSON.stringify(r.structuredContent);

  it("reads a good file inside the directory and creates it 0700", async () => {
    const h = home();
    const dir = cookieImportDir(h);
    const d = await daemon((_req, res) => json(res, 200, { imported: 1, applied: "next_start" }));
    // First use creates the directory.
    await run(
      d.client(),
      "ant0_cookies_import",
      { id: ID, path: join(dir, "none.txt") },
      { home: h },
    );
    expect(lstatSync(dir).mode & 0o777).toBe(0o700);
    writeFileSync(join(dir, "ok.txt"), "# Netscape\n");
    const result = await run(
      d.client(),
      "ant0_cookies_import",
      { id: ID, path: join(dir, "ok.txt") },
      { home: h },
    );
    expect(result.structuredContent).toEqual({ imported: 1, applied: "next_start" });
  });

  it("gives one identical failure for every way a path can be refused", async () => {
    const h = home();
    const dir = cookieImportDir(h);
    mkdirSync(dir, { recursive: true });
    const outside = join(h, "outside.txt");
    writeFileSync(outside, "secret");
    symlinkSync(outside, join(dir, "link.txt"));
    symlinkSync("/etc/passwd", join(dir, "passwd-link"));
    mkdirSync(join(dir, "sub"));
    writeFileSync(join(dir, "big.txt"), "x".repeat(1024 * 1024 + 1));
    const paths = [
      "/etc/passwd",
      "/proc/self/environ",
      join(dir, "..", "..", "outside.txt"),
      join(dir, "..", "outside.txt"),
      outside,
      join(dir, "link.txt"),
      join(dir, "passwd-link"),
      join(dir, "missing.txt"),
      join(dir, "sub"),
      dir,
      join(dir, "big.txt"),
      "relative.txt",
      join(dir, "x\0y"),
    ];
    const seen = new Set<string>();
    const d = await daemon((_req, res) => json(res, 200, {}));
    for (const path of paths) {
      const r = await run(d.client(), "ant0_cookies_import", { id: ID, path }, { home: h });
      expect(r.isError).toBe(true);
      seen.add(failureOf(r));
    }
    expect(seen.size).toBe(1);
    expect([...seen][0]).toContain("mcp.arguments");
    expect(d.requests).toEqual([]);
    expect(JSON.stringify([...seen])).not.toContain("secret");
  });

  it("works through the tool with a file inside the directory", async () => {
    const h = home();
    mkdirSync(cookieImportDir(h), { recursive: true });
    const file = join(cookieImportDir(h), "a.txt");
    writeFileSync(file, "hello");
    const { d, result } = await importOk(h, { path: file });
    expect(result.structuredContent).toEqual({ imported: 1, applied: "next_start" });
    expect(JSON.parse(d.requests[0]!.body).data).toBe("hello");
  });

  it("rejects a file swapped for another inode between lstat and open", () => {
    const h = home();
    const dir = cookieImportDir(h);
    mkdirSync(dir, { recursive: true });
    const file = join(dir, "a.txt");
    writeFileSync(file, "one");
    expect(() =>
      readImportFile(h, file, {
        afterLstat: (p) => {
          linkSync(p, `${p}.keep`); // keeps the old inode allocated so the new file gets another
          rmSync(p);
          writeFileSync(p, "two");
        },
      }),
    ).toThrow("invalid tool arguments");
  });

  it("rejects a final-component symlink swapped in after lstat (O_NOFOLLOW)", () => {
    const h = home();
    const dir = cookieImportDir(h);
    mkdirSync(dir, { recursive: true });
    const file = join(dir, "a.txt");
    writeFileSync(file, "one");
    const twin = join(dir, "twin.txt");
    linkSync(file, twin); // same inode, so only O_NOFOLLOW can refuse the symlink
    expect(() =>
      readImportFile(h, file, {
        afterLstat: (p) => {
          rmSync(p);
          symlinkSync(twin, p);
        },
      }),
    ).toThrow("invalid tool arguments");
  });

  it.skipIf(process.platform === "win32")(
    "returns promptly when the file is swapped for a FIFO",
    () => {
      const h = home();
      const dir = cookieImportDir(h);
      mkdirSync(dir, { recursive: true });
      const file = join(dir, "a.txt");
      writeFileSync(file, "one");
      const started = Date.now();
      expect(() =>
        readImportFile(h, file, {
          afterLstat: (p) => {
            rmSync(p);
            execFileSync("mkfifo", [p]);
          },
        }),
      ).toThrow("invalid tool arguments");
      expect(Date.now() - started).toBeLessThan(2000);
      // A FIFO that is there from the start is refused as well.
      const fifo = join(dir, "pipe");
      execFileSync("mkfifo", [fifo]);
      expect(() => readImportFile(h, fifo)).toThrow("invalid tool arguments");
    },
  );
});

describe("export file safety", () => {
  const at = new Date("2026-11-08T00:00:00Z");

  it("never overwrites a pre-existing temp path (wx)", () => {
    const h = home();
    const dir = cookieExportDir(h);
    mkdirSync(dir, { recursive: true, mode: 0o700 });
    const final = join(dir, `${ID}-20261108T000000Z-abcd.json`);
    writeFileSync(`${final}.tmp`, "PLANTED");
    expect(() => writeCookieExport(h, ID, "json", "[]", at, { suffix: "abcd" })).toThrow();
    expect(readFileSync(`${final}.tmp`, "utf8")).toBe("PLANTED");
    expect(existsSync(final)).toBe(false);
  });

  it("writes a complete temp file and renames it; the final name never holds partial data", () => {
    const h = home();
    let seenTemp = "";
    let finalExistedBeforeRename = true;
    let tempBytes = "";
    const final = writeCookieExport(h, ID, "json", '[{"a":1}]', at, {
      suffix: "abcd",
      beforeRename: (temp) => {
        seenTemp = temp;
        finalExistedBeforeRename = existsSync(temp.replace(/\.tmp$/, ""));
        tempBytes = readFileSync(temp, "utf8");
      },
    });
    expect(seenTemp).toBe(`${final}.tmp`);
    expect(seenTemp).toMatch(/[0-9a-f-]{36}-\d{8}T\d{6}Z-[0-9a-f]{4}\.json\.tmp$/);
    expect(finalExistedBeforeRename).toBe(false);
    expect(tempBytes).toBe('[{"a":1}]');
    expect(existsSync(seenTemp)).toBe(false);
    expect(readFileSync(final, "utf8")).toBe('[{"a":1}]');
    expect(lstatSync(final).mode & 0o777).toBe(0o600);
  });

  it("fixes a pre-existing 0755 leaf directory to 0700", () => {
    const h = home();
    const dir = cookieExportDir(h);
    mkdirSync(dir, { recursive: true });
    chmodSync(dir, 0o755);
    writeCookieExport(h, ID, "json", "[]", at);
    expect(lstatSync(dir).mode & 0o777).toBe(0o700);
  });
});

describe("export retention", () => {
  it("removes a stale export when the sweeper starts", () => {
    const h = home();
    const stale = writeCookieExport(h, ID, "json", "[]", new Date("2026-01-01T00:00:00Z"));
    const old = new Date("2026-01-01T00:00:00Z");
    utimesSync(stale, old, old);
    const stop = startExportSweeper(h);
    stop();
    expect(existsSync(stale)).toBe(false);
  });

  it("sweeps hourly on an unref'd timer and clears it on stop", () => {
    vi.useFakeTimers();
    try {
      const unref = vi.fn();
      const clear = vi.spyOn(globalThis, "clearInterval");
      const realSet = globalThis.setInterval;
      const set = vi.spyOn(globalThis, "setInterval").mockImplementation(((
        fn: () => void,
        ms: number,
      ) => {
        const timer = realSet(fn, ms);
        const original = timer.unref.bind(timer);
        timer.unref = () => {
          unref();
          return original();
        };
        return timer;
      }) as typeof setInterval);
      const h = home();
      const stop = startExportSweeper(h);
      expect(set).toHaveBeenCalledWith(expect.any(Function), SWEEP_INTERVAL_MS);
      expect(SWEEP_INTERVAL_MS).toBe(3_600_000);
      expect(unref).toHaveBeenCalledTimes(1);
      // A file that goes stale later is removed by the periodic sweep.
      const file = writeCookieExport(h, ID, "json", "[]", new Date());
      expect(existsSync(file)).toBe(true);
      vi.setSystemTime(Date.now() + 25 * 3_600_000);
      vi.advanceTimersByTime(SWEEP_INTERVAL_MS);
      expect(existsSync(file)).toBe(false);
      stop();
      expect(clear).toHaveBeenCalledTimes(1);
      set.mockRestore();
      clear.mockRestore();
    } finally {
      vi.useRealTimers();
    }
  });
});
