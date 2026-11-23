import { createHash, randomBytes, randomUUID } from "node:crypto";
import { execFile, execFileSync } from "node:child_process";
import {
  closeSync,
  constants,
  fsyncSync,
  fstatSync as nativeFstatSync,
  linkSync,
  lstatSync as nativeLstatSync,
  openSync,
  readSync,
  readdirSync,
  unlinkSync,
  writeFileSync,
  type BigIntStats as Stats,
} from "node:fs";
import { dirname, join, parse, resolve } from "node:path";
import {
  CredentialFailure,
  credentialFileSchema,
  matchingMetadata,
  credentialResultSchema,
  rejectCredentialEcho,
  type CredentialFile,
  type KeyMetadata,
} from "./key-contract.js";

export * from "./key-contract.js";
const MAX_BYTES = 64 * 1024;
// File IDs can exceed JavaScript's safe-integer range on Windows. Preserve their exact bits.
const lstatSync = (path: string) => nativeLstatSync(path, { bigint: true });
const fstatSync = (fd: number) => nativeFstatSync(fd, { bigint: true });
const fail = () => new CredentialFailure();
const same = (a: Stats, b: Stats) =>
  a.dev === b.dev &&
  a.ino === b.ino &&
  a.nlink === b.nlink &&
  a.mode === b.mode &&
  a.uid === b.uid &&
  a.gid === b.gid &&
  a.size === b.size &&
  a.mtimeNs === b.mtimeNs &&
  a.ctimeNs === b.ctimeNs;

// Higher ancestors have an identity/reparse policy, not a private-ACL policy. Their content
// timestamps can change on every PowerShell startup (__PSScriptPolicyTest_* in %TEMP%).
// Files and the immediate private parent retain the complete permission/ChangeTime fence.
const sameBoundary = (a: Stats, b: Stats, privateAcl: boolean) =>
  privateAcl
    ? same(a, b)
    : a.dev === b.dev &&
      a.ino === b.ino &&
      a.isDirectory() &&
      b.isDirectory() &&
      !a.isSymbolicLink() &&
      !b.isSymbolicLink();

function parentEvidence(file: string): { path: string; stat: Stats; privateAcl: boolean }[] {
  const result = [];
  for (let path = dirname(file); ; path = dirname(path)) {
    const stat = lstatSync(path);
    if (!stat.isDirectory() || stat.isSymbolicLink() || result.length >= 256) throw fail();
    result.push({ path, stat, privateAcl: path === dirname(file) });
    if (path === parse(path).root) return result;
  }
}
function sameParents(
  before: ReturnType<typeof parentEvidence>,
  after: ReturnType<typeof parentEvidence>,
): boolean {
  return (
    before.length === after.length &&
    before.every(
      (value, i) =>
        value.path === after[i]!.path && sameBoundary(value.stat, after[i]!.stat, value.privateAcl),
    )
  );
}

// Never interpolate file paths or secrets into a shell command. Fail closed if ACL inspection is
// unavailable. Ancestors are checked for reparse points separately, including junctions.
const WINDOWS_ACL_SCRIPT = `
$ErrorActionPreference = 'Stop'
$p = $env:ANT0_PRIVATE_FILE
function Test-Private($p, $action) {
$item = Get-Item -LiteralPath $p -Force
if (($item.Attributes -band [IO.FileAttributes]::ReparsePoint) -ne 0) { throw 'reparse' }
if ($action -eq 'ancestor') { return }
$sid = [Security.Principal.WindowsIdentity]::GetCurrent().User
if ($action -eq 'private') {
  $acl = if ($item.PSIsContainer) { New-Object Security.AccessControl.DirectorySecurity } else { New-Object Security.AccessControl.FileSecurity }
  $acl.SetOwner($sid)
  $acl.SetAccessRuleProtection($true, $false)
  $rule = New-Object Security.AccessControl.FileSystemAccessRule($sid, 'FullControl', 'Allow')
  $acl.AddAccessRule($rule)
  $system = New-Object Security.Principal.SecurityIdentifier('S-1-5-18')
  $acl.AddAccessRule((New-Object Security.AccessControl.FileSystemAccessRule($system, 'FullControl', 'Allow')))
  Set-Acl -LiteralPath $p -AclObject $acl
}
$acl = Get-Acl -LiteralPath $p
if ($acl.GetOwner([Security.Principal.SecurityIdentifier]).Value -ne $sid.Value -or !$acl.AreAccessRulesProtected) { throw 'owner' }
$rules = $acl.GetAccessRules($true, $true, [Security.Principal.SecurityIdentifier])
$ownerAllow = $false
$systemAllow = $false
if ($rules.Count -ne 2) { throw 'access' }
foreach ($r in $rules) {
  if ($r.AccessControlType -ne 'Allow' -or $r.IsInherited) { throw 'access' }
  $full = [int][Security.AccessControl.FileSystemRights]::FullControl
  if (([int]$r.FileSystemRights -band $full) -ne $full) { throw 'access' }
  if ($r.IdentityReference.Value -eq $sid.Value) { $ownerAllow = $true }
  elseif ($r.IdentityReference.Value -eq 'S-1-5-18') { $systemAllow = $true }
  else { throw 'access' }
}
if (!$ownerAllow -or !$systemAllow) { throw 'access' }
}
if ($env:ANT0_PRIVATE_ACTION -eq 'batch' -or $env:ANT0_PRIVATE_ACTION -eq 'all' -or $env:ANT0_PRIVATE_ACTION -eq 'parents') {
 $paths = if ($env:ANT0_PRIVATE_ACTION -eq 'batch') { @($p | ConvertFrom-Json) } else { @($p) }
 foreach ($path in $paths) {
  if ($env:ANT0_PRIVATE_ACTION -ne 'parents') { Test-Private $path 'check' }
  $parent = [IO.Path]::GetDirectoryName($path)
  Test-Private $parent 'check'
  while ($parent) {
    Test-Private $parent 'ancestor'
    $parent = [IO.Path]::GetDirectoryName($parent)
  }
 }
} else { Test-Private $p $env:ANT0_PRIVATE_ACTION }
`;
type AclAction = "check" | "private" | "all" | "parents" | "batch";
function windowsAcl(file: string, action: AclAction, validation?: WindowsValidation): void {
  if (validation) return validation.check(file, action);
  try {
    execFileSync(
      join(
        process.env.SystemRoot ?? "C:\\Windows",
        "System32",
        "WindowsPowerShell",
        "v1.0",
        "powershell.exe",
      ),
      ["-NoLogo", "-NoProfile", "-NonInteractive", "-Command", WINDOWS_ACL_SCRIPT],
      {
        env: { ...process.env, ANT0_PRIVATE_FILE: file, ANT0_PRIVATE_ACTION: action },
        stdio: ["ignore", "ignore", "ignore"],
        timeout: 10_000,
        windowsHide: true,
      },
    );
  } catch {
    throw fail();
  }
}

/** Only a synchronous logical operation owns this lease. Every reuse lstats the parent chain;
 * files and the private parent retain full stamps, higher ancestors retain identity/type checks.
 * All ancestors receive native reparse inspection in the ACL batch. Nothing survives an await. */
class WindowsValidation {
  private readonly checked = new Map<string, { stat: Stats; acl: boolean }>();
  private readonly handles = new Map<string, number>();

  check(file: string, action: AclAction): void {
    if (action === "private") {
      this.checked.delete(file);
      windowsAcl(file, action);
      return;
    }
    if (action === "batch") throw fail(); // batches enter through typed paths, not caller JSON
    this.checkPaths([file], action === "parents");
  }

  checkFiles(files: string[]): void {
    if (files.length < 1 || files.length > 2) throw fail();
    this.checkPaths(files, false);
  }

  private checkPaths(files: string[], parentsOnly: boolean): void {
    // Inspect a file and its entire parent chain in one subprocess, rather than starting
    // separate processes for directories(), regular() and stableParent().
    const checks = new Map<string, boolean>();
    for (const file of files) {
      if (!parentsOnly) checks.set(file, true);
      let path = dirname(file);
      for (;;) {
        checks.set(path, checks.get(path) === true || path === dirname(file));
        if (path === parse(path).root) break;
        path = dirname(path);
      }
    }
    const paths = [...checks].map(([path, acl]) => ({ path, acl }));
    if (paths.length > 256) throw fail();
    for (let attempt = 0; attempt < 3; attempt++) {
      const before = paths.map(({ path }) => lstatSync(path));
      paths.forEach(({ path }, i) => {
        if (!parentsOnly && files.includes(path)) regular(path, before[i]!, false, true);
        else if (!before[i]!.isDirectory() || before[i]!.isSymbolicLink()) throw fail();
      });
      for (const file of parentsOnly ? [] : files) {
        const stat = before[paths.findIndex(({ path }) => path === file)]!;
        const fd = this.handles.get(file);
        if (fd !== undefined && !same(fstatSync(fd), stat)) {
          closeSync(fd);
          this.handles.delete(file);
        }
      }
      const unchanged = () =>
        paths.every(({ path, acl }, i) => sameBoundary(before[i]!, lstatSync(path), acl)) &&
        (parentsOnly ||
          files.every(
            (file) =>
              !this.handles.has(file) ||
              same(
                before[paths.findIndex(({ path }) => path === file)]!,
                fstatSync(this.handles.get(file)!),
              ),
          ));
      if (
        (parentsOnly || files.every((file) => this.handles.has(file))) &&
        paths.every(({ path, acl }, i) => {
          const previous = this.checked.get(path);
          return previous && (!acl || previous.acl) && sameBoundary(previous.stat, before[i]!, acl);
        }) &&
        unchanged()
      )
        return;
      windowsAcl(
        files.length === 1 ? files[0]! : JSON.stringify(files),
        parentsOnly ? "parents" : files.length === 1 ? "all" : "batch",
      );
      // A concurrent publication can change directory ChangeTime. Retry inspection, never
      // associate an ACL result with a different stamp or ignore the changed permission state.
      if (!unchanged()) continue;
      // New paths must pass ACL/reparse inspection before opening. Bind that result to a
      // live descriptor only if the file and complete chain still have the inspected stamps.
      for (const file of parentsOnly ? [] : files) {
        if (!this.handles.has(file)) {
          if (this.handles.size >= 256) throw fail();
          this.handles.set(
            file,
            openSync(file, constants.O_RDONLY | constants.O_NONBLOCK | (constants.O_NOFOLLOW ?? 0)),
          );
        }
      }
      if (!unchanged()) throw fail();
      paths.forEach(({ path, acl }, i) => {
        if (this.checked.size >= 256 && !this.checked.has(path)) throw fail();
        this.checked.set(path, { stat: before[i]!, acl });
      });
      return;
    }
    throw fail();
  }

  close(): void {
    for (const fd of this.handles.values()) closeSync(fd);
    this.handles.clear();
    this.checked.clear();
  }
}
function withValidation<T>(operation: (validation?: WindowsValidation) => T): T {
  const validation = process.platform === "win32" ? new WindowsValidation() : undefined;
  try {
    return operation(validation);
  } finally {
    validation?.close();
  }
}

function directories(file: string, checkAcl = true, validation?: WindowsValidation): Stats {
  let path = dirname(file);
  let parent: Stats | undefined;
  const immediate = path;
  for (;;) {
    const stat = lstatSync(path);
    if (!stat.isDirectory() || stat.isSymbolicLink()) throw fail();
    if (process.platform === "win32") {
      /* Batch ACL/reparse inspection after collecting identity. */
    } else {
      const uid = BigInt(process.getuid!());
      if (path === immediate) {
        if (stat.uid !== uid || (stat.mode & 0o077n) !== 0n) throw fail();
      } else if (
        (stat.uid !== uid && stat.uid !== 0n) ||
        ((stat.mode & 0o022n) !== 0n && !(stat.uid === 0n && (stat.mode & 0o1000n) !== 0n))
      )
        throw fail();
    }
    parent ??= stat;
    if (path === parse(path).root) {
      if (process.platform === "win32" && checkAcl) windowsAcl(file, "parents", validation);
      return parent;
    }
    path = dirname(path);
  }
}
function regular(
  file: string,
  stat: Stats,
  checkAcl = true,
  allowTwo = false,
  validation?: WindowsValidation,
): void {
  if (
    !stat.isFile() ||
    stat.isSymbolicLink() ||
    (stat.nlink !== 1n && !(allowTwo && stat.nlink === 2n)) ||
    stat.size > BigInt(MAX_BYTES)
  )
    throw fail();
  if (process.platform === "win32") {
    if (checkAcl) windowsAcl(file, "check", validation);
  } else if (stat.uid !== BigInt(process.getuid!()) || (stat.mode & 0o077n) !== 0n) throw fail();
}
function stableParent(
  file: string,
  parent: Stats,
  checkAcl = true,
  validation?: WindowsValidation,
) {
  const now = directories(file, checkAcl, validation);
  if (now.dev !== parent.dev || now.ino !== parent.ino) throw fail();
}
interface PublishedSnapshot {
  path: string;
  stat: Stats;
  parent: Stats;
  text: string;
  bytes: Buffer;
}
export interface CredentialSnapshot extends PublishedSnapshot {
  /** Original bytes and decoded document never change when a receipt supplies a ready view. */
  rawValue: CredentialFile;
  value: CredentialFile;
  receipt?: PublishedSnapshot;
}
function readRaw(
  file: string,
  checkAcl = true,
  allowTwo = false,
  validation?: WindowsValidation,
): PublishedSnapshot {
  let fd: number | undefined;
  const path = resolve(file);
  try {
    const parent = directories(path, process.platform === "win32" ? false : checkAcl, validation);
    const stat = lstatSync(path);
    if (process.platform === "win32" && checkAcl) windowsAcl(path, "all", validation);
    regular(path, stat, false, allowTwo);
    fd = openSync(path, constants.O_RDONLY | constants.O_NONBLOCK | (constants.O_NOFOLLOW ?? 0));
    const opened = fstatSync(fd);
    if (!same(stat, opened)) throw fail();
    const buffer = Buffer.alloc(MAX_BYTES + 1);
    let size = 0;
    while (size < buffer.length) {
      const n = readSync(fd, buffer, size, buffer.length - size, null);
      if (!n) break;
      size += n;
    }
    if (size > MAX_BYTES || !same(opened, fstatSync(fd)) || !same(opened, lstatSync(path)))
      throw fail();
    stableParent(path, parent, checkAcl, validation);
    if (!same(opened, fstatSync(fd)) || !same(opened, lstatSync(path))) throw fail();
    const bytes = buffer.subarray(0, size);
    const text = new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(bytes);
    return { path, stat: opened, parent, text, bytes };
  } finally {
    if (fd !== undefined) closeSync(fd);
  }
}
const UUID = "[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}";
const RESERVED = new RegExp(
  `^\\.ant0-key-publish-v1\\.(credential|result)\\.(${UUID})\\.(${UUID})\\.tmp$`,
);
const digest = (source: PublishedSnapshot) =>
  createHash("sha256").update(source.bytes).digest("hex");
const sameObject = (a: PublishedSnapshot, b: PublishedSnapshot) =>
  a.stat.dev === b.stat.dev &&
  a.stat.ino === b.stat.ino &&
  a.parent.dev === b.parent.dev &&
  a.parent.ino === b.parent.ino &&
  a.bytes.equals(b.bytes);
function absent(path: string): boolean {
  try {
    lstatSync(path);
    return false;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return true;
    throw error;
  }
}
function readPublished(
  path: string,
  kind: "credential" | "result",
  validate: (raw: PublishedSnapshot) => string,
  checkAcl = true,
  validation?: WindowsValidation,
): PublishedSnapshot {
  let raw: PublishedSnapshot | undefined;
  for (let attempt = 0; attempt < 3; attempt++) {
    try {
      raw = readRaw(path, checkAcl, true, validation);
      break;
    } catch (error) {
      if (attempt === 2) throw error;
    }
  }
  if (!raw) throw fail();
  const original = raw;
  const id = validate(raw);
  if (raw.stat.nlink === 1n) return raw;
  const normalized = () => {
    const current = readRaw(path, checkAcl, false, validation);
    if (!sameObject(original, current) || validate(current) !== id) throw fail();
    pinRaw(current, validation).close();
    const final = readRaw(path, checkAcl, false, validation);
    if (!sameObject(original, final) || validate(final) !== id) throw fail();
    return final;
  };
  const names = readdirSync(dirname(path));
  if (names.length > 16_384) throw fail();
  const aliases: string[] = [];
  for (const name of names) {
    const match = RESERVED.exec(name);
    if (!match || match[1] !== kind || match[2] !== id) continue;
    const alias = join(dirname(path), name);
    try {
      const stat = lstatSync(alias);
      if (stat.dev === raw.stat.dev && stat.ino === raw.stat.ino) aliases.push(alias);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    }
  }
  if (aliases.length === 0) return normalized(); // a concurrent publisher may have removed its alias
  if (aliases.length !== 1) throw fail();
  const alias = aliases[0]!;
  try {
    const candidate = readRaw(alias, checkAcl, true, validation);
    if (!sameObject(raw, candidate) || validate(candidate) !== id) throw fail();
    const current = readRaw(path, checkAcl, true, validation);
    if (
      !same(current.stat, raw.stat) ||
      !sameObject(raw, current) ||
      !same(lstatSync(alias), candidate.stat)
    )
      throw fail();
    unlinkSync(alias);
  } catch (error) {
    if (!absent(alias)) throw error;
    return normalized();
  }
  return normalized();
}
function parseOriginal(raw: PublishedSnapshot): CredentialFile {
  const parsed = credentialFileSchema.safeParse(JSON.parse(raw.text));
  if (!parsed.success) throw fail();
  if (parsed.data.key) rejectCredentialEcho(parsed.data.key, parsed.data.create.credential);
  return parsed.data;
}
function parseReceipt(
  raw: PublishedSnapshot,
  original: CredentialFile,
  source: PublishedSnapshot,
): KeyMetadata {
  const parsed = credentialResultSchema.safeParse(JSON.parse(raw.text));
  if (
    !parsed.success ||
    parsed.data.credential_file_sha256 !== digest(source) ||
    !matchingMetadata(original, parsed.data.key)
  )
    throw fail();
  rejectCredentialEcho(parsed.data.key, original.create.credential);
  return parsed.data.key;
}
function readSnapshot(
  file: string,
  checkAcl = true,
  validation?: WindowsValidation,
): CredentialSnapshot {
  const path = resolve(file);
  const receiptPath = `${path}.result.json`;
  if (checkAcl && validation)
    validation.checkFiles([path, ...(!absent(receiptPath) ? [receiptPath] : [])]);
  const raw = readPublished(
    path,
    "credential",
    (value) => parseOriginal(value).create.id,
    checkAcl,
    validation,
  );
  const original = parseOriginal(raw);
  let receipt: PublishedSnapshot | undefined;
  let value = original;
  if (!absent(receiptPath)) {
    receipt = readPublished(
      receiptPath,
      "result",
      (r) => {
        parseReceipt(r, original, raw);
        return original.create.id;
      },
      checkAcl,
      validation,
    );
    const key = parseReceipt(receipt, original, raw);
    if (original.phase === "pending") value = { ...original, phase: "ready", key };
  }
  compareRaw(raw, readRaw(path, checkAcl, false, validation));
  return { ...raw, rawValue: original, value, ...(receipt ? { receipt } : {}) };
}
export function readCredentialFile(file: string): CredentialSnapshot {
  try {
    return withValidation((validation) => readSnapshot(file, true, validation));
  } catch {
    throw fail();
  }
}
export function assertCredentialUnchanged(snapshot: CredentialSnapshot): void {
  const current = readCredentialFile(snapshot.path);
  compareSnapshot(snapshot, current);
}

/** Re-establish durability even after a failed fsync or killed writer. Pin the file through
 * dispatch (also its parent on POSIX); syncing the lock is not credential durability. */
export function flushCredentialBeforeSubmission(snapshot: CredentialSnapshot): { close(): void } {
  return withValidation((validation) => {
    compareSnapshot(snapshot, readSnapshot(snapshot.path, true, validation));
    const pinned = pinRaw(snapshot, validation);
    try {
      compareSnapshot(snapshot, readSnapshot(snapshot.path, true, validation));
      return pinned;
    } catch (error) {
      pinned.close();
      throw error;
    }
  });
}
function pinRaw(snapshot: PublishedSnapshot, validation?: WindowsValidation): { close(): void } {
  let file: number | undefined;
  let parent: number | undefined;
  const close = () => {
    if (file !== undefined) {
      closeSync(file);
      file = undefined;
    }
    if (parent !== undefined) {
      closeSync(parent);
      parent = undefined;
    }
  };
  try {
    compareRaw(snapshot, readRaw(snapshot.path, true, false, validation));
    file = openSync(
      snapshot.path,
      constants.O_RDWR | constants.O_NONBLOCK | (constants.O_NOFOLLOW ?? 0),
    );
    if (!same(fstatSync(file), snapshot.stat)) throw fail();
    if (process.platform !== "win32") {
      parent = openSync(
        dirname(snapshot.path),
        constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW,
      );
      const stat = fstatSync(parent);
      if (stat.dev !== snapshot.parent.dev || stat.ino !== snapshot.parent.ino) throw fail();
    }
    fsyncSync(file);
    if (parent !== undefined) fsyncSync(parent);
    else flushWindowsParent(snapshot.path);
    if (!same(fstatSync(file), snapshot.stat)) throw fail();
    compareRaw(snapshot, readRaw(snapshot.path, true, false, validation));
    return { close };
  } catch {
    close();
    throw new CredentialFailure("private credential durability unavailable");
  }
}

function flushWindowsParent(path: string): void {
  const script = `
$ErrorActionPreference='Stop'
Add-Type -TypeDefinition @'
using System;
using System.Runtime.InteropServices;
public static class Ant0Durability {
 [DllImport("kernel32.dll",CharSet=CharSet.Unicode,SetLastError=true)] public static extern IntPtr CreateFile(string p,uint access,uint share,IntPtr sa,uint mode,uint flags,IntPtr template);
 [DllImport("kernel32.dll",SetLastError=true)] public static extern bool FlushFileBuffers(IntPtr h);
 [DllImport("kernel32.dll")] public static extern bool CloseHandle(IntPtr h);
}
'@
$h=[Ant0Durability]::CreateFile($env:ANT0_PRIVATE_PARENT,0x40000000,3,[IntPtr]::Zero,3,0x02200000,[IntPtr]::Zero)
if ($h -eq [IntPtr](-1)) { throw 'open' }
try { if (![Ant0Durability]::FlushFileBuffers($h)) { throw 'flush' } }
finally { [void][Ant0Durability]::CloseHandle($h) }
`;
  try {
    execFileSync(
      join(
        process.env.SystemRoot ?? "C:\\Windows",
        "System32",
        "WindowsPowerShell",
        "v1.0",
        "powershell.exe",
      ),
      ["-NoLogo", "-NoProfile", "-NonInteractive", "-Command", script],
      {
        env: { ...process.env, ANT0_PRIVATE_PARENT: dirname(path) },
        stdio: "ignore",
        timeout: 10_000,
        windowsHide: true,
      },
    );
  } catch {
    throw fail();
  }
}
function compareRaw(snapshot: PublishedSnapshot, current: PublishedSnapshot) {
  if (
    !same(current.stat, snapshot.stat) ||
    current.text !== snapshot.text ||
    current.parent.dev !== snapshot.parent.dev ||
    current.parent.ino !== snapshot.parent.ino
  )
    throw new CredentialFailure("private credential file changed");
}
function compareSnapshot(snapshot: CredentialSnapshot, current: CredentialSnapshot) {
  compareRaw(snapshot, current);
  if (snapshot.receipt) {
    if (!current.receipt) throw fail();
    compareRaw(snapshot.receipt, current.receipt);
  }
  if (
    snapshot.value.key &&
    current.value.key &&
    !matchingMetadata(snapshot.value, current.value.key)
  )
    throw fail();
}

/** ACL checks must not block MCP's ping/EOF/cancellation loop. Keep admission until the child
 * has closed, including on abort; no secret is passed in argv, environment or child output. */
export async function assertCredentialUnchangedAsync(
  snapshot: CredentialSnapshot,
  signal: AbortSignal,
): Promise<void> {
  signal.throwIfAborted();
  if (process.platform !== "win32") {
    assertCredentialUnchanged(snapshot);
    return;
  }
  for (let attempt = 0; attempt < 3; attempt++) {
    signal.throwIfAborted();
    const before = readSnapshot(snapshot.path, false);
    compareSnapshot(snapshot, before);
    const parents = parentEvidence(snapshot.path);
    const paths = [snapshot.path, ...(before.receipt ? [before.receipt.path] : [])];
    await new Promise<void>((resolve, reject) => {
      const child = execFile(
        join(
          process.env.SystemRoot ?? "C:\\Windows",
          "System32",
          "WindowsPowerShell",
          "v1.0",
          "powershell.exe",
        ),
        ["-NoLogo", "-NoProfile", "-NonInteractive", "-Command", WINDOWS_ACL_SCRIPT],
        {
          env: {
            ...process.env,
            ANT0_PRIVATE_FILE: JSON.stringify(paths),
            ANT0_PRIVATE_ACTION: "batch",
          },
          signal,
          timeout: 10_000,
          maxBuffer: 1024,
          windowsHide: true,
        },
      );
      child.on("error", () => {});
      child.on("close", (code) => (code === 0 && !signal.aborted ? resolve() : reject(fail())));
    });
    signal.throwIfAborted();
    const after = readSnapshot(snapshot.path, false);
    if (!before.receipt && after.receipt) throw fail();
    compareSnapshot(before, after);
    const currentParents = parentEvidence(snapshot.path);
    // No proof/cache crosses this await. A private-parent stamp change requires a fresh
    // batch, even if its inode and both immutable files survived. Replacement fails outright.
    if (
      parents.length !== currentParents.length ||
      parents.some(
        (parent, i) =>
          parent.path !== currentParents[i]!.path ||
          !sameBoundary(parent.stat, currentParents[i]!.stat, false),
      )
    )
      throw fail();
    if (sameParents(parents, currentParents)) return;
  }
  throw fail();
}
function syncDirectory(path: string) {
  // Windows publication uses MoveFileEx WRITE_THROUGH after flushing the file itself.
  if (process.platform === "win32") return;
  const fd = openSync(
    dirname(path),
    constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW,
  );
  try {
    fsyncSync(fd);
  } finally {
    closeSync(fd);
  }
}
function windowsPublish(source: string, target: string): void {
  const script = `
$ErrorActionPreference='Stop'
Add-Type -TypeDefinition @'
using System;
using System.Runtime.InteropServices;
public static class Ant0PrivateMove {
  [DllImport("kernel32.dll", CharSet=CharSet.Unicode, SetLastError=true)]
  public static extern bool MoveFileEx(string source, string target, uint flags);
}
'@
$flags = [uint32]8
if (![Ant0PrivateMove]::MoveFileEx($env:ANT0_PRIVATE_SOURCE, $env:ANT0_PRIVATE_TARGET, $flags)) { throw 'move' }
`;
  try {
    execFileSync(
      join(
        process.env.SystemRoot ?? "C:\\Windows",
        "System32",
        "WindowsPowerShell",
        "v1.0",
        "powershell.exe",
      ),
      ["-NoLogo", "-NoProfile", "-NonInteractive", "-Command", script],
      {
        env: {
          ...process.env,
          ANT0_PRIVATE_SOURCE: source,
          ANT0_PRIVATE_TARGET: target,
        },
        stdio: "ignore",
        timeout: 10_000,
        windowsHide: true,
      },
    );
  } catch {
    throw fail();
  }
}
export class CredentialCollision extends CredentialFailure {}

/** Publish bytes once. Collision is never permission to replace a destination. */
function publish(
  path: string,
  kind: "credential" | "result",
  id: string,
  bytes: Buffer,
  beforePublish?: () => void,
  validation?: WindowsValidation,
): boolean {
  const tmp = join(dirname(path), `.ant0-key-publish-v1.${kind}.${id}.${randomUUID()}.tmp`);
  let fd: number | undefined;
  let owned: Stats | undefined;
  try {
    const parent = directories(path, true, validation);
    if (!absent(path)) return false;
    fd = openSync(
      tmp,
      constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | (constants.O_NOFOLLOW ?? 0),
      0o600,
    );
    owned = fstatSync(fd);
    if (process.platform === "win32") windowsAcl(tmp, "private", validation);
    regular(tmp, fstatSync(fd), true, false, validation);
    writeFileSync(fd, bytes);
    fsyncSync(fd);
    const written = fstatSync(fd);
    closeSync(fd);
    fd = undefined;
    const closed = lstatSync(tmp);
    // Windows may finalize last-write times when the final writing handle closes.
    if (written.dev !== closed.dev || written.ino !== closed.ino || written.size !== closed.size)
      throw fail();
    regular(tmp, closed, true, false, validation);
    stableParent(path, parent, true, validation);
    beforePublish?.();
    try {
      if (process.platform === "win32") windowsPublish(tmp, path);
      else linkSync(tmp, path);
    } catch (error) {
      if (
        (error as NodeJS.ErrnoException).code === "EEXIST" ||
        (process.platform === "win32" && !absent(path))
      )
        return false;
      throw error;
    }
    if (process.platform !== "win32") {
      try {
        unlinkSync(tmp);
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
      }
    }
    owned = undefined;
    syncDirectory(path);
    const saved = readRaw(path, true, false, validation);
    if (
      saved.stat.dev !== written.dev ||
      saved.stat.ino !== written.ino ||
      !saved.bytes.equals(bytes)
    )
      throw fail();
    return true;
  } finally {
    if (fd !== undefined) closeSync(fd);
    if (owned) {
      try {
        const current = lstatSync(tmp);
        if (current.dev === owned.dev && current.ino === owned.ino) unlinkSync(tmp);
      } catch {
        /* Only this invocation's private temporary name can be cleaned up. */
      }
    }
  }
}

export function saveCredentialFile(
  file: string,
  value: CredentialFile,
  previous?: CredentialSnapshot,
): CredentialSnapshot {
  return withValidation((validation) => saveValidated(file, value, previous, validation));
}
function saveValidated(
  file: string,
  value: CredentialFile,
  previous?: CredentialSnapshot,
  validation?: WindowsValidation,
): CredentialSnapshot {
  try {
    const path = resolve(file);
    const parsed = credentialFileSchema.safeParse(value);
    if (!parsed.success) throw fail();
    if (parsed.data.key) rejectCredentialEcho(parsed.data.key, parsed.data.create.credential);
    if (!previous) {
      const bytes = Buffer.from(JSON.stringify(parsed.data) + "\n");
      if (!publish(path, "credential", parsed.data.create.id, bytes, undefined, validation))
        throw new CredentialCollision();
      return readSnapshot(path, true, validation);
    }
    if (
      path !== previous.path ||
      parsed.data.phase !== "ready" ||
      !parsed.data.key ||
      JSON.stringify(parsed.data.expected) !== JSON.stringify(previous.rawValue.expected) ||
      JSON.stringify(parsed.data.create) !== JSON.stringify(previous.rawValue.create)
    )
      throw fail();
    let current = readSnapshot(path, true, validation);
    compareSnapshot(previous, current);
    if (!matchingMetadata(current.value, parsed.data.key)) throw fail();
    if (current.rawValue.phase === "pending" && !current.receipt) {
      const receipt = {
        schema: "ant0-api-key-result/v1",
        credential_file_sha256: digest(current),
        key: parsed.data.key,
      };
      publish(
        `${path}.result.json`,
        "result",
        current.rawValue.create.id,
        Buffer.from(JSON.stringify(receipt) + "\n"),
        () => compareSnapshot(previous, readSnapshot(path, true, validation)),
        validation,
      );
      current = readSnapshot(path, true, validation);
      compareSnapshot(previous, current);
      if (!current.receipt || !matchingMetadata(current.value, parsed.data.key)) throw fail();
    }
    pinRaw(current, validation).close();
    if (current.receipt) pinRaw(current.receipt, validation).close();
    compareSnapshot(current, readSnapshot(path, true, validation));
    return current;
  } catch (error) {
    if (error instanceof CredentialCollision) throw error;
    throw fail();
  }
}
export function newCredential(id: string): string {
  return `ant0_sk_v1_${id}_${randomBytes(32).toString("base64url")}`;
}

const localLocks = new Set<string>();
/** Optional in-process convenience only. Correctness rests on create-only publication and replay. */
export async function withCredentialLock<T>(file: string, operation: () => Promise<T>): Promise<T> {
  const path = resolve(file);
  if (localLocks.has(path)) throw new CredentialFailure("private credential file busy");
  try {
    directories(path);
    localLocks.add(path);
    return await operation();
  } finally {
    localLocks.delete(path);
  }
}
