import { chmodSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { canonicalOrigin, discoverConnection } from "../src/connection.js";

const homes: string[] = [];
afterEach(() => {
  vi.unstubAllGlobals();
  for (const home of homes.splice(0)) rmSync(home, { recursive: true, force: true });
});
function home() {
  const value = mkdtempSync(join(tmpdir(), "ant0-mcp-discovery-"));
  homes.push(value);
  return value;
}

describe("canonical local discovery before bearer", () => {
  it.each([
    ["http://127.0.0.1:27100", "http://127.0.0.1:27100"],
    ["http://127.255.0.1:65535/", "http://127.255.0.1:65535"],
    ["http://localhost:80", "http://127.0.0.1"],
    ["http://[::1]:27100", "http://[::1]:27100"],
  ])("accepts %s with deterministic local origin", (value, expected) => {
    expect(canonicalOrigin(value)).toBe(expected);
  });

  it.each([
    "https://127.0.0.1:27100",
    "http://remote.example:27100",
    "http://0.0.0.0:27100",
    "http://127.0.0.1:27100/path",
    "http://127.0.0.1:27100?",
    "http://127.0.0.1:27100#",
    "http://user:secret@127.0.0.1:27100",
    "http://127.0.0.1:27100@remote.example",
    "http://127.0.0.1:0",
    "http://127.0.0.1:65536",
    "http://127.0.0.1:1.5",
    "http://127.0.0.1:01",
    "http://127.0.0.1",
    "http://127.1:27100",
    "http://2130706433:27100",
    "http://0x7f000001:27100",
    "http://127.000.0.1:27100",
    "http://127.256.0.1:27100",
    "http://LOCALHOST:27100",
    "http://localhost.:27100",
    " http://127.0.0.1:27100",
    "http://127.0.0.1:27100\n",
    "http://[::ffff:127.0.0.1]:27100",
    "http://[::]:27100",
    "http://127.0.0.1:27100/../",
  ])("rejects noncanonical/unsafe %s", (value) => {
    expect(() => canonicalOrigin(value)).toThrow("invalid local daemon configuration");
  });

  it("keeps CLI home/port precedence, canonicalizes localhost, and only needs the local bearer", () => {
    const dir = home();
    writeFileSync(join(dir, "ant0d.token"), "local-bearer\n", { mode: 0o600 });
    expect(
      discoverConnection({ env: { ANT0_HOME: dir, ANT0D_HOST: "localhost", ANT0D_PORT: "1234" } }),
    ).toEqual({ origin: "http://127.0.0.1:1234", token: "local-bearer" });
    writeFileSync(join(dir, "ant0d.pid"), JSON.stringify({ pid: 42, host: "::1", port: 2345 }));
    expect(
      discoverConnection({ home: dir, env: { ANT0_HOME: "ignored", ANT0D_PORT: "1234" } }).origin,
    ).toBe("http://[::1]:2345");
    expect(discoverConnection({ home: dir, port: 3456, env: {} }).origin).toBe("http://[::1]:3456");
  });

  it.each([0, 65536, 1.5, "1234", null])(
    "fails closed on malformed pid port %s rather than using another destination",
    (port) => {
      const dir = home();
      writeFileSync(join(dir, "ant0d.pid"), JSON.stringify({ pid: 42, host: "127.0.0.1", port }));
      expect(() => discoverConnection({ home: dir, env: {} })).toThrow(
        "invalid local daemon configuration",
      );
    },
  );

  it("bounds discovery files and refuses bearer symlinks", () => {
    const dir = home();
    writeFileSync(join(dir, "ant0d.token"), "x".repeat(4097), { mode: 0o600 });
    expect(() => discoverConnection({ home: dir, env: {} })).toThrow(
      "invalid local daemon configuration",
    );
    rmSync(join(dir, "ant0d.token"));
    writeFileSync(join(dir, "other-file"), "not-a-daemon-bearer");
    symlinkSync(join(dir, "other-file"), join(dir, "ant0d.token"));
    expect(() => discoverConnection({ home: dir, env: {} })).toThrow(/token file is not private/);
  });
});

describe("local token", () => {
  it("refuses an API key in ant0d.token", () => {
    const h = home();
    writeFileSync(join(h, "ant0d.token"), "ant0_sk_v1_whatever_abc\n", { mode: 0o600 });
    expect(() => discoverConnection({ home: h, env: {} })).toThrow(
      "invalid local daemon configuration",
    );
    writeFileSync(join(h, "ant0d.token"), "plain-local-token\n");
    expect(discoverConnection({ home: h, env: {} }).token).toBe("plain-local-token");
  });
});

describe("the local token file must be private", () => {
  const posix = process.platform === "win32" ? it.skip : it;
  const refused =
    /the local daemon token file is not private; the path and the fix are in the error output/;

  posix("accepts a private regular file", () => {
    const h = home();
    writeFileSync(join(h, "ant0d.token"), "fake-token\n", { mode: 0o600 });
    expect(discoverConnection({ home: h, env: {} }).token).toBe("fake-token");
  });

  posix.each([0o640, 0o604, 0o644])("refuses mode %o", (mode) => {
    const h = home();
    const file = join(h, "ant0d.token");
    writeFileSync(file, "fake-token\n");
    chmodSync(file, mode);
    const stderr = vi.spyOn(process.stderr, "write").mockImplementation(() => true);
    try {
      expect(() => discoverConnection({ home: h, env: {} })).toThrow(refused);
      // The path and the fix reach stderr; the token never does.
      const text = stderr.mock.calls.map((c) => String(c[0])).join("");
      expect(text).toContain(`chmod 600 '${file}'`);
      expect(text).not.toContain("fake-token");
    } finally {
      stderr.mockRestore();
    }
  });

  posix("ANT0_ALLOW_SHARED_TOKEN_FILE=1 warns on stderr and proceeds", () => {
    const h = home();
    const file = join(h, "ant0d.token");
    writeFileSync(file, "fake-token\n");
    chmodSync(file, 0o644);
    const stderr = vi.spyOn(process.stderr, "write").mockImplementation(() => true);
    try {
      const env = { ANT0_ALLOW_SHARED_TOKEN_FILE: "1" };
      expect(discoverConnection({ home: h, env }).token).toBe("fake-token");
      const text = stderr.mock.calls.map((c) => String(c[0])).join("");
      expect(text).toContain("warning");
      expect(text).toContain(file);
      expect(text).not.toContain("fake-token");
    } finally {
      stderr.mockRestore();
    }
  });

  posix.each(["yes", "true", "0", ""])("an opt-out value of %j is not an opt-out", (value) => {
    const h = home();
    const file = join(h, "ant0d.token");
    writeFileSync(file, "fake-token\n");
    chmodSync(file, 0o644);
    const stderr = vi.spyOn(process.stderr, "write").mockImplementation(() => true);
    try {
      expect(() =>
        discoverConnection({ home: h, env: { ANT0_ALLOW_SHARED_TOKEN_FILE: value } }),
      ).toThrow(refused);
    } finally {
      stderr.mockRestore();
    }
  });

  posix("a symlinked token is refused as token_file even with the opt-out set", () => {
    const h = home();
    writeFileSync(join(h, "real"), "fake-token\n", { mode: 0o600 });
    symlinkSync(join(h, "real"), join(h, "ant0d.token"));
    const stderr = vi.spyOn(process.stderr, "write").mockImplementation(() => true);
    try {
      expect(() =>
        discoverConnection({ home: h, env: { ANT0_ALLOW_SHARED_TOKEN_FILE: "1" } }),
      ).toThrow(refused);
    } finally {
      stderr.mockRestore();
    }
  });

  posix("refuses a symlink to a private file", () => {
    const h = home();
    writeFileSync(join(h, "real"), "fake-token\n", { mode: 0o600 });
    symlinkSync(join(h, "real"), join(h, "ant0d.token"));
    expect(() => discoverConnection({ home: h, env: {} })).toThrow(refused);
  });

  it("a missing token is the daemon being unavailable", () => {
    expect(() => discoverConnection({ home: home(), env: {} })).toThrow("local daemon unavailable");
  });

  it("does not check the mode on Windows (no bridge here)", () => {
    const h = home();
    const file = join(h, "ant0d.token");
    writeFileSync(file, "fake-token\n");
    chmodSync(file, 0o644);
    vi.stubGlobal("process", { ...process, platform: "win32" });
    expect(discoverConnection({ home: h, env: {} }).token).toBe("fake-token");
  });
});
