#!/usr/bin/env node
/**
 * `ant0-mcp`: serve the Ant0 MCP adapter over stdio against an already-running Ant0 desktop app.
 *
 *   ant0-mcp [serve] [--stdio] [--home <dir>] [--port <n>] [--credential-file <path>]
 *
 * An API key, when used, comes from ANT0_API_KEY or a private credential file; stdin carries the
 * MCP protocol and nothing else.
 */
import { McpFailure, serveStdio } from "./index.js";

function usage(message?: string): never {
  if (message) process.stderr.write(`ant0-mcp: ${message}\n`);
  process.stderr.write(
    "usage: ant0-mcp [serve] [--stdio] [--home <dir>] [--port <n>] [--credential-file <path>]\n",
  );
  process.exit(2);
}

const args = process.argv.slice(2);
if (args[0] === "serve") args.shift();
let home: string | undefined;
let port: number | undefined;
let credentialFile: string | undefined;
for (let i = 0; i < args.length; i++) {
  const arg = args[i]!;
  const value = () => {
    const v = args[++i];
    if (v === undefined || v === "") usage(`${arg} needs a value`);
    return v;
  };
  if (arg === "--stdio") continue;
  else if (arg === "--home") home = value();
  else if (arg === "--credential-file") credentialFile = value();
  else if (arg === "--port") {
    const n = Number(value());
    if (!Number.isInteger(n) || n < 1 || n > 65535) usage("--port expects a port number (1-65535)");
    port = n;
  } else if (arg === "--help" || arg === "-h") usage();
  else usage("unknown argument");
}

try {
  await serveStdio({
    ...(home !== undefined ? { home } : {}),
    ...(port !== undefined ? { port } : {}),
    ...(credentialFile !== undefined ? { credentialFile } : {}),
  });
} catch (error) {
  process.stderr.write(
    `ant0-mcp: ${error instanceof McpFailure ? error.message : "adapter failed"}\n`,
  );
  process.exitCode = 1;
}
