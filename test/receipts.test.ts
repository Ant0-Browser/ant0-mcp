import { createHash, randomUUID } from "node:crypto";
import {
  chmodSync,
  existsSync,
  linkSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  renameSync,
  rmSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { afterEach, describe, expect, it } from "vitest";
import {
  readCredentialFile,
  saveCredentialFile,
  assertCredentialUnchanged,
} from "../src/credential-file.js";
import { discoverConnection } from "../src/connection.js";
import { privateTestDirectory, readyFile } from "./key-helpers.js";

const homes: string[] = [];
afterEach(() => {
  for (const home of homes.splice(0)) rmSync(home, { recursive: true, force: true });
});
function fixture() {
  const home = mkdtempSync(join(tmpdir(), "ant0-receipt-"));
  homes.push(home);
  privateTestDirectory(home);
  const path = join(home, "key.json");
  const ready = readyFile();
  const pending = saveCredentialFile(path, { ...ready, phase: "pending", key: null });
  return { home, path, ready, pending, receipt: `${path}.result.json` };
}
function reserved(home: string, kind: "credential" | "result", id: string) {
  return join(home, `.ant0-key-publish-v1.${kind}.${id}.${randomUUID()}.tmp`);
}
describe("immutable credentials and create-only result receipts", () => {
  it("hashes exact original bytes including whitespace and keeps raw and effective state distinct", () => {
    const f = fixture();
    const bytes = Buffer.from(JSON.stringify(f.pending.rawValue, null, 3) + " \n\n");
    writeFileSync(f.path, bytes);
    const pending = readCredentialFile(f.path);
    const ready = saveCredentialFile(f.path, f.ready, pending);
    expect(readFileSync(f.path)).toEqual(bytes);
    expect(ready.rawValue.phase).toBe("pending");
    expect(ready.rawValue.key).toBeNull();
    expect(ready.value).toEqual(f.ready);
    expect(JSON.parse(readFileSync(f.receipt, "utf8"))).toEqual({
      schema: "ant0-api-key-result/v1",
      credential_file_sha256: createHash("sha256").update(bytes).digest("hex"),
      key: f.ready.key,
    });
    expect(discoverConnection({ home: f.home, credentialFile: f.path }).token).toBe(
      f.ready.create.credential,
    );
  });
  it("pending without a result permits replay but never consumption", () => {
    const f = fixture();
    expect(readCredentialFile(f.path).value.phase).toBe("pending");
    expect(() => discoverConnection({ home: f.home, credentialFile: f.path })).toThrow();
  });
  it("reuses the first result despite later mutable observations without changing either file", () => {
    const f = fixture();
    const first = saveCredentialFile(f.path, f.ready, f.pending);
    const original = readFileSync(f.path);
    const receipt = readFileSync(f.receipt);
    const next = {
      ...f.ready,
      key: {
        ...f.ready.key!,
        name: "Renamed",
        status: "revoked" as const,
        revoked_at: new Date().toISOString(),
        last_used_at: new Date().toISOString(),
      },
    };
    expect(saveCredentialFile(f.path, next, first).value.key).toEqual(f.ready.key);
    expect(readFileSync(f.path)).toEqual(original);
    expect(readFileSync(f.receipt)).toEqual(receipt);
  });
  it.each(["created_at", "expires_at", "role_ceiling"])(
    "rejects conflicting immutable %s and preserves first receipt",
    (field) => {
      const f = fixture();
      const first = saveCredentialFile(f.path, f.ready, f.pending);
      const original = readFileSync(f.receipt);
      const next = structuredClone(f.ready);
      if (field === "role_ceiling") next.key!.role_ceiling = "owner";
      else {
        next.key!.created_at = new Date(Date.parse(next.key!.created_at) + 1000).toISOString();
        next.key!.expires_at = new Date(Date.parse(next.key!.expires_at) + 1000).toISOString();
      }
      expect(() => saveCredentialFile(f.path, next, first)).toThrow();
      expect(readFileSync(f.receipt)).toEqual(original);
    },
  );
  it.each(["hash", "schema", "id", "scope", "extra", "credential echo"])(
    "rejects an invalid %s receipt without removing it",
    (kind) => {
      const f = fixture();
      saveCredentialFile(f.path, f.ready, f.pending);
      const value = JSON.parse(readFileSync(f.receipt, "utf8"));
      if (kind === "hash") value.credential_file_sha256 = "0".repeat(64);
      if (kind === "schema") value.schema = "wrong";
      if (kind === "id") value.key.id = randomUUID();
      if (kind === "scope") value.key.scopes = ["status:read"];
      if (kind === "extra") value.credential = "unexpected";
      if (kind === "credential echo") value.key.name = f.ready.create.credential;
      writeFileSync(f.receipt, JSON.stringify(value));
      const before = readFileSync(f.receipt);
      expect(() => readCredentialFile(f.path)).toThrow();
      expect(readFileSync(f.receipt)).toEqual(before);
      expect(readFileSync(f.path)).toEqual(f.pending.bytes);
    },
  );
  it.skipIf(process.platform === "win32")("rejects unsafe receipt mode and symlink paths", () => {
    const f = fixture();
    saveCredentialFile(f.path, f.ready, f.pending);
    chmodSync(f.receipt, 0o644);
    expect(() => readCredentialFile(f.path)).toThrow();
    chmodSync(f.receipt, 0o600);
    const other = join(f.home, "other");
    renameSync(f.receipt, other);
    symlinkSync(other, f.receipt);
    expect(() => readCredentialFile(f.path)).toThrow();
  });
  it("does not override an existing standalone ready file", () => {
    const f = fixture();
    const path = join(f.home, "legacy.json");
    const legacy = saveCredentialFile(path, f.ready);
    const bytes = readFileSync(path);
    saveCredentialFile(
      path,
      { ...f.ready, key: { ...f.ready.key!, name: "Changed live name" } },
      legacy,
    );
    expect(readCredentialFile(path).value).toEqual(f.ready);
    expect(readFileSync(path)).toEqual(bytes);
    expect(existsSync(`${path}.result.json`)).toBe(false);
  });
  it.each(["credential", "result"] as const)(
    "normalizes one exact reserved %s alias and leaves unrelated one-link orphans",
    (kind) => {
      const f = fixture();
      if (kind === "result") saveCredentialFile(f.path, f.ready, f.pending);
      const target = kind === "result" ? f.receipt : f.path;
      const alias = reserved(f.home, kind, f.ready.create.id);
      linkSync(target, alias);
      const orphan = reserved(f.home, kind, f.ready.create.id);
      writeFileSync(orphan, "live publisher", { mode: 0o600 });
      expect(statSync(target).nlink).toBe(2);
      const read = readCredentialFile(f.path);
      expect(read.rawValue.create.id).toBe(f.ready.create.id);
      expect(statSync(target).nlink).toBe(1);
      expect(existsSync(alias)).toBe(false);
      expect(existsSync(orphan)).toBe(true);
      assertCredentialUnchanged(read);
    },
  );
  it.each(["arbitrary", "wrong id", "wrong kind", "uppercase nonce", "third link"])(
    "rejects %s hardlinks without unlinking anything",
    (kind) => {
      const f = fixture();
      let alias = reserved(f.home, "credential", f.ready.create.id);
      if (kind === "arbitrary") alias = join(f.home, "arbitrary");
      if (kind === "wrong id") alias = reserved(f.home, "credential", randomUUID());
      if (kind === "wrong kind") alias = reserved(f.home, "result", f.ready.create.id);
      if (kind === "uppercase nonce")
        alias = join(
          f.home,
          `.ant0-key-publish-v1.credential.${f.ready.create.id}.AAAAAAAA-AAAA-4AAA-8AAA-AAAAAAAAAAAA.tmp`,
        );
      linkSync(f.path, alias);
      if (kind === "third link")
        linkSync(f.path, reserved(f.home, "credential", f.ready.create.id));
      const before = readdirSync(f.home).sort();
      expect(() => readCredentialFile(f.path)).toThrow();
      expect(readdirSync(f.home).sort()).toEqual(before);
    },
  );
});
