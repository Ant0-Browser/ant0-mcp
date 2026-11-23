import { serveStdio, McpFailure } from "../../dist/index.js";
import { CallPermits } from "../../dist/call-permits.js";

// Test-only delay AFTER real HTTP cleanup. It keeps the first eight holders draining until
// explicitly released, so queued cancellation and EOF are tested without microtask timing luck.
let release;
const drain = new Promise((resolve) => {
  release = resolve;
});
const jobs = [];
let pool;
const report = (stage) =>
  new Promise((resolve) => {
    if (!process.connected) return resolve();
    process.send(
      {
        type: "permits",
        stage,
        active: pool?.active ?? 0,
        waiting: pool?.waiting.size ?? 0,
        submitted: jobs.length,
      },
      () => resolve(),
    );
  });
const run = CallPermits.prototype.run;
CallPermits.prototype.run = function (signal, action) {
  pool = this;
  const hold = jobs.length < 8;
  const job = run.call(this, signal, async () => {
    try {
      return await action();
    } finally {
      if (hold) await drain;
    }
  });
  jobs.push(job);
  void report("submitted");
  void job.then(
    () => report("settled"),
    () => report("settled"),
  );
  return job;
};
const control = (message) => {
  if (message.type === "release-drain") release();
};
process.on("message", control);
try {
  await serveStdio({ home: process.argv[2] });
} catch (error) {
  process.stderr.write(`mcp: ${error instanceof McpFailure ? error.message : "adapter failed"}\n`);
  process.exitCode = 1;
} finally {
  await report("closed");
  release();
  await Promise.allSettled(jobs);
  await report("drained");
  process.off("message", control);
  if (process.connected) process.disconnect();
}
