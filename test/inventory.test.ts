import { afterEach, describe, expect, it } from "vitest";
import { createAnt0Client } from "../src/api/index.js";
import { callTool } from "../src/tools.js";
import {
  ID,
  DATE,
  SECRET,
  inventoryProfile,
  mockDaemon,
  profile,
  proxy,
  sdkClient,
} from "./helpers.js";

const cleanups: (() => Promise<void>)[] = [];
afterEach(async () => {
  for (const close of cleanups.splice(0).reverse()) await close();
});
async function setup(handler?: Parameters<typeof mockDaemon>[0]) {
  const daemon = await mockDaemon(handler);
  cleanups.push(daemon.close);
  const sdk = await sdkClient(daemon.home);
  cleanups.push(sdk.close);
  return { daemon, ...sdk };
}
const reads = [
  "ant0_profiles_list",
  "ant0_profile_status",
  "ant0_sessions_list",
  "ant0_proxies_list",
];
const args = (name: string) => (name === "ant0_profile_status" ? { id: ID } : {});

describe("endpoint-free inventories through the official MCP client", () => {
  it("keeps closed public profile/session shapes and unwraps a single inventory without leaking extras", async () => {
    const { client, daemon } = await setup();
    const status = await client.callTool({ name: "ant0_profile_status", arguments: { id: ID } });
    const projected = {
      profile_id: ID,
      browser_version: profile.browser_version,
      headless: true,
      started_at: DATE,
    };
    expect(status.structuredContent).toEqual({ state: "running", session: projected });
    const sessions = await client.callTool({ name: "ant0_sessions_list" });
    expect(sessions.structuredContent).toEqual({
      items: [projected],
      total: 1,
      limit: 50,
      offset: 0,
      has_more: false,
    });
    const proxies = await client.callTool({ name: "ant0_proxies_list" });
    expect(proxies.structuredContent).toEqual({
      items: [
        { id: ID, type: "http", last_check: { at: DATE, ok: true, country: "DE", latency_ms: 10 } },
      ],
      total: 1,
      limit: 50,
      offset: 0,
      has_more: false,
    });
    const profiles = await client.callTool({ name: "ant0_profiles_list" });
    expect(profiles.structuredContent).toEqual({
      items: [
        {
          id: ID,
          name: profile.name,
          group: null,
          tags: ["work"],
          status: null,
          pinned: false,
          platform: "linux",
          created_at: DATE,
          updated_at: DATE,
          proxy_id: ID,
          browser_version: profile.browser_version,
          identity_mode: "synthetic",
          last_launched_at: null,
        },
      ],
      total: 1,
      limit: 50,
      offset: 0,
      has_more: false,
    });
    for (const result of [status, sessions, proxies, profiles]) {
      expect(result.isError).not.toBe(true);
      expect(JSON.stringify(result)).not.toContain(SECRET);
      expect(JSON.parse((result.content as { text: string }[])[0]!.text)).toEqual(
        result.structuredContent,
      );
    }
    expect(daemon.requests.every((request) => request.url.startsWith("/v1/inventory/"))).toBe(true);
    expect(new URL(daemon.requests[1]!.url, "http://localhost").searchParams.get("running")).toBe(
      "true",
    );
  });

  it("uses fresh filtered upstream totals and exact page requests with mixed visible and invisible profiles", async () => {
    const rows = Array.from({ length: 105 }, (_, i) => {
      const id = `12345678-1234-4234-8234-${String(i).padStart(12, "0")}`;
      return {
        ...inventoryProfile,
        profile: { ...profile, id, name: `profile-${i}` },
        lifecycle: { ...inventoryProfile.lifecycle, profile_id: id },
        visible: i % 2 === 0,
      };
    });
    let available = rows.filter((row) => row.visible);
    const { client, daemon } = await setup((req, res) => {
      const url = new URL(req.url!, "http://localhost");
      expect(url.pathname).toBe("/v1/inventory/profiles");
      const offset = Number(url.searchParams.get("offset"));
      const limit = Number(url.searchParams.get("limit"));
      res.end(
        JSON.stringify({ items: available.slice(offset, offset + limit), total: available.length }),
      );
    });
    const first = await client.callTool({ name: "ant0_profiles_list", arguments: { limit: 50 } });
    expect(first.structuredContent).toMatchObject({ total: 53, has_more: true });
    expect(first.structuredContent!.items).toHaveLength(50);
    const last = await client.callTool({
      name: "ant0_profiles_list",
      arguments: { limit: 50, offset: 50 },
    });
    expect(last.structuredContent).toMatchObject({ total: 53, has_more: false });
    expect(last.structuredContent!.items).toHaveLength(3);
    available = [];
    const fresh = await client.callTool({ name: "ant0_profiles_list" });
    expect(fresh.structuredContent).toMatchObject({ items: [], total: 0, has_more: false });
    expect(daemon.requests).toHaveLength(3); // one bounded page per call; no full-inventory scan
  });

  it.each(reads.flatMap((name) => [403, 404, 409, 503].map((status) => ({ name, status }))))(
    "$name reports HTTP $status safely without stopped/empty success or guarded fallback",
    async ({ name, status }) => {
      const { client, daemon, stderr } = await setup((_req, res) => {
        res.writeHead(status);
        res.end(JSON.stringify({ error: SECRET, message: SECRET, details: SECRET }));
      });
      const result = await client.callTool({ name, arguments: args(name) });
      expect(result.isError).toBe(true);
      expect(result.structuredContent).toEqual({
        error: status === 403 ? "mcp.forbidden" : status === 404 ? "mcp.not_found" : "mcp.upstream",
        message: expect.any(String),
      });
      expect(JSON.stringify(result)).not.toContain(SECRET);
      expect(daemon.requests).toHaveLength(1);
      expect(daemon.requests[0]!.url).toMatch(/^\/v1\/inventory\//);
      expect(stderr()).toBe("");
    },
  );

  it.each([
    ["missing lifecycle", { ...inventoryProfile, lifecycle: undefined }],
    [
      "invalid state",
      { ...inventoryProfile, lifecycle: { ...inventoryProfile.lifecycle, state: SECRET } },
    ],
    [
      "partial session",
      { ...inventoryProfile, lifecycle: { ...inventoryProfile.lifecycle, headless: null } },
    ],
    [
      "invalid session date",
      {
        ...inventoryProfile,
        lifecycle: { ...inventoryProfile.lifecycle, started_at: "2026-02-30T00:00:00Z" },
      },
    ],
    [
      "mismatched ID",
      {
        ...inventoryProfile,
        lifecycle: {
          ...inventoryProfile.lifecycle,
          profile_id: "00000000-0000-0000-0000-000000000000",
        },
      },
    ],
    ["missing permissions", { ...inventoryProfile, permissions: {} }],
    ["malformed profile", { ...inventoryProfile, profile: { ...profile, pinned: SECRET } }],
    [
      "malformed omitted metadata",
      { ...inventoryProfile, profile: { ...profile, notes: { secret: SECRET } } },
    ],
    [
      "malformed proxy",
      { ...inventoryProfile, proxy: { ...proxy, last_check: { ...proxy.last_check, ok: SECRET } } },
    ],
  ])("rejects %s without echoing malformed fields", async (_kind, item) => {
    const { client } = await setup((_req, res) => res.end(JSON.stringify(item)));
    const result = await client.callTool({ name: "ant0_profile_status", arguments: { id: ID } });
    expect(result.structuredContent).toMatchObject({ error: "mcp.response" });
    expect(JSON.stringify(result)).not.toContain(SECRET);
  });

  it.each([
    { items: [], total: 1 },
    { items: [inventoryProfile], total: 0 },
    { items: [inventoryProfile], total: -1 },
    { items: [inventoryProfile] },
    { items: [inventoryProfile, inventoryProfile], total: 2 },
    { items: [inventoryProfile, { ...inventoryProfile, permissions: null }], total: 2 },
  ])("rejects incomplete or inconsistent pagination %#", async (body) => {
    const { client } = await setup((_req, res) => res.end(JSON.stringify(body)));
    const result = await client.callTool({ name: "ant0_profiles_list" });
    expect(result.isError).toBe(true);
    expect(result.structuredContent).toMatchObject({ error: "mcp.response" });
  });

  it("does not turn a failed running filter into a stopped session", async () => {
    const item = {
      ...inventoryProfile,
      lifecycle: {
        profile_id: ID,
        state: "stopped",
        headless: null,
        started_at: null,
        browser_version: null,
      },
    };
    const { client } = await setup((_req, res) =>
      res.end(JSON.stringify({ items: [item], total: 1 })),
    );
    const result = await client.callTool({ name: "ant0_sessions_list" });
    expect(result.structuredContent).toMatchObject({ error: "mcp.response" });
  });

  it("rejects malformed proxy check metadata without dropping the proxy from the total", async () => {
    const { client } = await setup((_req, res) =>
      res.end(
        JSON.stringify({
          items: [
            {
              ...proxy,
              last_check: { ...proxy.last_check, country: { secret: SECRET } },
            },
          ],
          total: 1,
        }),
      ),
    );
    const result = await client.callTool({ name: "ant0_proxies_list" });
    expect(result.structuredContent).toMatchObject({ error: "mcp.response" });
    expect(JSON.stringify(result)).not.toContain(SECRET);
  });

  it("preserves legitimate stopped status and null proxy checks", async () => {
    const { client } = await setup((req, res) =>
      res.end(
        JSON.stringify(
          req.url!.includes("proxies")
            ? { items: [{ id: ID, type: "https", last_check: null }], total: 1 }
            : {
                ...inventoryProfile,
                proxy: null,
                lifecycle: {
                  profile_id: ID,
                  state: "stopped",
                  headless: null,
                  started_at: null,
                  browser_version: null,
                },
              },
        ),
      ),
    );
    expect(
      (await client.callTool({ name: "ant0_profile_status", arguments: { id: ID } }))
        .structuredContent,
    ).toEqual({ state: "stopped", session: null });
    expect((await client.callTool({ name: "ant0_proxies_list" })).structuredContent!.items).toEqual(
      [{ id: ID, type: "https", last_check: null }],
    );
  });

  it("keeps manifest detail explicitly guarded rather than fabricating missing manifest fields", async () => {
    const { client, daemon } = await setup((_req, res) => {
      res.writeHead(403);
      res.end(JSON.stringify({ error: "licence.feature_required", message: SECRET }));
    });
    const result = await client.callTool({ name: "ant0_profile_detail", arguments: { id: ID } });
    expect(result.structuredContent).toMatchObject({ error: "mcp.forbidden" });
    expect(daemon.requests.map((request) => request.url)).toEqual([`/v1/profiles/${ID}`]);
  });

  it("unwraps typed API failures even when using an ordinary generated client", async () => {
    const client = createAnt0Client({
      baseUrl: "http://127.0.0.1",
      token: "local-fixture",
      fetch: async () =>
        new Response(JSON.stringify({ error: SECRET, message: SECRET }), { status: 403 }),
    });
    const result = await callTool(
      client,
      "ant0_profile_status",
      { id: ID },
      new AbortController().signal,
    );
    expect(result.structuredContent).toMatchObject({ error: "mcp.forbidden" });
    expect(JSON.stringify(result)).not.toContain(SECRET);
  });
});
