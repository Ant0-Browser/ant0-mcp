/** Classify libuv's raw st_mode, including Windows pipes whose Stats helpers return false. */
export function outputDescriptorKind(
  mode: unknown,
  terminal: boolean,
): "pipe" | "socket" | undefined {
  if (
    terminal ||
    typeof mode !== "number" ||
    !Number.isInteger(mode) ||
    mode < 0 ||
    mode > 0xffff
  ) {
    return undefined;
  }
  // Use the portable st_mode bits, not fs.constants/Stats helpers that may omit these types
  // on Windows. A Windows pipe reports mode 4096 (FILE_TYPE_PIPE) on Node 24 with libuv 1.52.
  const type = mode & 0o170000; // S_IFMT; permission/special bits do not change the file type.
  if (type === 0o010000) return "pipe"; // S_IFIFO, also libuv's Windows pipe mapping.
  if (type === 0o140000) return "socket"; // S_IFSOCK.
  return undefined;
}
