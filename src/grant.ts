import { unwrap, type Ant0Client } from "./api/index.js";
import type { Connection } from "./connection.js";
import { fileGrant, grantFromStatus, type KeyGrant } from "./key-contract.js";

export async function resolveGrant(
  connection: Connection,
  client: Ant0Client,
  consumer: "api" | "mcp",
  signal?: AbortSignal,
): Promise<KeyGrant | undefined> {
  if (connection.credential) return fileGrant(connection.credential.value);
  if (!connection.apiKey) return undefined;
  const status = unwrap(await client.GET("/v1/automation/status", signal ? { signal } : {}));
  return grantFromStatus(status, connection.token, consumer).grant;
}
