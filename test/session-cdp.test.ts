import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { afterEach, describe, expect, it, vi } from "vitest";
import { daemonClient } from "../src/daemon.js";
import { FAILURE_OUTPUT_SCHEMA } from "../src/errors.js";
import { keyScopes, type KeyGrant } from "../src/key-contract.js";
import { LOCAL_ROUTES, matchLocalRoute } from "../src/local-routes.js";
import {
  assertToolAllowed,
  callTool,
  handlerFor,
  SESSION_CDP_TOOLS,
  TOOLS,
  toolsForCredential,
} from "../src/tools.js";
import { ID } from "./helpers.js";

const NAME = "ant0_session_cdp";
const WS = "ws://127.0.0.1:9333/devtools/browser/abc-SECRET-PATH";
const HTTP = "http://127.0.0.1:9333";
const grant = (scopes: KeyGrant["scopes"]): KeyGrant => ({ id: ID, credential: "cred", scopes });
const closers: (() => Promise<void>)[] = [];
afterEach(async () => {
  vi.restoreAllMocks();
  for (const close of closers.splice(0)) await close();
});

async function daemon(respond: (req: IncomingMessage, res: ServerResponse) => void) {
  const requests: { method: string; url: string }[] = [];
  const server = createServer((req, res) => {
    requests.push({ method: req.method!, url: req.url! });
    respond(req, res);
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  closers.push(async () => {
    server.closeAllConnections();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  });
  const origin = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
  return {
    requests,
    client: (key = false) =>
      daemonClient(
        { origin, token: "local-token", ...(key ? { apiKey: true as const } : {}) },
        new AbortController().signal,
      ),
  };
}
const json = (res: ServerResponse, status: number, body: unknown) => {
  res.writeHead(status, { "content-type": "application/json" });
  res.end(JSON.stringify(body));
};
const running = {
  state: "running",
  session: {
    profile_id: ID,
    pid: 1234,
    ws_endpoint: WS,
    debug_port: 9333,
    cdp_http: HTTP,
    browser_version: "158.0.1",
    user_agent: "UA",
    headless: false,
    started_at: "2026-11-08T00:00:00.000Z",
  },
};
const run = (
  client: ReturnType<Awaited<ReturnType<typeof daemon>>["client"]>,
  args: unknown = { profile_id: ID },
  credential?: KeyGrant,
  signal = new AbortController().signal,
) => callTool(client, NAME, args, signal, credential, {});

describe("ant0_session_cdp", () => {
  it("returns exactly the endpoint fields of a running profile via GET status", async () => {
    const d = await daemon((_req, res) => json(res, 200, running));
    const result = await run(d.client());
    expect(result.isError).toBeUndefined();
    expect(result.structuredContent).toEqual({
      profile_id: ID,
      ws_endpoint: WS,
      cdp_http: HTTP,
      debug_port: 9333,
    });
    expect(d.requests).toEqual([{ method: "GET", url: `/v1/profiles/${ID}/status` }]);
  });

  it("output validates against the advertised output schema's success branch", () => {
    const tool = SESSION_CDP_TOOLS[0]!;
    expect(TOOLS).toContain(tool);
    expect(tool.annotations).toMatchObject({ readOnlyHint: true, destructiveHint: false });
    const branches = (tool.outputSchema as { anyOf: any[] }).anyOf;
    expect(branches[0]).toEqual(FAILURE_OUTPUT_SCHEMA);
    expect(branches[1].additionalProperties).toBe(false);
    expect(branches[1].required.sort()).toEqual(
      ["cdp_http", "debug_port", "profile_id", "ws_endpoint"].sort(),
    );
    expect(JSON.stringify(FAILURE_OUTPUT_SCHEMA)).toContain("mcp.not_running");
    expect(tool.description).toContain(
      "Returns the local CDP endpoint of a running profile so you can attach your own automation. Access requires owner, manager or operator membership of the profile's team folder.",
    );
    expect(tool.description).toContain("can be detectable");
    expect(tool.description).not.toMatch(/undetectable/i);
  });

  it("reports a fixed not_running failure, never nulls", async () => {
    for (const body of [
      { state: "stopped", session: null },
      { state: "starting", session: null },
      { state: "stopping", session: running.session },
    ]) {
      const d = await daemon((_req, res) => json(res, 200, body));
      const result = await run(d.client());
      expect(result.isError).toBe(true);
      expect(result.structuredContent).toEqual({
        error: "mcp.not_running",
        message: "The profile is not running; start it with ant0_profile_run first.",
      });
    }
  });

  it.each([
    [403, { error: "team.forbidden", message: "SECRET_DETAIL" }, "mcp.forbidden"],
    [503, { error: "sync.offline", message: "SECRET_DETAIL" }, "mcp.unavailable"],
    [409, { error: "profile.busy", message: "SECRET_DETAIL" }, "mcp.conflict"],
    [404, { error: "not_found" }, "mcp.not_found"],
  ])("maps daemon %s to a fixed code", async (status, body, code) => {
    const d = await daemon((_req, res) => json(res, status, body));
    const result = await run(d.client());
    expect(result.isError).toBe(true);
    expect(result.structuredContent).toMatchObject({ error: code });
    expect(JSON.stringify(result)).not.toContain("SECRET_DETAIL");
    expect(JSON.stringify(result)).not.toContain("127.0.0.1");
  });

  it("rejects non-loopback or malformed endpoints from the daemon", async () => {
    for (const session of [
      { ...running.session, ws_endpoint: "ws://evil.example:9333/x" },
      { ...running.session, cdp_http: "http://10.0.0.5:9333" },
      { ...running.session, ws_endpoint: "http://127.0.0.1:9333/x" },
      { ...running.session, debug_port: 0 },
      { ...running.session, ws_endpoint: 5 },
    ]) {
      const d = await daemon((_req, res) => json(res, 200, { state: "running", session }));
      expect((await run(d.client())).structuredContent).toEqual({
        error: "mcp.response",
        message: "invalid local daemon response",
      });
    }
  });

  it("takes only a UUID profile_id", async () => {
    const d = await daemon((_req, res) => json(res, 200, running));
    for (const args of [
      {},
      { profile_id: "My Profile" },
      { profile_id: "../x" },
      { id: ID },
      { profile_id: ID, extra: 1 },
      { profile_id: ID.toUpperCase() },
    ])
      expect((await run(d.client(), args)).structuredContent).toMatchObject({
        error: "mcp.arguments",
      });
    expect(d.requests).toEqual([]);
  });

  it("a cancelled call reports cancelled, not indeterminate", async () => {
    const d = await daemon((_req, res) => json(res, 200, running));
    const abort = new AbortController();
    abort.abort();
    const result = await run(d.client(), { profile_id: ID }, undefined, abort.signal);
    expect(result.structuredContent).toMatchObject({ error: "mcp.cancelled" });
  });

  it("never writes the endpoint to console or stderr/stdout", async () => {
    const spies = [
      vi.spyOn(console, "log"),
      vi.spyOn(console, "error"),
      vi.spyOn(console, "warn"),
      vi.spyOn(process.stderr, "write"),
    ];
    const d = await daemon((_req, res) => json(res, 200, running));
    await run(d.client());
    const failing = await daemon((_req, res) => json(res, 503, { error: "x", message: WS }));
    await run(failing.client());
    for (const spy of spies) expect(JSON.stringify(spy.mock.calls)).not.toContain("SECRET-PATH");
  });
});

describe("ant0_session_cdp is local only, in three independent layers", () => {
  it("layer 1: scope is local, so no credential lists it or passes the dispatch check", () => {
    expect(toolsForCredential().map((t) => t.name)).toContain(NAME);
    const subsets = [keyScopes, ...keyScopes.map((s) => [s] as const), []];
    for (const scopes of subsets) {
      expect(toolsForCredential(grant(scopes)).map((t) => t.name)).not.toContain(NAME);
      expect(() => assertToolAllowed(NAME, grant(scopes))).toThrowError(
        expect.objectContaining({ code: "forbidden" }),
      );
    }
    expect(() => assertToolAllowed(NAME)).not.toThrow();
  });

  it("layer 2: the handler's own localOnly refuses without dispatch and without a request", async () => {
    const d = await daemon((_req, res) => json(res, 200, running));
    const handler = handlerFor(NAME)!;
    await expect(
      handler(d.client(), { profile_id: ID }, new AbortController().signal, grant(keyScopes)),
    ).rejects.toMatchObject({ code: "forbidden" });
    expect(d.requests).toEqual([]);
    // callTool also refuses, and the same stub does answer the local bearer.
    expect((await run(d.client(), { profile_id: ID }, grant(keyScopes))).structuredContent).toEqual(
      expect.objectContaining({ error: "mcp.forbidden" }),
    );
    expect(d.requests).toEqual([]);
    expect((await run(d.client())).isError).toBeUndefined();
  });

  it("layer 3: the key-mode transport rejects the status route before any network call", async () => {
    const d = await daemon((_req, res) => json(res, 200, running));
    const c = d.client(true) as any;
    await expect(
      c.GET("/v1/profiles/{id}/status", { params: { path: { id: ID } } }),
    ).rejects.toThrow("invalid local daemon configuration");
    expect(d.requests).toEqual([]);
  });
});

describe("local route table entry for status", () => {
  const route = LOCAL_ROUTES.filter((r) => r.path.test(`/v1/profiles/${ID}/status`));

  it("is one exact GET entry with no query allowance and no body", () => {
    expect(route).toHaveLength(1);
    expect(route[0]).toMatchObject({ method: "GET", status: 200, body: false });
    expect(route[0]!.query).toBeUndefined();
    expect(matchLocalRoute("GET", `/v1/profiles/${ID}/status`)).toBe(route[0]);
  });

  it("matches nothing but a lowercase UUID path", () => {
    for (const path of [
      `/v1/profiles/${ID}/status/`,
      `/v1/profiles/${ID}/status/x`,
      `/v1/profiles/${ID}/../status`,
      `/v1/profiles/..%2f${ID}/status`,
      `/v1/profiles/name/status`,
      `/v1/profiles/${ID.toUpperCase()}/status`,
      `/x/v1/profiles/${ID}/status`,
    ])
      expect(matchLocalRoute("GET", path)).toBeUndefined();
    for (const method of ["POST", "PATCH", "DELETE"])
      expect(matchLocalRoute(method, `/v1/profiles/${ID}/status`)).toBeUndefined();
  });

  it("the transport refuses any query string on it", async () => {
    const d = await daemon((_req, res) => json(res, 200, running));
    const c = d.client() as any;
    await expect(
      c.GET("/v1/profiles/{id}/status", {
        params: { path: { id: ID }, query: { debug: "1" } },
      }),
    ).rejects.toThrow("invalid local daemon configuration");
    expect(d.requests).toEqual([]);
  });
});
