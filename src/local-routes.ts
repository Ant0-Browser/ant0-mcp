/**
 * Daemon routes reachable ONLY with the local bearer (never with a private credential or API key).
 * Each entry is an exact (method, path) pair with the single success status the route returns.
 * The daemon's own key-auth allowlist already rejects API keys on these routes; this table is the
 * adapter-side half, and `daemonClient` consults it only when the connection is not in key mode.
 */
const UUID = "[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}";

export interface LocalRoute {
  readonly method: "GET" | "POST" | "PATCH" | "DELETE";
  readonly path: RegExp;
  /** The one success status; anything else is an error. */
  readonly status: 200 | 201 | 204;
  /** Whether the request carries a JSON object body (otherwise none is allowed). */
  readonly body: boolean;
  /** Success body is returned as text, not parsed as JSON (cookie export may be cookies.txt). */
  readonly text?: boolean;
  /** Validates the query string; absent means no query string at all. */
  readonly query?: (params: URLSearchParams) => boolean;
  /** Success body is raw bytes (a PNG) with the larger `screenshotBytes` cap; others keep 1 MiB. */
  readonly binary?: boolean;
  /** A POST that changes nothing, so an abort is a plain cancellation, never "indeterminate". */
  readonly readOnly?: boolean;
  /** Page-action route: the page error codes map to their own fixed MCP failures. */
  readonly page?: boolean;
}

/** Query-string check from a fixed allowlist: known keys only, each once, each value valid. */
const queryOf =
  (allowed: Record<string, (value: string) => boolean>) =>
  (params: URLSearchParams): boolean => {
    const keys = [...params.keys()];
    if (new Set(keys).size !== keys.length) return false;
    return keys.every((key) => Object.hasOwn(allowed, key) && allowed[key]!(params.get(key)!));
  };
const TAB_VALUE = (value: string): boolean => /^[A-Za-z0-9-]{8,64}$/.test(value);
const REF_VALUE = (value: string): boolean => /^[A-Za-z0-9]{1,32}$/.test(value);
const intIn =
  (min: number, max: number) =>
  (value: string): boolean =>
    /^\d{1,6}$/.test(value) && Number(value) >= min && Number(value) <= max;
const pagePath = (tail: string): RegExp => new RegExp(`^/v1/profiles/${UUID}/page/${tail}$`);

const exportQuery = (params: URLSearchParams): boolean => {
  const keys = [...params.keys()];
  if (keys.length > 1 || keys.some((key) => key !== "format")) return false;
  const formats = params.getAll("format");
  return formats.every((format) => format === "json" || format === "netscape");
};

export const LOCAL_ROUTES: readonly LocalRoute[] = Object.freeze([
  { method: "POST", path: /^\/v1\/profiles$/, status: 201, body: true },
  { method: "PATCH", path: new RegExp(`^/v1/profiles/${UUID}$`), status: 200, body: true },
  { method: "POST", path: new RegExp(`^/v1/profiles/${UUID}/duplicate$`), status: 201, body: true },
  // No query string is ever allowed here, so `permanent`, `purge` and `cloud` cannot be sent.
  { method: "DELETE", path: new RegExp(`^/v1/profiles/${UUID}$`), status: 204, body: false },
  { method: "POST", path: new RegExp(`^/v1/profiles/${UUID}/restore$`), status: 200, body: true },
  { method: "GET", path: new RegExp(`^/v1/profiles/${UUID}/identity$`), status: 200, body: false },
  // Run state with the CDP endpoint. No query string is allowed; the daemon alone decides access.
  { method: "GET", path: new RegExp(`^/v1/profiles/${UUID}/status$`), status: 200, body: false },
  { method: "POST", path: /^\/v1\/proxies$/, status: 201, body: true },
  { method: "POST", path: new RegExp(`^/v1/proxies/${UUID}/check$`), status: 200, body: true },
  { method: "POST", path: new RegExp(`^/v1/proxies/${UUID}/change-ip$`), status: 200, body: true },
  {
    method: "GET",
    path: new RegExp(`^/v1/profiles/${UUID}/cookies$`),
    status: 200,
    body: false,
    text: true,
    query: exportQuery,
  },
  { method: "POST", path: new RegExp(`^/v1/profiles/${UUID}/cookies$`), status: 200, body: true },
  // Page actions. Exact paths; the GET query strings are fixed allowlists.
  {
    method: "GET",
    path: pagePath("snapshot"),
    status: 200,
    body: false,
    page: true,
    query: queryOf({ tab: TAB_VALUE, max_chars: intIn(200, 100_000), max_refs: intIn(1, 20_000) }),
  },
  { method: "POST", path: pagePath("navigate"), status: 200, body: true, page: true },
  { method: "POST", path: pagePath("click"), status: 200, body: true, page: true },
  { method: "POST", path: pagePath("type"), status: 200, body: true, page: true },
  { method: "POST", path: pagePath("fill"), status: 200, body: true, page: true },
  { method: "POST", path: pagePath("select"), status: 200, body: true, page: true },
  { method: "POST", path: pagePath("key"), status: 200, body: true, page: true },
  { method: "POST", path: pagePath("wait"), status: 200, body: true, page: true, readOnly: true },
  {
    method: "GET",
    path: pagePath("screenshot"),
    status: 200,
    body: false,
    page: true,
    binary: true,
    query: queryOf({ tab: TAB_VALUE, ref: REF_VALUE }),
  },
  {
    method: "GET",
    path: pagePath("text"),
    status: 200,
    body: false,
    page: true,
    query: queryOf({ tab: TAB_VALUE, max_chars: intIn(1, 100_000) }),
  },
  { method: "GET", path: pagePath("tabs"), status: 200, body: false, page: true },
  { method: "POST", path: pagePath("tabs"), status: 200, body: true, page: true },
]);

export function matchLocalRoute(method: string, pathname: string): LocalRoute | undefined {
  return LOCAL_ROUTES.find((route) => route.method === method && route.path.test(pathname));
}

/** Request-shape check shared by the transport: query string and body presence. */
export function localRequestAllowed(
  route: LocalRoute,
  url: URL,
  body: Buffer,
  isObjectBody: (text: string) => boolean,
): boolean {
  if (route.query) {
    if (url.search !== "" && !route.query(url.searchParams)) return false;
  } else if (url.search !== "") return false;
  return route.body ? isObjectBody(body.toString("utf8")) : body.length === 0;
}

export type DaemonErrorKind =
  | "forbidden"
  | "invalid_request"
  | "profile_running"
  | "profile_synced"
  | "conflict"
  | "upstream"
  | "ref_stale"
  | "not_running"
  | "unsupported_input"
  | "not_editable"
  | "select_failed"
  | "out_of_view"
  | "focus_mismatch"
  | "obscured"
  | "tab_required"
  | "tab_hidden"
  | "destination_blocked"
  | "indeterminate"
  | "page_timeout"
  | "no_history";

/** Daemon page error codes and their fixed MCP failures. Only page routes consult this. */
const PAGE_CODES: Readonly<Record<string, DaemonErrorKind>> = Object.freeze({
  "page.ref_stale": "ref_stale",
  "profile.not_running": "not_running",
  "page.unsupported_input": "unsupported_input",
  "page.not_editable": "not_editable",
  "page.select_failed": "select_failed",
  "page.out_of_view": "out_of_view",
  "page.focus_mismatch": "focus_mismatch",
  "page.obscured": "obscured",
  "page.tab_required": "tab_required",
  "page.tab_hidden": "tab_hidden",
  "page.destination_blocked": "destination_blocked",
  "page.timeout": "page_timeout",
  "page.no_history": "no_history",
});

/** Closed mapping of daemon error codes; the daemon's message/details never cross. */
export function mapDaemonError(status: number, body: Buffer, page = false): DaemonErrorKind {
  let code: unknown;
  let reason: unknown;
  try {
    const parsed: unknown = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(body));
    if (parsed !== null && typeof parsed === "object" && !Array.isArray(parsed)) {
      code = (parsed as { error?: unknown }).error;
      const details = (parsed as { details?: unknown }).details;
      if (details !== null && typeof details === "object" && !Array.isArray(details))
        reason = (details as { reason?: unknown }).reason;
    }
  } catch {
    code = undefined;
  }
  // A navigation or an input action that timed out may have partly happened: the outcome is
  // unknown. Only a wait that ran out changed nothing.
  if (page && code === "page.timeout" && (reason === "navigation" || reason === "action"))
    return "indeterminate";
  if (code === "validation_failed") return "invalid_request";
  if (page && typeof code === "string" && Object.hasOwn(PAGE_CODES, code)) return PAGE_CODES[code]!;
  if (status === 403) return "forbidden"; // any 403 without a page code of its own
  if (code === "profile.running") return "profile_running";
  if (code === "profile.synced") return "profile_synced";
  // A 409 with an unparseable body stays `upstream`; only a coded conflict is reported as one.
  return status === 409 && typeof code === "string" ? "conflict" : "upstream";
}
