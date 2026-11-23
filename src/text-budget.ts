import { LIMITS } from "./limits.js";

/** Bytes a string takes inside a JSON document (quotes excluded): UTF-8 plus escapes. */
export function jsonBytes(text: string): number {
  return Buffer.byteLength(JSON.stringify(text)) - 2;
}

export const BUDGET_MARKER = "\n[truncated: reached the result size limit]";
/** Left free for the envelope: field names, the untrusted-content prefix and the framing. */
const MARGIN_BYTES = 16 * 1024;

/**
 * Cuts `text` so a result that carries it twice (as the text content and inside
 * `structuredContent`) stays well below the 256 KiB result limit. The cut is by UTF-8 bytes of the
 * JSON form, never inside a surrogate pair. `otherBytes` is what the rest of the result takes once.
 */
export function fitText(
  text: string,
  otherBytes: number,
  resultBytes: number = LIMITS.resultBytes,
): { text: string; truncated: boolean } {
  const each = Math.max(1024, Math.floor((resultBytes - MARGIN_BYTES - otherBytes) / 2));
  if (jsonBytes(text) <= each) return { text, truncated: false };
  const room = each - jsonBytes(BUDGET_MARKER);
  let lo = 0;
  let hi = text.length;
  while (lo < hi) {
    const mid = Math.ceil((lo + hi) / 2);
    if (jsonBytes(whole(text, mid)) <= room) lo = mid;
    else hi = mid - 1;
  }
  return { text: whole(text, lo) + BUDGET_MARKER, truncated: true };
}

/** The first `end` UTF-16 units, without a dangling half of a surrogate pair. */
function whole(text: string, end: number): string {
  if (end > 0 && end < text.length) {
    const last = text.charCodeAt(end - 1);
    if (last >= 0xd800 && last <= 0xdbff) end--;
  }
  const cut = text.slice(0, end);
  // A lone surrogate already in the input (a daemon cut) is dropped too.
  const tail = cut.charCodeAt(cut.length - 1);
  return tail >= 0xd800 && tail <= 0xdbff ? cut.slice(0, -1) : cut;
}
