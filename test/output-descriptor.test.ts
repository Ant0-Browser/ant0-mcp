import { describe, expect, it } from "vitest";
import { outputDescriptorKind } from "../src/output-descriptor.js";
import windowsStdout from "./fixtures/windows-stdout.json";

describe("inherited stdout raw-mode classification", () => {
  it("accepts the actual Windows pipe witness despite unsupported Stats type helpers", () => {
    expect(windowsStdout).toMatchObject({
      mode: 4096,
      isFIFO: false,
      isSocket: false,
      isTTY: false,
      nativeGetFileType: 3,
      bytesTraversed: true,
    });
    expect(outputDescriptorKind(windowsStdout.mode, windowsStdout.isTTY)).toBe("pipe");
  });

  it.each([
    [0o010600, "pipe"],
    [0o014777, "pipe"],
    [0o140000, "socket"],
    [0o140777, "socket"],
  ])("uses file-type bits independently of permission/special bits: %s", (mode, kind) => {
    expect(outputDescriptorKind(mode, false)).toBe(kind);
  });

  it.each([0o010000, 0o140000, 0o020666])(
    "rejects an actual TTY even with apparent pipe/socket mode %s",
    (mode) => {
      expect(outputDescriptorKind(mode, true)).toBeUndefined();
    },
  );

  it.each([
    ["regular file", 0o100666],
    ["character device", 0o020666],
    ["directory", 0o040755],
    ["block device", 0o060600],
    ["symlink", 0o120777],
    ["unknown type", 0o030600],
    ["no file type", 0o000600],
  ])("rejects %s without a platform-wide fallback", (_kind, mode) => {
    expect(outputDescriptorKind(mode, false)).toBeUndefined();
  });

  it.each([undefined, null, "4096", NaN, Infinity, -1, 4096.5, 0x10001000, 0x100001000])(
    "rejects invalid modes before bitwise coercion: %s",
    (mode) => {
      expect(outputDescriptorKind(mode, false)).toBeUndefined();
    },
  );
});
