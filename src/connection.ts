import {
  SHARED_TOKEN_FILE_ENV,
  TokenFileNotPrivateError,
  privateTokenProblem,
  resolveHome,
} from "./api/index.js";
import { closeSync, constants, fstatSync, lstatSync, openSync, readSync } from "node:fs";
import { join } from "node:path";
import { McpFailure } from "./errors.js";
import { LIMITS } from "./limits.js";
import {
  readCredentialFile,
  assertCredentialUnchanged,
  type CredentialSnapshot,
} from "./credential-file.js";
import { API_KEY_ENV, apiKeyId } from "./key-contract.js";

export interface DiscoveryOptions {
  credentialFile?: string;
  apiKey?: string;
  home?: string;
  port?: number;
  env?: Record<string, string | undefined>;
}

export interface Connection {
  origin: string;
  token: string;
  credential?: CredentialSnapshot;
  apiKey?: true;
}

export function keyMode(connection: Connection): boolean {
  return connection.credential !== undefined || connection.apiKey === true;
}

function portNumber(value: unknown): number {
  if (typeof value === "string" && /^[1-9]\d{0,4}$/.test(value)) value = Number(value);
  if (typeof value !== "number" || !Number.isInteger(value) || value < 1 || value > 65535) {
    throw new McpFailure("configuration");
  }
  return value;
}

/** Exact syntax first: URL parsing alone accepts short/octal/hex IPv4 and strips URL parts. */
export function canonicalOrigin(value: string): string {
  const match =
    /^http:\/\/(localhost|127\.\d{1,3}\.\d{1,3}\.\d{1,3}|\[::1\]):([1-9]\d{0,4})\/?$/.exec(value);
  if (!match) throw new McpFailure("configuration");
  let host = match[1]!;
  const port = portNumber(match[2]);
  if (host.startsWith("127.")) {
    if (host.split(".").some((part) => String(Number(part)) !== part || Number(part) > 255)) {
      throw new McpFailure("configuration");
    }
  }
  // Avoid DNS (including an altered hosts file) even for the accepted localhost spelling.
  if (host === "localhost") host = "127.0.0.1";
  return new URL(`http://${host}:${port}`).origin;
}

/** Fixed discovery filenames only, bounded regular files; never follow a file symlink/FIFO. */
function localFile(
  file: string,
  mustBePrivate = false,
  env: Record<string, string | undefined> = process.env,
): string | undefined {
  let fd: number | undefined;
  try {
    let stat;
    try {
      stat = lstatSync(file);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
      throw error;
    }
    // The token file only: owned by this user, no group or other access (not checked on Windows,
    // as in the Ant0 desktop app). The ino/dev comparison below ties the opened file to this lstat.
    const problem = mustBePrivate ? privateTokenProblem(stat) : undefined;
    if (problem !== undefined) {
      // The path and the fix go to stderr (never the protocol stream); the token is never read here.
      const optedOut = env[SHARED_TOKEN_FILE_ENV] === "1";
      const refusal = new TokenFileNotPrivateError(file, problem, { optOutHint: !optedOut });
      const text = refusal.message;
      if (optedOut && refusal.waivable) {
        process.stderr.write(
          `ant0-mcp: warning: ${text} (continuing: ${SHARED_TOKEN_FILE_ENV}=1)\n`,
        );
      } else {
        process.stderr.write(`ant0-mcp: ${text}\n`);
        throw new McpFailure("token_file");
      }
    }
    if (!stat.isFile() || stat.size > LIMITS.discoveryBytes) throw new McpFailure("configuration");
    fd = openSync(file, constants.O_RDONLY | constants.O_NONBLOCK | (constants.O_NOFOLLOW ?? 0));
    const opened = fstatSync(fd);
    if (!opened.isFile() || opened.ino !== stat.ino || opened.dev !== stat.dev) {
      throw new McpFailure("configuration");
    }
    const buffer = Buffer.alloc(LIMITS.discoveryBytes + 1);
    let size = 0;
    while (size < buffer.length) {
      const count = readSync(fd, buffer, size, buffer.length - size, null);
      if (count === 0) break;
      size += count;
    }
    if (size > LIMITS.discoveryBytes) throw new McpFailure("configuration");
    return new TextDecoder("utf-8", { fatal: true }).decode(buffer.subarray(0, size));
  } catch (error) {
    if (error instanceof McpFailure && error.code === "token_file") throw error;
    throw new McpFailure("configuration");
  } finally {
    if (fd !== undefined) closeSync(fd);
  }
}

/** Same home and flag > pid > env > default precedence as the CLI, with fail-closed validation. */
export function discoverConnection(options: DiscoveryOptions): Connection {
  try {
    const env = options.env ?? process.env;
    const home = resolveHome({
      ...(options.home !== undefined ? { home: options.home } : {}),
      env,
    });
    const raw = localFile(join(home, "ant0d.pid"));
    let pid: { host?: string; port?: number } = {};
    if (raw !== undefined) {
      const parsed: unknown = JSON.parse(raw);
      if (!parsed || typeof parsed !== "object" || Array.isArray(parsed))
        throw new McpFailure("configuration");
      const p = parsed as Record<string, unknown>;
      if (!Number.isSafeInteger(p.pid) || (p.pid as number) < 1)
        throw new McpFailure("configuration");
      if (typeof p.port !== "number") throw new McpFailure("configuration");
      const port = portNumber(p.port);
      const host = p.host ?? "127.0.0.1";
      if (typeof host !== "string") throw new McpFailure("configuration");
      canonicalOrigin(`http://${host === "::1" ? "[::1]" : host}:${port}`);
      pid = { host, port };
    }
    const host = pid.host ?? env.ANT0D_HOST ?? "127.0.0.1";
    const port = portNumber(options.port ?? pid.port ?? env.ANT0D_PORT ?? 27100);
    const origin = canonicalOrigin(`http://${host === "::1" ? "[::1]" : host}:${port}`);
    const envKey = env[API_KEY_ENV];
    if (
      [options.credentialFile, options.apiKey, envKey].filter((value) => value !== undefined)
        .length > 1
    )
      throw new McpFailure("configuration");
    const key = options.apiKey ?? envKey;
    if (key !== undefined) {
      if (apiKeyId(key) === undefined) throw new McpFailure("configuration");
      return { origin, token: key, apiKey: true };
    }
    // Validate destination BEFORE opening the only credential file this adapter ever reads.
    if (options.credentialFile !== undefined) {
      const credential = readCredentialFile(options.credentialFile);
      if (credential.value.phase !== "ready") throw new McpFailure("configuration");
      assertCredentialUnchanged(credential);
      return { origin, token: credential.value.create.credential, credential };
    }
    const token = localFile(join(home, "ant0d.token"), true, env)?.trim();
    if (!token) throw new McpFailure("unavailable");
    if (!/^[A-Za-z0-9._~+\/-]+=*$/.test(token)) throw new McpFailure("configuration");
    // An API key in the local token file would silently turn the local bearer into a key.
    if (token.startsWith("ant0_sk_")) throw new McpFailure("configuration");
    return { origin, token };
  } catch (error) {
    if (error instanceof McpFailure) throw error;
    throw new McpFailure("configuration");
  }
}
