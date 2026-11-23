import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { Client } from "@modelcontextprotocol/client";
import { getDefaultEnvironment, StdioClientTransport } from "@modelcontextprotocol/client/stdio";
import { expect } from "vitest";

export const ID = "12345678-1234-4234-8234-123456789abc";
export const DATE = "2026-09-17T12:00:00.000Z";
export const SECRET = "SENTINEL_DO_NOT_EXPOSE";
export const TOKEN = "test-local-bearer-not-cloud";
export const entry = fileURLToPath(new URL("./fixtures/serve.mjs", import.meta.url));
export const session = {
  profile_id: ID,
  browser_version: "149.0.7827.114-ant0.3",
  headless: true,
  started_at: DATE,
  pid: 987654321,
  ws_endpoint: `ws://localhost/${SECRET}`,
  cdp_http: `http://localhost/${SECRET}`,
  debug_port: 9876,
  user_agent: SECRET,
  token: SECRET,
};
export const profile = {
  id: ID,
  name: "A profile",
  group: null,
  local_folder_id: null,
  tags: ["work"],
  status: null,
  pinned: false,
  platform: "linux",
  created_at: DATE,
  updated_at: DATE,
  notes: SECRET,
  proxy_id: ID,
  browser_version: "149.0.7827.114-ant0.3",
  identity_mode: "synthetic",
  last_launched_at: null,
  deleted_at: null,
  browser: { channel: "stable", version: null, executable: SECRET },
  identity: { mode: "synthetic", key: SECRET, profile_ref: SECRET },
  network: { proxy_id: ID, proxy: { password: SECRET } },
  overrides: { webrtcIp: SECRET },
  launch: { extensions: [SECRET], start_urls: [SECRET], extra_args: [SECRET] },
  runtime: session,
  path: SECRET,
};
export const proxy = {
  id: ID,
  name: SECRET,
  type: "http",
  tags: [],
  udp: false,
  created_at: DATE,
  updated_at: DATE,
  host: SECRET,
  port: 9876,
  username: SECRET,
  password: SECRET,
  password_ref: SECRET,
  change_ip_url: SECRET,
  session_pattern: SECRET,
  provider: SECRET,
  notes: SECRET,
  last_check: {
    at: DATE,
    ok: true,
    country: "DE",
    latency_ms: 10,
    error: SECRET,
    ip: SECRET,
    timezone: SECRET,
  },
};
export const inventoryProfile = {
  profile,
  lifecycle: { ...session, state: "running" },
  proxy,
  permissions: { edit: false, cdp: false, token: SECRET },
  token: SECRET,
};
export const runResult = {
  requested_profile_id: ID,
  profile_id: ID,
  redirected: false,
  lifecycle: {
    profile_id: ID,
    state: "running",
    browser_version: session.browser_version,
    headless: session.headless,
    started_at: session.started_at,
  },
};
export const licence = {
  state: "active",
  mode: "enforce",
  plan: "free",
  limits: { profiles: 5, seats: 1, secret: SECRET },
  used: 1,
  used_local: 1,
  features: ["api", "mcp", SECRET],
  billing: "active",
  online: true,
  expires_at: DATE,
  grace_until: DATE,
  last_refresh_at: DATE,
  token: SECRET,
  access: SECRET,
  refresh: SECRET,
  device_id: SECRET,
  sign_pub: SECRET,
  workspace: { id: ID, name: SECRET },
  message: SECRET,
  last_error: SECRET,
  keep: { profile_ids: [SECRET] },
};

export function payload(path: string): unknown {
  switch (path) {
    case "/v1/health":
      return { ok: true, version: "0.1.0", uptime_s: 7, home: SECRET, pid: 987654321 };
    case "/v1/licence":
      return licence;
    case "/v1/profiles":
      return { items: [profile], total: 1 };
    case "/v1/inventory/profiles":
      return { items: [inventoryProfile], total: 1 };
    case `/v1/inventory/profiles/${ID}`:
      return inventoryProfile;
    case "/v1/inventory/proxies":
      return { items: [proxy], total: 1 };
    case `/v1/profiles/${ID}`:
      return profile;
    case `/v1/profiles/${ID}/status`:
      return { state: "running", session };
    case `/v1/profiles/${ID}/run`:
      return runResult.lifecycle;
    case "/v1/sessions":
      return { items: [session] };
    case "/v1/proxies":
      return { items: [proxy] };
    default:
      throw new Error(`Unexpected test route: ${path}`);
  }
}

export type Handler = (req: IncomingMessage, res: ServerResponse) => void;

export async function mockDaemon(handler?: Handler) {
  const home = mkdtempSync(join(tmpdir(), "ant0-mcp-"));
  const requests: {
    method: string;
    url: string;
    authorization: string | undefined;
    consumer?: string | string[];
  }[] = [];
  const server = createServer((req, res) => {
    requests.push({
      method: req.method!,
      url: req.url!,
      authorization: req.headers.authorization,
      ...(req.headers["x-ant0-consumer"] !== undefined
        ? { consumer: req.headers["x-ant0-consumer"] }
        : {}),
    });
    if (handler) handler(req, res);
    else {
      res.setHeader("content-type", "application/json");
      const path = new URL(req.url!, "http://localhost").pathname;
      if (req.method === "POST" && path === `/v1/profiles/${ID}/run`)
        res.end(JSON.stringify(runResult));
      else if (req.method === "POST" && path === `/v1/profiles/${ID}/stop`) {
        res.writeHead(204);
        res.end();
      } else res.end(JSON.stringify(payload(path)));
    }
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const port = (server.address() as { port: number }).port;
  writeFileSync(
    join(home, "ant0d.pid"),
    JSON.stringify({ pid: process.pid, host: "127.0.0.1", port }),
  );
  writeFileSync(join(home, "ant0d.token"), `${TOKEN}\n`, { mode: 0o600 });
  return {
    home,
    port,
    requests,
    async close() {
      server.closeAllConnections();
      await new Promise<void>((resolve) => server.close(() => resolve()));
      rmSync(home, { recursive: true, force: true });
    },
  };
}

/** `modern` pins the 2026-07-28 revision (server/discover, per-request _meta); default is initialize. */
export async function sdkClient(
  home: string,
  args = [entry, home],
  era: "legacy" | "modern" = "legacy",
  env?: Record<string, string>,
) {
  const transport = new StdioClientTransport({
    command: process.execPath,
    args,
    stderr: "pipe",
    ...(env ? { env: { ...getDefaultEnvironment(), ...env } } : {}),
  });
  let stderr = "";
  transport.stderr!.on("data", (chunk) => {
    stderr += chunk.toString();
  });
  const client = new Client(
    { name: "ant0-test", version: "1.0.0" },
    era === "modern" ? { versionNegotiation: { mode: { pin: "2026-07-28" } } } : {},
  );
  await client.connect(transport);
  return { client, transport, stderr: () => stderr, close: () => client.close() };
}

export function rawClient(
  home: string,
  args = [entry, home],
  respondToPing = true,
  ipc = args[0] === entry,
) {
  // Both variants pipe all three streams; Node's typed tuple overload only covers three fds.
  const child = spawn(process.execPath, args, {
    stdio: ipc ? ["pipe", "pipe", "pipe", "ipc"] : ["pipe", "pipe", "pipe"],
  }) as ChildProcessWithoutNullStreams;
  let writerPid: number | undefined;
  child.on("message", (message: unknown) => {
    if (
      message &&
      typeof message === "object" &&
      "type" in message &&
      message.type === "writer-started" &&
      "pid" in message &&
      typeof message.pid === "number" &&
      Number.isSafeInteger(message.pid) &&
      message.pid > 0
    ) {
      writerPid = message.pid;
    }
  });
  child.stdout.setEncoding("utf8");
  child.stderr.setEncoding("utf8");
  child.stdin.on("error", () => {});
  let stdout = "";
  let stderr = "";
  const messages: any[] = [];
  let buffer = "";
  child.stdout.on("data", (chunk) => {
    stdout += chunk.toString();
    buffer += chunk.toString();
    let newline: number;
    while ((newline = buffer.indexOf("\n")) !== -1) {
      const message = JSON.parse(buffer.slice(0, newline));
      messages.push(message);
      if (respondToPing && message.method === "ping") {
        child.stdin.write(`${JSON.stringify({ jsonrpc: "2.0", id: message.id, result: {} })}\n`);
      }
      buffer = buffer.slice(newline + 1);
    }
  });
  child.stderr.on("data", (chunk) => {
    stderr += chunk.toString();
  });
  const closed = new Promise<{ code: number | null; signal: string | null }>((resolve) =>
    child.on("close", (code, signal) => resolve({ code, signal })),
  );
  let id = 0;
  const send = (message: unknown) => child.stdin.write(`${JSON.stringify(message)}\n`);
  const request = (method: string, params?: unknown) => {
    const requestId = ++id;
    send({ jsonrpc: "2.0", id: requestId, method, ...(params === undefined ? {} : { params }) });
    return requestId;
  };
  const response = async (requestId: number | string) => {
    const find = () => messages.find((m) => m.id === requestId && !("method" in m));
    await expect.poll(find, { timeout: 3000 }).toBeDefined();
    return find();
  };
  return {
    child,
    send,
    request,
    response,
    closed,
    messages,
    writerPid: () => writerPid,
    respondToPing: (enabled: boolean) => {
      respondToPing = enabled;
    },
    stdout: () => stdout,
    stderr: () => stderr,
    async initialize() {
      await response(
        request("initialize", {
          protocolVersion: "2025-11-25",
          capabilities: {},
          clientInfo: { name: "test", version: "1" },
        }),
      );
      send({ jsonrpc: "2.0", method: "notifications/initialized" });
    },
    async close() {
      child.stdin.end();
      await closed;
    },
  };
}
