import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { discoverDaemon } from "../src/api/index.js";

const dirs: string[] = [];
afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});
const home = () => {
  const dir = mkdtempSync(join(tmpdir(), "ant0-mcp-discovery-"));
  dirs.push(dir);
  return dir;
};

describe("discoverDaemon ANT0D_HOST", () => {
  it.each([
    ["127.0.0.1", "http://127.0.0.1:1234"],
    ["127.0.0.5", "http://127.0.0.5:1234"],
    ["localhost", "http://localhost:1234"],
    ["::1", "http://[::1]:1234"],
    ["[::1]", "http://[::1]:1234"],
  ])("accepts the loopback host %s", (host, baseUrl) => {
    const found = discoverDaemon({ env: { ANT0D_HOST: host, ANT0D_PORT: "1234" }, home: home() });
    expect(found.baseUrl).toBe(baseUrl);
  });

  it.each(["evil.example", "10.0.0.5", "0.0.0.0", "127.0.0.999", "192.168.1.2", "[::]"])(
    "ignores the non-loopback host %s and keeps the default",
    (host) => {
      const found = discoverDaemon({ env: { ANT0D_HOST: host, ANT0D_PORT: "1234" }, home: home() });
      expect(found.baseUrl).toBe("http://127.0.0.1:1234");
    },
  );
});
