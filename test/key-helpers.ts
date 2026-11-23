import { execFileSync } from "node:child_process";
import { join } from "node:path";
import type { CredentialFile, CreateKey, KeyMetadata } from "../src/key-contract.js";
import { ID } from "./helpers.js";

export const USER = "11223344-1234-4234-8234-123456789abc";
export const WORKSPACE = "22334455-1234-4234-8234-123456789abc";
export const DEVICE = "A".repeat(26);
export const KEY_ID = "33445566-1234-4234-8234-123456789abc";
export const expectedContext = {
  user_id: USER,
  workspace_id: WORKSPACE,
  device_id: DEVICE,
  device_sign_pub: Buffer.alloc(32, 7).toString("base64"),
};
export const createKey: CreateKey = {
  id: KEY_ID,
  credential: `ant0_sk_v1_${KEY_ID}_${Buffer.alloc(32, 8).toString("base64url")}`,
  name: "Test read key",
  scopes: ["status:read", "profiles:read", "proxies:read"],
  lifetime_seconds: 2_592_000,
};
export function metadata(create: CreateKey = createKey): KeyMetadata {
  const created = Date.now();
  return {
    id: create.id,
    workspace_id: WORKSPACE,
    delegated_user_id: USER,
    device_id: DEVICE,
    name: create.name,
    scopes: [...create.scopes],
    role_ceiling: "starter",
    created_at: new Date(created).toISOString(),
    expires_at: new Date(created + create.lifetime_seconds * 1000).toISOString(),
    last_used_at: null,
    revoked_at: null,
    status: "active",
  };
}
export function readyFile(): CredentialFile {
  return {
    schema: "ant0-api-key/v1",
    expected: { ...expectedContext },
    create: structuredClone(createKey),
    phase: "ready",
    key: metadata(),
  };
}
export function keyStatus(file: CredentialFile) {
  return {
    principal: {
      kind: "api_key",
      key_id: file.create.id,
      user_id: USER,
      workspace_id: WORKSPACE,
      device_id: DEVICE,
      role_ceiling: "starter",
      current_role: "starter",
      scopes: file.create.scopes,
      expires_at: file.key!.expires_at,
    },
    daemon: { ok: true, version: "0.1.0", uptime_s: 1 },
    licence: {
      state: "active",
      mode: "enforce",
      plan: "free",
      limits: { profiles: 5, seats: 1 },
      used: 2,
      used_local: 1,
      features: ["api", "mcp"],
      billing: "lapsed",
      expires_at: null,
      grace_until: null,
      online: true,
      last_refresh_at: new Date().toISOString(),
    },
  };
}
export function privateTestDirectory(path: string) {
  if (process.platform !== "win32") return;
  execFileSync(
    join(
      process.env.SystemRoot ?? "C:\\Windows",
      "System32",
      "WindowsPowerShell",
      "v1.0",
      "powershell.exe",
    ),
    [
      "-NoProfile",
      "-NonInteractive",
      "-Command",
      `
$ErrorActionPreference='Stop'
$sid=[Security.Principal.WindowsIdentity]::GetCurrent().User
$acl=New-Object Security.AccessControl.DirectorySecurity
$acl.SetOwner($sid)
$acl.SetAccessRuleProtection($true,$false)
$acl.AddAccessRule((New-Object Security.AccessControl.FileSystemAccessRule($sid,'FullControl','ContainerInherit,ObjectInherit','None','Allow')))
$system=New-Object Security.Principal.SecurityIdentifier('S-1-5-18')
$acl.AddAccessRule((New-Object Security.AccessControl.FileSystemAccessRule($system,'FullControl','ContainerInherit,ObjectInherit','None','Allow')))
Set-Acl -LiteralPath $env:ANT0_TEST_PRIVATE -AclObject $acl
`,
    ],
    { env: { ...process.env, ANT0_TEST_PRIVATE: path }, stdio: "ignore", windowsHide: true },
  );
}
