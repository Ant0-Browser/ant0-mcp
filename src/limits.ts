/** Byte limits include UTF-8, not JavaScript character counts. */
export const LIMITS = Object.freeze({
  frameBytes: 1024 * 1024,
  bodyBytes: 1024 * 1024,
  /** A page screenshot from the daemon: its 8 MiB cap plus a margin for the framing. */
  screenshotBytes: 8 * 1024 * 1024 + 64 * 1024,
  /** Largest PNG returned inline as MCP image content (base64 must fit the output envelope). */
  inlineImageBytes: 900 * 1024,
  resultBytes: 256 * 1024,
  concurrentCalls: 8,
  listItems: 100,
  httpMs: 10_000,
  outputMs: 1_000,
  writerStartupMs: 1_000,
  pingIntervalMs: 1_000,
  pingResponseMs: 3_000,
  outputBytes: 2 * 1024 * 1024,
  outputWrites: 32,
  envelopeBytes: 1024 * 1024 + 256 * 1024 + 1024,
  discoveryBytes: 4096,
});
