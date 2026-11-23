import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { afterEach, expect, it, vi } from "vitest";
const observation = vi.hoisted(() => ({ opened: [] as string[] }));
vi.mock("node:fs", async (importOriginal) => {
  const fs = await importOriginal<typeof import("node:fs")>();
  return {
    ...fs,
    openSync: (...args: Parameters<typeof fs.openSync>) => {
      observation.opened.push(String(args[0]));
      return fs.openSync(...args);
    },
  };
});
import { discoverConnection } from "../src/connection.js";
import { saveCredentialFile } from "../src/credential-file.js";
import { privateTestDirectory, readyFile } from "./key-helpers.js";
const homes: string[] = [];
afterEach(() => {
  for (const home of homes.splice(0)) rmSync(home, { recursive: true, force: true });
});
it.each(["ready", "missing", "malformed", "pending"])(
  "never opens the master bearer when the key file is %s",
  (kind) => {
    const home = mkdtempSync(join(tmpdir(), "ant0-key-discovery-"));
    homes.push(home);
    privateTestDirectory(home);
    const path = join(home, "key.json");
    const file = readyFile();
    writeFileSync(join(home, "ant0d.token"), "MASTER_MUST_NOT_BE_OPENED");
    if (kind !== "missing")
      saveCredentialFile(
        path,
        kind === "pending" ? { ...file, phase: "pending", key: null } : file,
      );
    if (kind === "malformed") writeFileSync(path, "invalid");
    observation.opened.length = 0;
    if (kind === "ready")
      expect(discoverConnection({ home, credentialFile: path }).token).toBe(file.create.credential);
    else expect(() => discoverConnection({ home, credentialFile: path })).toThrow();
    expect(observation.opened).not.toContain(join(home, "ant0d.token"));
  },
);
it("never opens a credential file or the master bearer when ANT0_API_KEY is also set", () => {
  const home = mkdtempSync(join(tmpdir(), "ant0-key-discovery-"));
  homes.push(home);
  const path = join(home, "key.json");
  writeFileSync(path, JSON.stringify(readyFile()));
  writeFileSync(join(home, "ant0d.token"), "MASTER_MUST_NOT_BE_OPENED");
  observation.opened.length = 0;
  const env = { ANT0_API_KEY: readyFile().create.credential, ANT0D_PORT: "27100" };
  expect(() => discoverConnection({ home, credentialFile: path, env })).toThrow(
    "invalid local daemon configuration",
  );
  expect(() =>
    discoverConnection({ home, env: { ...env, ANT0_API_KEY: "ant0_sk_v1_invalid" } }),
  ).toThrow("invalid local daemon configuration");
  expect(observation.opened).not.toContain(path);
  expect(observation.opened).not.toContain(join(home, "ant0d.token"));
});
