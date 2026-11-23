import {
  chmodSync,
  chownSync,
  linkSync,
  mkdirSync,
  mkdtempSync,
  renameSync,
  rmSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { execFileSync } from "node:child_process";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { afterEach, describe, expect, it } from "vitest";
import {
  assertCredentialUnchanged,
  readCredentialFile,
  saveCredentialFile,
  withCredentialLock,
} from "../src/credential-file.js";
import { readyFile, privateTestDirectory } from "./key-helpers.js";

const homes: string[] = [];
afterEach(() => {
  for (const home of homes.splice(0)) rmSync(home, { recursive: true, force: true });
});
function fixture() {
  const home = mkdtempSync(join(tmpdir(), "ant0-key-file-"));
  homes.push(home);
  privateTestDirectory(home);
  return { home, path: join(home, "key.json"), file: readyFile() };
}
describe("shared durable private credential files", () => {
  it("creates an immutable pending credential and supplies ready metadata through a receipt", () => {
    const { path, file } = fixture();
    const pending = saveCredentialFile(path, { ...file, phase: "pending", key: null });
    expect(readCredentialFile(path).value).toEqual({ ...file, phase: "pending", key: null });
    if (process.platform !== "win32") expect(statSync(path).mode & 0o777).toBe(0o600);
    saveCredentialFile(path, file, pending);
    expect(readCredentialFile(path).value).toEqual(file);
  });
  it("never overwrites an existing different record or changes saved original creation inputs", () => {
    const { path, file } = fixture();
    const saved = saveCredentialFile(path, file);
    expect(() => saveCredentialFile(path, file)).toThrow("private credential");
    expect(() =>
      saveCredentialFile(path, { ...file, create: { ...file.create, name: "changed" } }, saved),
    ).toThrow();
    expect(readCredentialFile(path).value).toEqual(file);
  });
  it("rejects changed files, including replacement with identical bytes", () => {
    const { path, file, home } = fixture();
    const saved = saveCredentialFile(path, file);
    const replacement = join(home, "replacement.json");
    saveCredentialFile(replacement, file);
    renameSync(replacement, path);
    expect(() => assertCredentialUnchanged(saved)).toThrow("changed");
    expect(() => saveCredentialFile(path, file, saved)).toThrow();
  });
  it.each([
    "malformed",
    "huge",
    "extra",
    "credential",
    "context",
    "phase",
    "binding",
    "base64",
    "duplicate scopes",
  ])("rejects %s records", (kind) => {
    const { path, file } = fixture();
    saveCredentialFile(path, file);
    const value: any = structuredClone(file);
    if (kind === "extra") value.password = "CANARY";
    if (kind === "credential") value.create.credential += "=";
    if (kind === "context") value.expected.workspace_id = "bad";
    if (kind === "phase") value.phase = "pending";
    if (kind === "binding") value.key.device_id = "B".repeat(26);
    if (kind === "base64")
      value.expected.device_sign_pub = value.expected.device_sign_pub.replace(/=$/, "");
    if (kind === "duplicate scopes") value.create.scopes = ["status:read", "status:read"];
    writeFileSync(
      path,
      kind === "malformed"
        ? "{CANARY"
        : kind === "huge"
          ? "x".repeat(65537)
          : JSON.stringify(value),
    );
    expect(() => readCredentialFile(path)).toThrow("invalid private credential file");
  });
  it.skipIf(process.platform === "win32")(
    "rejects file permissions, owner-inaccessible directories, symlinks and hardlinks",
    () => {
      const { path, file, home } = fixture();
      saveCredentialFile(path, file);
      chmodSync(path, 0o644);
      expect(() => readCredentialFile(path)).toThrow();
      chmodSync(path, 0o600);
      chmodSync(home, 0o755);
      expect(() => readCredentialFile(path)).toThrow();
      chmodSync(home, 0o700);
      const sym = join(home, "link.json");
      symlinkSync(path, sym);
      expect(() => readCredentialFile(sym)).toThrow();
      expect(() => saveCredentialFile(sym, file)).toThrow();
      const hard = join(home, "hard.json");
      linkSync(path, hard);
      expect(() => readCredentialFile(path)).toThrow();
      expect(() => readCredentialFile(hard)).toThrow();
    },
  );
  it.skipIf(process.platform === "win32")("rejects symlink ancestors", () => {
    const { home, path, file } = fixture();
    saveCredentialFile(path, file);
    const alias = join(home, "alias");
    symlinkSync(home, alias);
    expect(() => readCredentialFile(join(alias, "key.json"))).toThrow();
  });
  it.skipIf(process.platform === "win32" || process.getuid?.() !== 0)(
    "rejects a foreign file owner even with owner-only mode",
    () => {
      const { path, file } = fixture();
      saveCredentialFile(path, file);
      chownSync(path, 65534, 65534);
      expect(() => readCredentialFile(path)).toThrow();
    },
  );
  it.skipIf(process.platform === "win32")(
    "rejects a non-sticky writable ancestor of a private directory",
    () => {
      const { home, file } = fixture();
      const nested = join(home, "nested");
      mkdirSync(nested, { mode: 0o700 });
      const path = join(nested, "key.json");
      saveCredentialFile(path, file);
      chmodSync(home, 0o777);
      expect(() => readCredentialFile(path)).toThrow();
    },
  );
  it.skipIf(process.platform !== "win32")(
    "rejects Windows ACL access granted to another principal",
    () => {
      const { path, file } = fixture();
      saveCredentialFile(path, file);
      expect(readCredentialFile(path).value).toEqual(file);
      // Modify only this disposable file's DACL; Set-Acl can require SACL privileges.
      execFileSync(
        join(process.env.SystemRoot ?? "C:\\Windows", "System32", "icacls.exe"),
        [path, "/grant", "*S-1-1-0:R"],
        { stdio: "ignore", windowsHide: true },
      );
      expect(() => readCredentialFile(path)).toThrow();
    },
    30_000,
  );
  it.skipIf(process.platform !== "win32")(
    "rejects Windows junction ancestors",
    () => {
      const { home, path, file } = fixture();
      saveCredentialFile(path, file);
      const junction = join(home, "junction");
      symlinkSync(home, junction, "junction");
      expect(() => readCredentialFile(join(junction, "key.json"))).toThrow();
    },
    30_000,
  );
  it("serializes provisioners across awaits and releases its lock on failure", async () => {
    const { path } = fixture();
    await withCredentialLock(path, async () => {
      await expect(withCredentialLock(path, async () => {})).rejects.toThrow("busy");
    });
    await expect(
      withCredentialLock(path, async () => {
        throw new Error("test failure");
      }),
    ).rejects.toThrow("test failure");
    await expect(withCredentialLock(path, async () => 7)).resolves.toBe(7);
  });
  it("keeps revoked replay metadata revoked and accepts a rename without altering original inputs", () => {
    const { path, file } = fixture();
    const saved = saveCredentialFile(path, { ...file, phase: "pending", key: null });
    const ready = {
      ...file,
      key: {
        ...file.key!,
        name: "Renamed",
        status: "revoked" as const,
        revoked_at: new Date().toISOString(),
      },
    };
    saveCredentialFile(path, ready, saved);
    expect(readCredentialFile(path).value.key).toMatchObject({
      name: "Renamed",
      status: "revoked",
    });
    expect(readCredentialFile(path).value.create.name).toBe(file.create.name);
  });
  it.each(["expiry", "ceiling", "revoked", "expired"])(
    "never renews or reactivates a ready file on a mismatched %s replay",
    (kind) => {
      const { path, file } = fixture();
      if (kind === "revoked") {
        file.key!.status = "revoked";
        file.key!.revoked_at = new Date().toISOString();
      }
      if (kind === "expired") {
        file.key!.status = "expired";
        file.key!.created_at = "2020-01-01T00:00:00.000Z";
        file.key!.expires_at = "2020-01-31T00:00:00.000Z";
      }
      const saved = saveCredentialFile(path, file);
      const next = structuredClone(file);
      if (kind === "expiry") {
        next.key!.created_at = new Date(Date.parse(next.key!.created_at) + 1000).toISOString();
        next.key!.expires_at = new Date(Date.parse(next.key!.expires_at) + 1000).toISOString();
      } else if (kind === "ceiling") next.key!.role_ceiling = "owner";
      else {
        next.key!.status = "active";
        next.key!.revoked_at = null;
      }
      if (kind === "expiry" || kind === "ceiling")
        expect(() => saveCredentialFile(path, next, saved)).toThrow();
      else saveCredentialFile(path, next, saved);
      expect(readCredentialFile(path).value).toEqual(file);
    },
  );
  it("counts printable Unicode names by code points like the native shared format", () => {
    const { path, file } = fixture();
    file.create.name = "💡".repeat(100);
    file.key!.name = file.create.name;
    expect(saveCredentialFile(path, file).value).toEqual(file);
    expect(readCredentialFile(path).value.create.name).toBe(file.create.name);
  });
});
