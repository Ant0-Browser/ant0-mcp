// Fixture self-entry and startup faults, selected solely by the owning test parent.
const args = process.argv.slice(2);
if (!process.connected || !process.send || args.length !== 1) process.exit(1);
switch (args[0]) {
  case "--ant0-internal=mcp-output-worker-v1": {
    const { runOutputWorker } = await import("../../dist/output-worker-body.js");
    runOutputWorker();
    break;
  }
  case "silent":
    setInterval(() => {}, 1000);
    break;
  case "malformed":
    process.send({ type: "ready", descriptor: "file" });
    break;
  case "early-exit":
    process.exit(0);
    break;
  case "disconnect":
    process.disconnect();
    setInterval(() => {}, 1000);
    break;
  default:
    process.exit(1);
}
