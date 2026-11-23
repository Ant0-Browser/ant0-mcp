import {
  chmodSync,
  closeSync,
  constants,
  fstatSync,
  lstatSync,
  mkdirSync,
  openSync,
  readSync,
  realpathSync,
  readdirSync,
  renameSync,
  unlinkSync,
  writeSync,
} from "node:fs";
import { randomBytes } from "node:crypto";
import { isAbsolute, join, relative, resolve, sep } from "node:path";
import { McpFailure } from "./errors.js";
import { LIMITS } from "./limits.js";

export const EXPORT_TTL_HOURS = 24;

const NAME =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}-\d{8}T\d{6}Z-[0-9a-f]{4}\.(?:json|txt|png)(?:\.tmp)?$/;

/** `<ANT0_HOME>/exports/cookies`. */
export function cookieExportDir(home: string): string {
  return join(home, "exports", "cookies");
}

/** `<ANT0_HOME>/exports/screenshots`. */
export function screenshotExportDir(home: string): string {
  return join(home, "exports", "screenshots");
}

/** `<ANT0_HOME>/imports/cookies`: the only place `ant0_cookies_import` reads files from. */
export function cookieImportDir(home: string): string {
  return join(home, "imports", "cookies");
}

/** Create one of our private leaf directories (0700) and refuse a symlink or non-directory. */
function ensurePrivateDir(dir: string): void {
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  const stat = lstatSync(dir);
  if (!stat.isDirectory() || stat.isSymbolicLink()) throw new McpFailure("configuration");
  chmodSync(dir, 0o700); // our own leaf directory only
}

function timestamp(now: Date): string {
  return now
    .toISOString()
    .replace(/\.\d+Z$/, "Z")
    .replace(/[-:]/g, "");
}

/** Delete our own files older than the TTL. Regular files with our name pattern only; best effort. */
export function sweepExports(dir: string, now = Date.now()): void {
  let names: string[];
  try {
    names = readdirSync(dir);
  } catch {
    return;
  }
  for (const name of names) {
    if (!NAME.test(name)) continue;
    try {
      const path = join(dir, name);
      const stat = lstatSync(path); // never follows a symlink
      if (stat.isFile() && now - stat.mtimeMs > EXPORT_TTL_HOURS * 3_600_000) unlinkSync(path);
    } catch {
      /* ignore */
    }
  }
}

/**
 * Write one export file and return its absolute path. The leaf directory is mode 0700 and the
 * file 0600 (written under a temp name with flag "wx", then renamed in the same directory). On
 * Windows the mode bits are ignored and the user-profile ACL inheritance protects the folder.
 * Failures carry no cookie data.
 */
export function writeCookieExport(
  home: string,
  profileId: string,
  extension: "json" | "txt",
  data: string,
  now = new Date(),
  test: { suffix?: string; beforeRename?: (temp: string) => void } = {},
): string {
  return writeExport(cookieExportDir(resolve(home)), profileId, extension, data, now, test);
}

/** Write one screenshot (PNG bytes) with the same guarantees as a cookie export. */
export function writeScreenshotExport(
  home: string,
  profileId: string,
  png: Buffer,
  now = new Date(),
  test: { suffix?: string; beforeRename?: (temp: string) => void } = {},
): string {
  return writeExport(screenshotExportDir(resolve(home)), profileId, "png", png, now, test);
}

function writeExport(
  dir: string,
  profileId: string,
  extension: "json" | "txt" | "png",
  data: string | Buffer,
  now: Date,
  test: { suffix?: string; beforeRename?: (temp: string) => void },
): string {
  try {
    ensurePrivateDir(dir);
    sweepExports(dir, now.getTime());
    const name = `${profileId}-${timestamp(now)}-${test.suffix ?? randomBytes(2).toString("hex")}.${extension}`;
    const final = join(dir, name);
    const temp = `${final}.tmp`;
    const fd = openSync(temp, "wx", 0o600);
    try {
      const bytes = typeof data === "string" ? Buffer.from(data, "utf8") : data;
      let written = 0;
      while (written < bytes.length) written += writeSync(fd, bytes, written);
    } catch (error) {
      closeSync(fd);
      try {
        unlinkSync(temp);
      } catch {
        /* ignore */
      }
      throw error;
    }
    closeSync(fd);
    test.beforeRename?.(temp);
    renameSync(temp, final);
    return final;
  } catch (error) {
    throw error instanceof McpFailure ? error : new McpFailure("internal");
  }
}

/** Sweep now and then hourly (unref'd, so it never keeps the process alive). Returns the stopper. */
export const SWEEP_INTERVAL_MS = 3_600_000;
export function startExportSweeper(home: string): () => void {
  const dirs = [cookieExportDir(resolve(home)), screenshotExportDir(resolve(home))];
  const sweep = () => {
    for (const dir of dirs) {
      try {
        sweepExports(dir);
      } catch {
        /* ignore */
      }
    }
  };
  sweep();
  const timer = setInterval(sweep, SWEEP_INTERVAL_MS);
  timer.unref();
  return () => clearInterval(timer);
}

/**
 * Read one cookie file from `<ANT0_HOME>/imports/cookies` (UTF-8, at most one request body).
 * The directory is created 0700 if missing. Every failure (missing, unreadable, outside the
 * directory, symlink, directory, FIFO, too large, swapped, bad UTF-8) is the same `arguments`
 * failure, so the tool is not an existence or content oracle for other paths.
 */
export function readImportFile(
  home: string,
  path: string,
  test: { afterLstat?: (path: string) => void } = {},
): string {
  const fail = () => new McpFailure("arguments");
  if (!isAbsolute(path) || path.includes("\0")) throw fail();
  let fd: number | undefined;
  try {
    const dir = cookieImportDir(resolve(home));
    ensurePrivateDir(dir);
    const inside = relative(realpathSync(dir), realpathSync(path));
    if (inside === "" || inside === ".." || inside.startsWith(`..${sep}`) || isAbsolute(inside))
      throw fail();
    const stat = lstatSync(path);
    if (!stat.isFile() || stat.isSymbolicLink() || stat.size > LIMITS.bodyBytes) throw fail();
    test.afterLstat?.(path);
    fd = openSync(path, constants.O_RDONLY | constants.O_NONBLOCK | (constants.O_NOFOLLOW ?? 0));
    const opened = fstatSync(fd);
    if (!opened.isFile() || opened.ino !== stat.ino || opened.dev !== stat.dev) throw fail();
    const buffer = Buffer.alloc(LIMITS.bodyBytes + 1);
    let size = 0;
    while (size < buffer.length) {
      const count = readSync(fd, buffer, size, buffer.length - size, null);
      if (count === 0) break;
      size += count;
    }
    if (size > LIMITS.bodyBytes) throw fail();
    return new TextDecoder("utf-8", { fatal: true }).decode(buffer.subarray(0, size));
  } catch {
    throw fail();
  } finally {
    if (fd !== undefined) closeSync(fd);
  }
}
