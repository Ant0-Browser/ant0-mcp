import { serveStdio, McpFailure } from "../../dist/index.js";

// Optional test-only observation channel; stdout still contains only the real MCP protocol.
// Native SDK clients do not supply this IPC channel. No production PID-discovery API is added.
if (process.send) {
  const { OutputWriter } = await import("../../dist/output-writer.js");
  const start = OutputWriter.prototype.start;
  OutputWriter.prototype.start = async function () {
    await start.call(this);
    process.send?.({ type: "writer-started", pid: this.pid }, () => {});
  };
}

try {
  await serveStdio({
    home: process.argv[2],
    ...(process.argv[3] ? { credentialFile: process.argv[3] } : {}),
  });
} catch (error) {
  process.stderr.write(`mcp: ${error instanceof McpFailure ? error.message : "adapter failed"}\n`);
  process.exitCode = 1;
}
