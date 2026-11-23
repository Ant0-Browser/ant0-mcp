/**
 * Freeze of the public tool contract: the `tools/list` payload of the local connection plus the
 * scope each tool needs. Any change to a name, input/output schema, annotation or scope shows up
 * as a snapshot diff and has to be made on purpose (`vitest run -u`, then review the JSON diff).
 *
 * Descriptions are frozen in a second file so that an intentional wording change (for example
 * removing " Beta." from the page tools) is one `-u` run that touches only
 * `__snapshots__/tool-descriptions.json` and leaves the schema freeze alone.
 *
 * The list is built the way the server builds it (`toolsForCredential`, with no credential for the
 * local bearer and with a grant for each scope), not from SDK internals. One test also checks that
 * the real stdio `tools/list` of the built adapter agrees with it.
 */
import { afterEach, describe, expect, it } from "vitest";
import { keyScopes, type KeyGrant, type KeyScope } from "../src/key-contract.js";
import { TOOLS, toolsForCredential } from "../src/tools.js";
import { mockDaemon, sdkClient } from "./helpers.js";

type Json = null | boolean | number | string | Json[] | { [key: string]: Json };

/** Deep copy with object keys sorted, so the snapshot never depends on construction order. */
function stable(value: unknown): Json {
  if (Array.isArray(value)) return value.map(stable);
  if (value !== null && typeof value === "object") {
    const out: { [key: string]: Json } = {};
    for (const key of Object.keys(value).sort())
      if ((value as Record<string, unknown>)[key] !== undefined)
        out[key] = stable((value as Record<string, unknown>)[key]);
    return out;
  }
  return value as Json;
}
const text = (value: unknown) => `${JSON.stringify(stable(value), null, 2)}\n`;

const grant = (scopes: readonly KeyScope[]): KeyGrant => ({
  id: "00000000-0000-4000-8000-000000000000",
  credential: "unused",
  scopes,
});

/** `"local"` for a tool no credential can see; otherwise the one key scope that lists it. */
function scopeOf(name: string): string {
  const visible = (scopes: readonly KeyScope[]) =>
    toolsForCredential(grant(scopes)).some((t) => t.name === name);
  if (!visible(keyScopes)) return "local";
  const owners = keyScopes.filter((scope) => visible([scope]));
  expect(owners, `${name} must belong to exactly one scope`).toHaveLength(1);
  return owners[0]!;
}

const local = toolsForCredential(undefined);

describe("tool contract freeze", () => {
  it("lists 32 uniquely named tools for the local bearer", () => {
    expect(local).toBe(TOOLS);
    expect(local).toHaveLength(32);
    expect(new Set(local.map((t) => t.name)).size).toBe(32);
  });

  it("schemas, annotations and scopes are frozen", async () => {
    const contract = local.map((tool) => ({
      name: tool.name,
      scope: scopeOf(tool.name),
      inputSchema: tool.inputSchema,
      outputSchema: tool.outputSchema ?? null,
      annotations: tool.annotations ?? null,
    }));
    await expect(text(contract)).toMatchFileSnapshot("./__snapshots__/tool-contract.json");
  });

  it("descriptions are frozen (one `-u` to change on purpose)", async () => {
    const descriptions = Object.fromEntries(local.map((tool) => [tool.name, tool.description]));
    await expect(text(descriptions)).toMatchFileSnapshot("./__snapshots__/tool-descriptions.json");
  });

  it("the 9 keyed-credential tools are exactly the expected ones, with their scopes", () => {
    const expected = {
      ant0_daemon_status: "status:read",
      ant0_licence_status: "status:read",
      ant0_profiles_list: "profiles:read",
      ant0_profile_detail: "profiles:read",
      ant0_profile_status: "profiles:read",
      ant0_sessions_list: "profiles:read",
      ant0_proxies_list: "proxies:read",
      ant0_profile_run: "profiles:run",
      ant0_profile_stop: "profiles:stop",
    };
    const keyed = Object.fromEntries(
      local.map((t) => [t.name, scopeOf(t.name)] as const).filter(([, scope]) => scope !== "local"),
    );
    expect(keyed).toEqual(expected);
    // Nothing leaks to a credential holding every scope beyond those nine.
    expect(
      toolsForCredential(grant(keyScopes))
        .map((t) => t.name)
        .sort(),
    ).toEqual(Object.keys(expected).sort());
  });

  it("the other 23 tools are local-only", () => {
    const localOnly = local.filter((t) => scopeOf(t.name) === "local");
    expect(localOnly).toHaveLength(23);
  });
});

describe("tools/list over real stdio agrees with the frozen list", () => {
  const cleanups: (() => Promise<void>)[] = [];
  afterEach(async () => {
    for (const close of cleanups.splice(0).reverse()) await close();
  });

  it("name, description, schemas and annotations match", async () => {
    const daemon = await mockDaemon();
    cleanups.push(daemon.close);
    const sdk = await sdkClient(daemon.home);
    cleanups.push(sdk.close);
    const listed = (await sdk.client.listTools()).tools;
    const pick = (t: any) => ({
      name: t.name,
      description: t.description,
      inputSchema: t.inputSchema,
      outputSchema: t.outputSchema ?? null,
      annotations: t.annotations ?? null,
    });
    expect(stable(listed.map(pick))).toEqual(stable(local.map(pick)));
  }, 30_000);
});
