import { rmSync } from "node:fs";
import { join } from "node:path";
import type { KeyScope } from "../src/key-contract.js";
import { ID, inventoryProfile, mockDaemon } from "./helpers.js";
import { createKey, keyStatus, readyFile } from "./key-helpers.js";

export const KEY = createKey.credential;
export const READ_SCOPES: KeyScope[] = ["status:read", "profiles:read", "proxies:read"];
export const OPERATE_SCOPES: KeyScope[] = [...READ_SCOPES, "profiles:run", "profiles:stop"];

/** A mock daemon that answers as a delegated key with `scopes`; the master token file is absent. */
export async function keyDaemon(scopes: KeyScope[] = OPERATE_SCOPES) {
  const file = readyFile();
  file.create.scopes = [...scopes];
  file.key!.scopes = [...scopes];
  const daemon = await mockDaemon((req, res) => {
    const url = new URL(req.url!, "http://localhost");
    res.setHeader("content-type", "application/json");
    if (req.method === "POST" && url.pathname === `/v1/profiles/${ID}/stop`) {
      res.writeHead(204);
      return void res.end();
    }
    const data =
      url.pathname === "/v1/automation/status"
        ? keyStatus(file)
        : url.pathname === `/v1/inventory/profiles/${ID}`
          ? inventoryProfile
          : url.pathname === "/v1/inventory/proxies"
            ? { items: [inventoryProfile.proxy], total: 1 }
            : { items: [inventoryProfile], total: 1 };
    res.end(JSON.stringify(data));
  });
  rmSync(join(daemon.home, "ant0d.pid"));
  rmSync(join(daemon.home, "ant0d.token"));
  return { daemon, env: { ANT0_API_KEY: KEY, ANT0D_PORT: String(daemon.port) } };
}
