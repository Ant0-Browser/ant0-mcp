import { isAnt0ApiError } from "./api/index.js";
import { CredentialFailure } from "./key-contract.js";

const MESSAGES = {
  configuration: "invalid local daemon configuration",
  token_file:
    "the local daemon token file is not private; the path and the fix are in the error output of ant0 mcp serve",
  unavailable: "local daemon unavailable",
  unauthorized: "local daemon authorization required",
  forbidden: "local daemon denied this request",
  not_found: "item not found",
  upstream: "local daemon request failed",
  response: "invalid local daemon response",
  body_limit: "local daemon response exceeds limit",
  result_limit: "tool result exceeds limit; request fewer items",
  deadline: "local daemon request timed out",
  cancelled: "request cancelled",
  indeterminate: "operation outcome is unknown; check the current state before retrying",
  invalid_request: "The daemon rejected the input.",
  profile_running: "Stop the profile first.",
  profile_synced: "This profile syncs with the cloud; remove it in the Ant0 app.",
  conflict: "The daemon reported a conflict; check the profile and retry.",
  ref_stale: "The ref is stale; take a new snapshot and use a ref from it.",
  not_running: "The profile is not running; start it with ant0_profile_run first.",
  unsupported_input: "This control cannot be driven by typing or pointer input.",
  not_editable: "The field is disabled or read-only.",
  select_failed: "The select did not take the requested option.",
  out_of_view: "The target is outside the viewport or has no box.",
  focus_mismatch:
    "The target was not (or no longer) the focused element, so typing stopped; earlier characters or fields may already have been entered, and with submit the form may already have been submitted. Take a new snapshot, check the page state before retrying, and retry only what is missing. If its tab is in the background select it with ant0_tabs first.",
  obscured:
    "Another element covers the target, so that click was not sent (earlier fields of a fill may already have been entered); close the overlay or scroll and retry.",
  tab_hidden:
    "The tab is in the background (or went there mid-action; earlier characters or fields may already have been entered): call ant0_tabs with action select for it first (this changes the tab the user sees), check the page state, then retry.",
  tab_required: "Several tabs are open: call ant0_tabs to list them and pass the tab id as tab.",
  destination_blocked:
    "This URL points to a local or private-network address, which the page tools refuse. Use a public http(s) URL.",
  page_timeout: "The wait did not finish in time.",
  no_history: "There is no history entry in that direction.",
  arguments: "invalid tool arguments",
  unknown_tool: "unknown tool",
  busy: "too many concurrent calls",
  frame: "invalid MCP input frame",
  frame_limit: "MCP input frame exceeds limit",
  input: "MCP input failed",
  output: "MCP output failed",
  stdio: "MCP requires pipe or socket stdout",
  peer: "MCP peer did not answer ping",
  backpressure: "MCP output stalled",
  internal: "MCP adapter failed",
} as const;

export type FailureCode = keyof typeof MESSAGES;

/** Tool discovery must advertise the same fixed structured failures that errorResult emits. */
export const FAILURE_OUTPUT_SCHEMA = {
  type: "object" as const,
  anyOf: Object.entries(MESSAGES).map(([code, message]) => ({
    type: "object",
    additionalProperties: false,
    required: ["error", "message"],
    properties: { error: { const: `mcp.${code}` }, message: { const: message } },
  })),
};

/** Only these fixed strings cross the diagnostic boundary. Never retain a raw cause. */
export class McpFailure extends Error {
  constructor(readonly code: FailureCode) {
    super(MESSAGES[code]);
  }
}

export function safeFailure(error: unknown): McpFailure {
  if (error instanceof CredentialFailure) return new McpFailure("response");
  if (isAnt0ApiError(error)) {
    return new McpFailure(
      error.status === 401
        ? "unauthorized"
        : error.status === 403
          ? "forbidden"
          : error.status === 404
            ? "not_found"
            : "upstream",
    );
  }
  return error instanceof McpFailure ? error : new McpFailure("internal");
}
