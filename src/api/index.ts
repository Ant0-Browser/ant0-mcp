/**
 * Typed client for the Ant0 desktop local API, reduced to what this adapter needs.
 *
 * `generated/schema.ts` is produced from `openapi.json` (the subset of the local API that the
 * adapter calls) by `scripts/generate-api.mjs` and is never edited by hand. This module adds
 * discovery of the local daemon (`<ANT0_HOME>/ant0d.pid` + `ant0d.token`), a bearer-token
 * middleware and an error type for the `{ error, message, details? }` envelope.
 */
import { existsSync, lstatSync, readFileSync } from "node:fs";
import { homedir, platform as osPlatform } from "node:os";
import { dirname, join, posix, resolve, win32 } from "node:path";
import createClient, { type Client, type Middleware } from "openapi-fetch";
import type { paths } from "./generated/schema.js";

/** `GET /v1/health` response. */
export type Health = paths["/v1/health"]["get"]["responses"][200]["content"]["application/json"];

// ---------------------------------------------------------------------------------------------
// Discovery
// ---------------------------------------------------------------------------------------------

export const DEFAULT_HOST = "127.0.0.1";

/** `127.x.x.x`, `localhost`, or `::1` (with or without brackets). */
export function isLoopbackHost(host: string): boolean {
  const h = host
    .trim()
    .toLowerCase()
    .replace(/^\[|\]$/g, "");
  return (
    h === "localhost" ||
    h === "::1" ||
    (/^127\.\d{1,3}\.\d{1,3}\.\d{1,3}$/.test(h) &&
      h.split(".").every((part) => Number(part) <= 255))
  );
}
export const DEFAULT_PORT = 27100;

export interface DiscoveredPidFile {
  pid: number;
  port: number;
  host: string;
}

export interface DiscoverOptions {
  /** Data directory; default `$ANT0_HOME`, else the platform data folder (see `resolveHome`). */
  home?: string;
  /** Environment to consult; default `process.env`. */
  env?: Record<string, string | undefined>;
  /** Port override (e.g. a `--port` flag); wins over the pid file and the environment. */
  port?: number;
}

export interface DiscoveredDaemon {
  /** `http://<host>:<port>` without a trailing slash. */
  baseUrl: string;
  /** Contents of `ant0d.token`, or undefined when the file is missing or empty. */
  token: string | undefined;
  /** Resolved data directory. */
  home: string;
  /** Parsed `ant0d.pid` when present and well-formed. Liveness is not checked here. */
  pidFile?: DiscoveredPidFile;
}

export interface ResolveHomeOptions {
  /** Explicit data directory (a `--home` flag); wins over everything. */
  home?: string;
  env?: Record<string, string | undefined>;
  /** `process.platform`; `win32`, `darwin`, anything else counts as Linux/Unix. */
  platform?: string;
  /** `os.homedir()`. */
  homedir?: () => string;
  /** Whether a candidate data folder counts as existing; default `homeExists`. */
  exists?: (path: string) => boolean;
  /** `process.execPath`; the folder holding it is refused as a data folder. */
  execPath?: string;
}

/**
 * A data folder exists for the legacy rule only when a daemon has run on it (`ant0.db` or
 * `profiles/` present); an empty directory does not shadow a populated `~/.ant0`. Same rule as the
 * Ant0 desktop app.
 */
export function homeExists(dir: string): boolean {
  return existsSync(join(dir, "ant0.db")) || existsSync(join(dir, "profiles"));
}

/**
 * Refuse a data folder that is the directory holding the running executable (an installer that
 * unpacks into the data folder would put the database next to the binary). Resolved paths,
 * case-insensitive on Windows.
 */
export function assertNotExecutableDir(home: string, execPath: string, platform: string): void {
  const exeDir = resolve(dirname(execPath));
  const target = resolve(home);
  const same =
    platform === "win32" ? exeDir.toLowerCase() === target.toLowerCase() : exeDir === target;
  if (same) {
    throw new Error(
      `refusing to use ${target} as the data folder: it contains the running executable ` +
        `(${execPath}); set ANT0_HOME or --home to a separate folder`,
    );
  }
}

/**
 * The platform data folder: Windows `%LOCALAPPDATA%\Ant0`; macOS
 * `~/Library/Application Support/Ant0`; Linux `$XDG_DATA_HOME/ant0` or `~/.local/share/ant0`.
 */
export function platformDefaultHome(
  platform: string,
  env: Record<string, string | undefined>,
  userHome: string,
): string {
  if (platform === "win32") {
    const local = env.LOCALAPPDATA && env.LOCALAPPDATA.length > 0 ? env.LOCALAPPDATA : undefined;
    return local ? win32.join(local, "Ant0") : win32.join(userHome, "AppData", "Local", "Ant0");
  }
  if (platform === "darwin") return posix.join(userHome, "Library", "Application Support", "Ant0");
  const xdg = env.XDG_DATA_HOME && env.XDG_DATA_HOME.length > 0 ? env.XDG_DATA_HOME : undefined;
  return xdg ? posix.join(xdg, "ant0") : posix.join(userHome, ".local", "share", "ant0");
}

/**
 * Resolve the data directory with the same rule as the Ant0 desktop app: the explicit `home`, then `ANT0_HOME`, then the
 * platform default; an existing legacy `~/.ant0` is kept while the platform default does not
 * exist, so the CLI keeps finding a daemon that still runs there.
 */
export function resolveHome(opts: ResolveHomeOptions = {}): string {
  const env = opts.env ?? process.env;
  const platform = opts.platform ?? osPlatform();
  const execPath = opts.execPath ?? process.execPath;
  const explicit = opts.home ?? env.ANT0_HOME?.trim();
  if (explicit && explicit.length > 0) {
    assertNotExecutableDir(explicit, execPath, platform);
    return explicit;
  }
  const exists = opts.exists ?? homeExists;
  const userHome = (opts.homedir ?? homedir)();
  const def = platformDefaultHome(platform, env, userHome);
  const legacy = (platform === "win32" ? win32 : posix).join(userHome, ".ant0");
  const home = !exists(def) && exists(legacy) ? legacy : def;
  assertNotExecutableDir(home, execPath, platform);
  return home;
}

/**
 * Locate the daemon from the Ant0 data folder (`ant0d.pid`, `ant0d.token`). Does not throw for a missing file: an
 * unreadable pid file falls back to a loopback `ANT0D_HOST`, `ANT0D_PORT` or `127.0.0.1:27100`, and a
 * missing token yields `token: undefined` (callers treat that as "daemon not running"). The one
 * exception is a token file that exists but is not private: that throws `TokenFileNotPrivateError`.
 */
export function discoverDaemon(opts: DiscoverOptions = {}): DiscoveredDaemon {
  const env = opts.env ?? process.env;
  const home = resolveHome({ ...(opts.home !== undefined ? { home: opts.home } : {}), env });

  const pidFile = readPidFile(join(home, "ant0d.pid"));
  const envPort = parsePort(env.ANT0D_PORT);
  // The daemon only ever listens on loopback; a pid file naming another host is tampered or
  // stale and must not redirect the bearer token anywhere (mirrors the desktop shell's rule).
  const pidHost = pidFile && isLoopbackHost(pidFile.host) ? pidFile.host : undefined;
  // The same rule applies to ANT0D_HOST: only a loopback address is accepted (as in
  // `canonicalOrigin` of the MCP connection); anything else is ignored.
  const envHost = env.ANT0D_HOST?.trim();
  const host =
    pidHost ??
    (envHost && isLoopbackHost(envHost) ? envHost.replace(/^\[|\]$/g, "") : DEFAULT_HOST);
  const port = opts.port ?? pidFile?.port ?? envPort ?? DEFAULT_PORT;
  const token = readToken(join(home, "ant0d.token"));

  const result: DiscoveredDaemon = { baseUrl: baseUrlFor(host, port), token, home };
  if (pidFile) result.pidFile = pidFile;
  return result;
}

function baseUrlFor(host: string, port: number): string {
  const h = host.includes(":") && !host.startsWith("[") ? `[${host}]` : host;
  return `http://${h}:${port}`;
}

function parsePort(value: string | undefined): number | undefined {
  if (value === undefined || value.trim() === "") return undefined;
  const n = Number(value);
  return Number.isInteger(n) && n > 0 && n <= 65535 ? n : undefined;
}

function readPidFile(file: string): DiscoveredPidFile | undefined {
  try {
    if (!existsSync(file)) return undefined;
    const parsed = JSON.parse(readFileSync(file, "utf8")) as Partial<DiscoveredPidFile>;
    if (typeof parsed.pid !== "number" || typeof parsed.port !== "number") return undefined;
    return {
      pid: parsed.pid,
      port: parsed.port,
      host: typeof parsed.host === "string" && parsed.host.length > 0 ? parsed.host : DEFAULT_HOST,
    };
  } catch {
    return undefined;
  }
}

function readToken(file: string): string | undefined {
  // Discovery only reads: daemon start/stop/status and health checks never send the token. The
  // privacy check runs where the token is sent (`checkDiscoveredToken`).
  try {
    if (!existsSync(file)) return undefined;
    const token = readFileSync(file, "utf8").trim();
    return token.length > 0 ? token : undefined;
  } catch {
    return undefined;
  }
}

/** `ant0d.token` exists but other users could read it, or it is not a plain file of this user. */
export class TokenFileNotPrivateError extends Error {
  override readonly name = "TokenFileNotPrivateError";
  readonly path: string;
  readonly reason: string;
  /**
   * Whether `ANT0_ALLOW_SHARED_TOKEN_FILE=1` may waive this refusal: only a wide mode or a foreign
   * owner. A symbolic link or a file that is not a regular file is always refused.
   */
  readonly waivable: boolean;

  constructor(path: string, reason: string, opts: { optOutHint?: boolean } = {}) {
    const waivable = reason.startsWith("mode") || reason.startsWith("owned by another user");
    super(
      `token file ${path} is not private (${reason}). ${tokenFileFix(path, reason, waivable && opts.optOutHint !== false)}`,
    );
    this.waivable = waivable;
    this.path = path;
    this.reason = reason;
  }
}

/** How to put a token file right; mentions the path, never the token. */
function tokenFileFix(path: string, reason: string, optOutHint: boolean): string {
  const q = shellQuote(path);
  const optOut = optOutHint
    ? ` Or set ${SHARED_TOKEN_FILE_ENV}=1 to warn instead of refusing (for file systems without Unix modes).`
    : "";
  if (reason.startsWith("mode")) return `Fix: chmod 600 ${q}.${optOut}`;
  if (reason.startsWith("owned by another user"))
    return `Run ant0 as the file's owner, or chown it to your user (chown "$(id -un)" ${q}) and chmod 600 it.${optOut}`;
  return `Fix: remove it and run \`ant0 daemon start\` to recreate it as a private file.${optOut}`;
}

/** POSIX single quotes: safe for spaces, `$`, backticks and double quotes in the path. */
function shellQuote(path: string): string {
  return `'${path.replaceAll("'", `'\\''`)}'`;
}

/** Set to `1` to turn the token privacy refusal into a stderr warning. */
export const SHARED_TOKEN_FILE_ENV = "ANT0_ALLOW_SHARED_TOKEN_FILE";

/** The parts of `fs.Stats` that decide whether a token file is private. */
export interface TokenFileStat {
  isFile(): boolean;
  isSymbolicLink(): boolean;
  uid: number;
  mode: number;
}

export interface PrivateTokenOptions {
  /** Default: `process.platform`. */
  platform?: NodeJS.Platform;
  /** Default: `process.geteuid()`. Root (0) may read a token owned by any user, as with OpenSSH. */
  uid?: number | undefined;
  /** Default: `process.env`. */
  env?: Record<string, string | undefined>;
  /** Default: writes to stderr. Called instead of throwing when the opt-out is set. */
  warn?: (message: string) => void;
}

/**
 * Why a token file's `lstat` result is not private, or `undefined` when it is. Not Windows: a
 * regular file (not a link), owned by the current user, with no group or other permission bits.
 * On Windows this returns `undefined`: this adapter cannot check Windows file ACLs, so the file goes
 * unverified.
 */
export function privateTokenProblem(
  stat: TokenFileStat,
  opts: PrivateTokenOptions = {},
): string | undefined {
  if ((opts.platform ?? process.platform) === "win32") return undefined;
  if (stat.isSymbolicLink()) return "a symbolic link";
  if (!stat.isFile()) return "not a regular file";
  const uid = "uid" in opts ? opts.uid : process.geteuid?.();
  if (uid !== undefined && uid !== 0 && stat.uid !== uid) return "owned by another user";
  if ((stat.mode & 0o077) !== 0) {
    return `mode ${(stat.mode & 0o777).toString(8).padStart(3, "0")} gives group or others access`;
  }
  return undefined;
}

/**
 * Refuse a token file that is not private. A missing file, or one that cannot be inspected, passes
 * (the caller then sees "no token" as before); a file that is there but fails
 * {@link privateTokenProblem} throws {@link TokenFileNotPrivateError}. Never reads the contents.
 */
export function checkPrivateTokenFile(file: string, opts: PrivateTokenOptions = {}): void {
  let stat;
  try {
    stat = lstatSync(file);
  } catch {
    return;
  }
  const problem = privateTokenProblem(stat, opts);
  if (problem === undefined) return;
  const optedOut = (opts.env ?? process.env)[SHARED_TOKEN_FILE_ENV] === "1";
  const error = new TokenFileNotPrivateError(file, problem, { optOutHint: !optedOut });
  if (optedOut && error.waivable) {
    const text = `ant0: warning: ${error.message} (continuing: ${SHARED_TOKEN_FILE_ENV}=1)\n`;
    if (opts.warn) opts.warn(text);
    else process.stderr.write(text);
    return;
  }
  throw error;
}

/**
 * Where the daemon's token is about to be sent: refuse (or, with the opt-out, warn about) a token
 * file that is not private. Does nothing when discovery found no token. Never reads the contents.
 */
export function checkDiscoveredToken(
  discovered: Pick<DiscoveredDaemon, "home" | "token">,
  opts: PrivateTokenOptions = {},
): void {
  if (discovered.token === undefined) return;
  checkPrivateTokenFile(join(discovered.home, "ant0d.token"), opts);
}

// ---------------------------------------------------------------------------------------------
// Client
// ---------------------------------------------------------------------------------------------

export interface ClientOptions {
  /** Default: discovered from the pid file / environment. */
  baseUrl?: string;
  /** Default: `~/.ant0/ant0d.token`. When neither is available, requests go out unauthenticated. */
  token?: string;
  /**
   * No authentication: the token is never discovered, checked or sent (a given `token` is
   * ignored). For health checks and other routes that need none. `baseUrl` is still discovered
   * when omitted.
   */
  anonymous?: boolean;
  /** `ANT0_HOME` used for discovery when `baseUrl` or `token` are omitted. */
  home?: string;
  /** Injected fetch (tests, custom dispatchers). Default: `globalThis.fetch`. */
  fetch?: typeof fetch;
}

export type Ant0Client = Client<paths>;

/** Middleware that adds `Authorization: Bearer <token>` to every request. */
export function bearerMiddleware(token: string): Middleware {
  return {
    onRequest({ request }) {
      request.headers.set("authorization", `Bearer ${token}`);
      return request;
    },
  };
}

/**
 * An `openapi-fetch` client for the daemon. Missing `baseUrl`/`token` are discovered from
 * `opts.home` (see `discoverDaemon`). Connection failures surface as the `fetch` rejection
 * (`TypeError: fetch failed` with `cause.code === "ECONNREFUSED"` when nothing listens).
 */
export function createAnt0Client(opts: ClientOptions = {}): Ant0Client {
  let baseUrl = opts.baseUrl;
  let token = opts.token;
  if (opts.anonymous === true) token = undefined;
  if (baseUrl === undefined || (token === undefined && opts.anonymous !== true)) {
    const discovered = discoverDaemon(opts.home !== undefined ? { home: opts.home } : {});
    baseUrl ??= discovered.baseUrl;
    if (token === undefined && opts.anonymous !== true) {
      // The token is about to be sent: refuse a token file that is not private.
      checkDiscoveredToken(discovered);
      token = discovered.token;
    }
  }

  const fetchFn = opts.fetch;
  const client = createClient<paths>({
    baseUrl,
    ...(fetchFn ? { fetch: (request: Request) => fetchFn(request) } : {}),
  });
  if (token !== undefined) client.use(bearerMiddleware(token));
  return client;
}

// ---------------------------------------------------------------------------------------------
// Errors
// ---------------------------------------------------------------------------------------------

/** A non-2xx answer from the daemon, decoded from the `{ error, message, details? }` envelope. */
export class Ant0ApiError extends Error {
  override readonly name = "Ant0ApiError";
  readonly status: number;
  /** Namespaced code such as `profile.not_found`; `http_<status>` when the body was not JSON. */
  readonly code: string;
  readonly details?: unknown;

  constructor(status: number, code: string, message: string, details?: unknown) {
    super(message);
    this.status = status;
    this.code = code;
    if (details !== undefined) this.details = details;
  }

  static fromEnvelope(status: number, body: unknown, statusText = ""): Ant0ApiError {
    if (body !== null && typeof body === "object") {
      const env = body as { error?: unknown; message?: unknown; details?: unknown };
      const code = typeof env.error === "string" ? env.error : `http_${status}`;
      const message =
        typeof env.message === "string"
          ? env.message
          : typeof env.error === "string"
            ? env.error
            : statusText || `HTTP ${status}`;
      return new Ant0ApiError(status, code, message, env.details);
    }
    const text = typeof body === "string" && body.trim().length > 0 ? body.trim() : "";
    return new Ant0ApiError(status, `http_${status}`, text || statusText || `HTTP ${status}`);
  }
}

export function isAnt0ApiError(value: unknown): value is Ant0ApiError {
  return value instanceof Ant0ApiError;
}

/**
 * Turn an `openapi-fetch` result into its data or throw `Ant0ApiError`. `openapi-fetch` yields
 * `data: {}` for 204 responses, so `unwrap` on a DELETE resolves to an empty object.
 */
export function unwrap<T>(result: { data?: T; error?: unknown; response: Response }): T {
  if (result.error !== undefined) {
    throw Ant0ApiError.fromEnvelope(
      result.response.status,
      result.error,
      result.response.statusText,
    );
  }
  if (result.data === undefined && !result.response.ok) {
    throw new Ant0ApiError(
      result.response.status,
      `http_${result.response.status}`,
      result.response.statusText || `HTTP ${result.response.status}`,
    );
  }
  return result.data as T;
}
