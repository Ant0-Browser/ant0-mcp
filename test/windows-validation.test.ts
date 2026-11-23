import {
  mkdtempSync,
  rmSync,
  chmodSync,
  readFileSync,
  writeFileSync,
  renameSync,
  statSync,
  utimesSync,
  mkdirSync,
  symlinkSync,
} from "node:fs";
import { dirname, join } from "node:path";
import { tmpdir } from "node:os";
import { afterEach, beforeEach, expect, it as test, vi } from "vitest";

const it = test.skipIf(process.platform !== "linux");

// Runs the Windows orchestration on real Linux files. The subprocess double is an independent
// ACL oracle, not Windows qualification; actual PowerShell/Win32 behavior is checked manually.
const probe = vi.hoisted(() => ({
  calls: [] as string[],
  afterFlush: undefined as (() => void) | undefined,
  beforeCheck: undefined as (() => void) | undefined,
  afterAsyncCheck: undefined as (() => void) | undefined,
  deny: false,
  handles: new Set<number>(),
  opens: [] as string[],
  policyTemp: "",
  policyProbes: 0,
}));
vi.mock("node:fs", async (original) => {
  const fs = await original<typeof import("node:fs")>();
  return {
    ...fs,
    openSync(...args: Parameters<typeof fs.openSync>) {
      probe.opens.push(String(args[0]));
      const fd = fs.openSync(...args);
      probe.handles.add(fd);
      return fd;
    },
    closeSync(fd: number) {
      probe.handles.delete(fd);
      return fs.closeSync(fd);
    },
    fsyncSync(fd: number) {
      fs.fsyncSync(fd);
      const hook = probe.afterFlush;
      probe.afterFlush = undefined;
      hook?.();
    },
  };
});
vi.mock("node:child_process", async (original) => {
  const child = await original<typeof import("node:child_process")>();
  const fs = await import("node:fs");
  const path = await import("node:path");
  const { EventEmitter } = await import("node:events");
  const execute = (_file: string, _args: string[], options: { env: NodeJS.ProcessEnv }) => {
    // Windows PowerShell probes execution policy in %TEMP% at startup and cleans up on exit.
    // Use real create/delete operations above the private parent; no frozen filesystem stamps.
    const probes = probe.policyTemp
      ? ["ps1", "psm1"].map((ext) =>
          path.join(probe.policyTemp, `__PSScriptPolicyTest_${++probe.policyProbes}.${ext}`),
        )
      : [];
    for (const p of probes) fs.writeFileSync(p, "policy probe", { flag: "wx", mode: 0o600 });
    try {
      const env = options.env;
      const action = env.ANT0_PRIVATE_ACTION ?? (env.ANT0_PRIVATE_SOURCE ? "move" : "flush");
      probe.calls.push(action);
      if (action === "move") {
        fs.linkSync(env.ANT0_PRIVATE_SOURCE!, env.ANT0_PRIVATE_TARGET!);
        fs.unlinkSync(env.ANT0_PRIVATE_SOURCE!);
      } else if (action !== "flush") {
        const targets: string[] =
          action === "batch" ? JSON.parse(env.ANT0_PRIVATE_FILE!) : [env.ANT0_PRIVATE_FILE!];
        const check = (p: string, acl: boolean) => {
          const stat = fs.lstatSync(p);
          if (stat.isSymbolicLink() || (acl && ((stat.mode & 0o077) !== 0 || probe.deny)))
            throw new Error("ACL/reparse oracle rejected");
        };
        for (const target of targets) {
          if (action === "private") fs.chmodSync(target, 0o600);
          if (action !== "parents") check(target, true);
          if (action === "all" || action === "parents" || action === "batch") {
            let p = path.dirname(target);
            check(p, true);
            for (;;) {
              check(p, false);
              if (p === path.parse(p).root) break;
              p = path.dirname(p);
            }
          }
        }
        const hook = probe.beforeCheck;
        probe.beforeCheck = undefined;
        hook?.();
      }
      return Buffer.alloc(0);
    } finally {
      for (const p of probes) fs.unlinkSync(p);
    }
  };
  return {
    ...child,
    execFileSync: execute,
    execFile(
      file: string,
      args: string[],
      options: { env: NodeJS.ProcessEnv; signal: AbortSignal },
    ) {
      const process = new EventEmitter();
      setImmediate(() => {
        try {
          execute(file, args, options);
          const hook = probe.afterAsyncCheck;
          probe.afterAsyncCheck = undefined;
          hook?.();
          process.emit("close", options.signal.aborted ? 1 : 0);
        } catch {
          process.emit("close", 1);
        }
      });
      return process;
    },
  };
});
import {
  assertCredentialUnchanged,
  assertCredentialUnchangedAsync,
  flushCredentialBeforeSubmission,
  readCredentialFile,
  saveCredentialFile,
  withCredentialLock,
} from "../src/credential-file.js";
import { readyFile } from "./key-helpers.js";

const homes: string[] = [];
beforeEach(() => {
  vi.stubGlobal("process", { ...process, platform: "win32" });
  probe.calls = [];
  probe.afterFlush = undefined;
  probe.beforeCheck = undefined;
  probe.afterAsyncCheck = undefined;
  probe.deny = false;
  probe.opens = [];
  probe.policyTemp = "";
  probe.policyProbes = 0;
});
afterEach(() => {
  vi.unstubAllGlobals();
  for (const home of homes.splice(0)) rmSync(home, { recursive: true, force: true });
  expect(probe.handles.size).toBe(0);
});
function fixture() {
  const temp = mkdtempSync(join(tmpdir(), "ant0-validation-temp-"));
  homes.push(temp);
  probe.policyTemp = temp;
  const home = join(temp, "private");
  mkdirSync(home, { mode: 0o700 });
  return { home, path: join(home, "key.json"), ready: readyFile() };
}
it("profiles Windows subprocess boundaries for publication, confirmation and replay", async () => {
  const { path, ready } = fixture();
  const counts: Record<string, number> = {};
  const measure = <T>(name: string, fn: () => T): T => {
    const before = probe.calls.length;
    const result = fn();
    counts[name] = probe.calls.length - before;
    return result;
  };
  await withCredentialLock(path, async () => {
    const pending = measure("publish", () =>
      saveCredentialFile(path, { ...ready, phase: "pending", key: null }),
    );
    measure("preSubmit", () => flushCredentialBeforeSubmission(pending).close());
    measure("confirm", () => saveCredentialFile(path, ready, pending));
    const saved = measure("readReplay", () => readCredentialFile(path));
    measure("replaySubmit", () => flushCredentialBeforeSubmission(saved).close());
    measure("replaySave", () => saveCredentialFile(path, ready, saved));
  });
  // Baseline before operation-local leases/batching: 15/13/59/9/16/41, plus the
  // CLI's now-redundant pre-save assertions (6 for initial provision, 9 for replay).
  expect(counts).toEqual({
    publish: 6,
    preSubmit: 2,
    confirm: 8,
    readReplay: 1,
    replaySubmit: 2,
    replaySave: 3,
  });
  expect(readCredentialFile(path).value).toEqual(ready);
  expect(probe.policyProbes).toBeGreaterThan(0);
});
it.each([
  "file ACL",
  "parent ACL",
  "file ChangeTime",
  "parent ChangeTime",
  "identical replacement",
  "bytes",
])("rejects %s mutation during the durability boundary", (kind) => {
  const { home, path, ready } = fixture();
  const saved = saveCredentialFile(path, ready);
  let stampOnly = false;
  probe.afterFlush = () => {
    if (kind === "file ACL") chmodSync(path, 0o644);
    if (kind === "parent ACL") chmodSync(home, 0o755);
    if (kind === "file ChangeTime" || kind === "parent ChangeTime") {
      const target = kind === "file ChangeTime" ? path : home;
      const before = statSync(target, { bigint: true });
      chmodSync(target, Number(before.mode & 0o777n));
      const after = statSync(target, { bigint: true });
      stampOnly =
        after.mtimeNs === before.mtimeNs &&
        after.mode === before.mode &&
        after.ctimeNs !== before.ctimeNs;
      probe.deny = true; // models a changed DACL: invisible to POSIX mode/mtime on Windows
    }
    if (kind === "bytes")
      writeFileSync(path, Buffer.concat([readFileSync(path), Buffer.from(" \n")]));
    if (kind === "identical replacement") {
      const replacement = join(home, "replacement");
      const before = statSync(path);
      writeFileSync(replacement, readFileSync(path), { mode: 0o600 });
      utimesSync(replacement, before.atime, before.mtime);
      renameSync(replacement, path);
    }
  };
  expect(() => flushCredentialBeforeSubmission(saved)).toThrow();
  if (kind.endsWith("ChangeTime")) expect(stampOnly).toBe(true);
});
it("does not carry permission trust into a later operation", () => {
  const { path, ready } = fixture();
  const saved = saveCredentialFile(path, ready);
  expect(readCredentialFile(path).value).toEqual(ready);
  probe.deny = true;
  expect(() => assertCredentialUnchanged(saved)).toThrow();
});
it("does not certify a permission mutation during the batched ACL check", () => {
  const { path, ready } = fixture();
  saveCredentialFile(path, ready);
  probe.beforeCheck = () => chmodSync(path, 0o644);
  expect(() => readCredentialFile(path)).toThrow();
});
it.each(["ACL", "symlink", "directory", "oversized file"])(
  "rejects an unsafe %s before opening a new file handle",
  (kind) => {
    const { home, path, ready } = fixture();
    saveCredentialFile(path, ready);
    probe.opens = [];
    if (kind === "ACL") probe.deny = true;
    if (kind === "oversized file") writeFileSync(path, "x".repeat(65537));
    if (kind === "symlink" || kind === "directory") {
      const moved = join(home, "moved");
      renameSync(path, moved);
      if (kind === "symlink") symlinkSync(moved, path);
      else mkdirSync(path, { mode: 0o700 });
    }
    expect(() => readCredentialFile(path)).toThrow();
    expect(probe.opens).toEqual([]);
  },
);
it("bounds retries when the inspected parent keeps changing", () => {
  const { home, path, ready } = fixture();
  saveCredentialFile(path, ready);
  probe.calls = [];
  let changes = 0;
  const change = () => {
    // Force a distinct stamp even when multiple syscalls share the filesystem's clock tick.
    utimesSync(home, new Date(), new Date(++changes * 1000));
    probe.beforeCheck = change;
  };
  probe.beforeCheck = change;
  expect(() => readCredentialFile(path)).toThrow();
  expect(probe.calls).toEqual(["all", "all", "all"]);
});
it("rejects an ancestor replaced with a reparse path during durability", () => {
  const { home, ready } = fixture();
  const nested = join(home, "nested");
  mkdirSync(nested, { mode: 0o700 });
  const path = join(nested, "key.json");
  const saved = saveCredentialFile(path, ready);
  probe.afterFlush = () => {
    const moved = `${home}-moved`;
    renameSync(home, moved);
    homes.push(moved);
    symlinkSync(moved, home, "dir");
  };
  expect(() => flushCredentialBeforeSubmission(saved)).toThrow();
});
it("rechecks a changed parent but permits unrelated concurrent publication", () => {
  const { home, path, ready } = fixture();
  const saved = saveCredentialFile(path, ready);
  probe.calls = [];
  probe.afterFlush = () => writeFileSync(join(home, "unrelated"), "other", { mode: 0o600 });
  flushCredentialBeforeSubmission(saved).close();
  expect(probe.calls.filter((action) => action === "flush")).toHaveLength(1);
  expect(probe.calls.slice(probe.calls.indexOf("flush") + 1)).toContain("all");
});
it.each(["receipt ACL", "receipt bytes", "receipt replacement"])(
  "rejects %s changes during source flush",
  (kind) => {
    const { home, path, ready } = fixture();
    const pending = saveCredentialFile(path, { ...ready, phase: "pending", key: null });
    const saved = saveCredentialFile(path, ready, pending);
    const receipt = `${path}.result.json`;
    probe.afterFlush = () => {
      if (kind === "receipt ACL") chmodSync(receipt, 0o644);
      if (kind === "receipt bytes")
        writeFileSync(receipt, Buffer.concat([readFileSync(receipt), Buffer.from(" \n")]));
      if (kind === "receipt replacement") {
        const replacement = join(home, "replacement");
        writeFileSync(replacement, readFileSync(receipt), { mode: 0o600 });
        renameSync(replacement, receipt);
      }
    };
    expect(() => flushCredentialBeforeSubmission(saved)).toThrow();
  },
);

function asyncFixture() {
  const f = fixture();
  const pending = saveCredentialFile(f.path, { ...f.ready, phase: "pending", key: null });
  const saved = saveCredentialFile(f.path, f.ready, pending);
  probe.calls = [];
  return { ...f, saved };
}
it("async validation tolerates helper policy-file churn and checks afresh on the next call", async () => {
  const { saved } = asyncFixture();
  const signal = new AbortController().signal;
  await expect(assertCredentialUnchangedAsync(saved, signal)).resolves.toBeUndefined();
  expect(probe.calls).toEqual(["batch"]);
  probe.deny = true;
  await expect(assertCredentialUnchangedAsync(saved, signal)).rejects.toThrow();
  expect(probe.calls).toEqual(["batch", "batch"]);
});
it.each(["parent ACL", "parent ChangeTime", "source", "receipt", "higher reparse"])(
  "async %s mutation after the ACL proof and before child close is rejected",
  async (kind) => {
    const { home, path, saved } = asyncFixture();
    let mutated = false;
    let stampOnly = false;
    probe.afterAsyncCheck = () => {
      if (kind === "parent ACL") chmodSync(home, 0o755);
      if (kind === "parent ChangeTime") {
        const before = statSync(home, { bigint: true });
        chmodSync(home, 0o700);
        const after = statSync(home, { bigint: true });
        stampOnly =
          before.mode === after.mode &&
          before.mtimeNs === after.mtimeNs &&
          before.ctimeNs !== after.ctimeNs;
        probe.deny = true;
      }
      if (kind === "source") chmodSync(path, 0o644);
      if (kind === "receipt") chmodSync(`${path}.result.json`, 0o644);
      if (kind === "higher reparse") {
        const ancestor = dirname(home);
        const moved = `${ancestor}-moved`;
        renameSync(ancestor, moved);
        homes.push(moved);
        symlinkSync(moved, ancestor, "dir");
      }
      mutated = true;
    };
    await expect(
      assertCredentialUnchangedAsync(saved, new AbortController().signal),
    ).rejects.toThrow();
    expect(mutated).toBe(true);
    if (kind === "parent ChangeTime") expect(stampOnly).toBe(true);
    if (kind.startsWith("parent")) expect(probe.calls).toEqual(["batch", "batch"]);
  },
);
it("async private-parent content changes require fresh inspection, then may succeed", async () => {
  const { home, saved } = asyncFixture();
  probe.afterAsyncCheck = () => writeFileSync(join(home, "unrelated"), "other", { mode: 0o600 });
  await expect(
    assertCredentialUnchangedAsync(saved, new AbortController().signal),
  ).resolves.toBeUndefined();
  expect(probe.calls).toEqual(["batch", "batch"]);
});
it("async private-parent changes cannot cause unbounded reinspection", async () => {
  const { home, saved } = asyncFixture();
  let changes = 0;
  const change = () => {
    utimesSync(home, new Date(), new Date(++changes * 1000));
    probe.afterAsyncCheck = change;
  };
  probe.afterAsyncCheck = change;
  await expect(
    assertCredentialUnchangedAsync(saved, new AbortController().signal),
  ).rejects.toThrow();
  expect(probe.calls).toEqual(["batch", "batch", "batch"]);
});
