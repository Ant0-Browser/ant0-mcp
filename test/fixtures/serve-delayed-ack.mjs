import { serveStdio, McpFailure } from "../../dist/index.js";
import { OutputWriter } from "../../dist/output-writer.js";

// Hold exactly one real stdout-write acknowledgement, AFTER its bytes reached the peer.
// Neither the HTTP transport nor its permit pool is patched. Release is explicit, not timed.
let target = process.argv[3] === "ack-initialize" ? 1 : 100;
let release;
let writer;
const report = (message) =>
  new Promise((resolve) => {
    if (!process.connected) return resolve();
    process.send(message, () => resolve());
  });
const start = OutputWriter.prototype.start;
OutputWriter.prototype.start = async function () {
  writer = this;
  const onMessage = this.onMessage;
  this.onMessage = (message) => {
    const response = this.current && JSON.parse(this.current.bytes.toString("utf8"));
    if (message.type === "ack" && response && !("method" in response) && response.id === target) {
      target = undefined;
      release = () => onMessage(message);
      void report({ type: "ack-held", id: response.id });
    } else onMessage(message);
  };
  await start.call(this);
  await report({ type: "writer-started", pid: this.pid });
};
const control = (message) => {
  if (message.type === "release-ack") {
    release?.();
    release = undefined;
  } else if (message.type === "kill-writer" && writer?.pid) process.kill(writer.pid, "SIGKILL");
};
process.on("message", control);
try {
  await serveStdio({ home: process.argv[2] });
} catch (error) {
  process.stderr.write(`mcp: ${error instanceof McpFailure ? error.message : "adapter failed"}\n`);
  process.exitCode = 1;
} finally {
  // serveStdio closes/reaps its writer even if an assertion left the acknowledgement held.
  release = undefined;
  await report({ type: "writer-reaped", pid: writer?.pid });
  process.off("message", control);
  if (process.connected) process.disconnect();
}
