import { randomUUID } from "node:crypto";
import {
  linkSync,
  mkdtempSync,
  readFileSync,
  renameSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { afterEach, expect, it, vi } from "vitest";
const race = vi.hoisted(() => ({ alias: "", before: undefined as (() => void) | undefined }));
vi.mock("node:fs", async (importOriginal) => {
  const fs = await importOriginal<typeof import("node:fs")>();
  return {
    ...fs,
    unlinkSync: (path: Parameters<typeof fs.unlinkSync>[0]) => {
      if (String(path) === race.alias && race.before) {
        const before = race.before;
        race.before = undefined;
        fs.unlinkSync(path);
        before();
        throw Object.assign(new Error("concurrent alias cleanup"), { code: "ENOENT" });
      }
      return fs.unlinkSync(path);
    },
  };
});
import { readCredentialFile, saveCredentialFile } from "../src/credential-file.js";
import { privateTestDirectory, readyFile } from "./key-helpers.js";
const homes: string[] = [];
afterEach(() => {
  race.alias = "";
  race.before = undefined;
  for (const home of homes.splice(0)) rmSync(home, { recursive: true, force: true });
});
it.each(
  ["credential", "result"].flatMap((kind) =>
    ["unchanged", "replaced", "modified"].map((change) => ({ kind, change })),
  ),
)(
  "concurrent alias ENOENT for $kind accepts only the unchanged normalized object ($change)",
  ({ kind, change }) => {
    const home = mkdtempSync(join(tmpdir(), "ant0-normalize-race-"));
    homes.push(home);
    privateTestDirectory(home);
    const path = join(home, "key.json");
    const ready = readyFile();
    const pending = saveCredentialFile(path, { ...ready, phase: "pending", key: null });
    if (kind === "result") saveCredentialFile(path, ready, pending);
    const target = kind === "result" ? `${path}.result.json` : path;
    const original = readFileSync(target);
    const replacement = join(home, "replacement");
    writeFileSync(replacement, original, { mode: 0o600 });
    race.alias = join(home, `.ant0-key-publish-v1.${kind}.${ready.create.id}.${randomUUID()}.tmp`);
    linkSync(target, race.alias);
    race.before = () => {
      if (change === "replaced") renameSync(replacement, target);
      if (change === "modified")
        writeFileSync(target, Buffer.concat([original, Buffer.from(" \n")]));
    };
    if (change === "unchanged") {
      expect(readCredentialFile(path).rawValue.create.id).toBe(ready.create.id);
      expect(statSync(target).nlink).toBe(1);
      expect(readFileSync(target)).toEqual(original);
    } else expect(() => readCredentialFile(path)).toThrow();
  },
);
