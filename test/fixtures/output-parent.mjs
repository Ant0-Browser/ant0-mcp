import { OutputWriter } from "../../dist/output-writer.js";
import { fileURLToPath } from "node:url";

const notify = (message) =>
  new Promise((resolve) => {
    if (!process.connected) return resolve();
    process.send(message, () => resolve());
  });
let closing;
const stop = (code) => {
  if (closing) return closing;
  closing = (async () => {
    await writer.close();
    await notify({ type: "closed", writerPid: writer.pid, argv: writer.child?.spawnargs });
    process.exitCode = code;
    if (process.connected) process.disconnect();
  })();
  return closing;
};
const mode = process.argv[2];
const command = mode
  ? {
      executable: process.execPath,
      args: [
        fileURLToPath(new URL("./output-self.mjs", import.meta.url)),
        mode === "self" ? "--ant0-internal=mcp-output-worker-v1" : mode,
      ],
    }
  : undefined;
const writer = new OutputWriter(
  1,
  (code) => {
    void notify({ type: "failure", code });
    void stop(1);
  },
  command,
);
// The product dependency is snapshotted at construction, before any asynchronous startup.
if (command) {
  command.executable = "invalid-mutated-executable";
  command.args.splice(0, command.args.length, "invalid-mutated-argument");
}
process.on("disconnect", () => {
  void stop(0);
});
process.on("SIGTERM", () => {
  void stop(0);
});
process.on("SIGINT", () => {
  void stop(0);
});
process.on("message", (message) => {
  if (message.type === "write")
    writer.write(message.text, (error) => {
      void notify({ type: "written", id: message.id, error: error?.code });
    });
  if (message.type === "close") void stop(0);
  // Test-only fault injection targets the actual owned ChildProcess handle, never a user PID.
  if (message.type === "pause-writer") {
    writer.child.kill("SIGSTOP");
    void notify({ type: "paused" });
  }
  if (message.type === "kill-writer") writer.child.kill("SIGKILL");
});
try {
  await writer.start();
  await notify({
    type: "ready",
    writerPid: writer.pid,
    descriptor: writer.descriptorKind,
    argv: writer.child.spawnargs,
  });
} catch {
  await stop(1);
}
