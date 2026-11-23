import { z } from "zod";

export const keyId = z
  .string()
  .regex(/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/);
const date = z.string().datetime().max(40);
const role = z.enum(["owner", "manager", "operator", "starter"]);
const count = z.number().int().min(0).max(Number.MAX_SAFE_INTEGER);
export const readScopes = ["status:read", "profiles:read", "proxies:read"] as const;
export const operationScopes = ["profiles:run", "profiles:stop", "profiles:cdp"] as const;
export const operateScopes = [...readScopes, "profiles:run", "profiles:stop"] as const;
export const keyScopes = [...readScopes, ...operationScopes] as const;
const scopes = z
  .array(z.enum(keyScopes))
  .min(1)
  .max(keyScopes.length)
  .refine((v) => new Set(v).size === v.length);
export type KeyScope = (typeof keyScopes)[number];
export const keyName = z
  .string()
  .min(1)
  .max(200)
  .refine((v) => [...v].length <= 100 && v.trim().length > 0 && !/[\p{Cc}\p{Cs}]/u.test(v));
export const lifetime = z.number().int().min(60).max(31_536_000);
const deviceId = z.string().regex(/^[A-Z2-7]{26}$/);
const publicKey = z.string().refine((v) => {
  const decoded = Buffer.from(v, "base64");
  return decoded.length === 32 && decoded.toString("base64") === v;
});
export const expectedContextSchema = z.object({
  user_id: keyId,
  workspace_id: keyId,
  device_id: deviceId,
  device_sign_pub: publicKey,
});
const metadataShape = {
  id: keyId,
  workspace_id: keyId,
  delegated_user_id: keyId,
  device_id: deviceId,
  name: keyName,
  scopes,
  role_ceiling: role,
  created_at: date,
  expires_at: date,
  last_used_at: date.nullable(),
  revoked_at: date.nullable(),
  status: z.enum(["active", "expired", "revoked"]),
};
export const keyMetadataSchema = z
  .object(metadataShape)
  .refine(
    (v) =>
      Date.parse(v.expires_at) > Date.parse(v.created_at) &&
      (v.status === "revoked") === (v.revoked_at !== null),
  );
export const createKeySchema = z
  .strictObject({
    id: keyId,
    credential: z.string().max(128),
    name: keyName,
    scopes,
    lifetime_seconds: lifetime,
  })
  .refine((v) => {
    const prefix = `ant0_sk_v1_${v.id}_`;
    if (!v.credential.startsWith(prefix)) return false;
    const secret = v.credential.slice(prefix.length);
    const bytes = Buffer.from(secret, "base64url");
    return secret.length === 43 && bytes.length === 32 && bytes.toString("base64url") === secret;
  });
export function matchingMetadata(
  file: { expected: ExpectedContext; create: CreateKey; key?: KeyMetadata | null },
  key: KeyMetadata,
): boolean {
  return (
    key.id === file.create.id &&
    key.workspace_id === file.expected.workspace_id &&
    key.delegated_user_id === file.expected.user_id &&
    key.device_id === file.expected.device_id &&
    [...key.scopes].sort().join() === [...file.create.scopes].sort().join() &&
    Date.parse(key.expires_at) - Date.parse(key.created_at) ===
      file.create.lifetime_seconds * 1000 &&
    (!file.key ||
      (file.key.created_at === key.created_at &&
        file.key.expires_at === key.expires_at &&
        file.key.role_ceiling === key.role_ceiling))
  );
}
export const credentialFileSchema = z
  .strictObject({
    schema: z.literal("ant0-api-key/v1"),
    expected: expectedContextSchema.strict(),
    create: createKeySchema,
    phase: z.enum(["pending", "ready"]),
    key: z.object(metadataShape).strict().nullable(),
  })
  .refine((v) =>
    v.phase === "pending"
      ? v.key === null
      : v.key !== null && keyMetadataSchema.safeParse(v.key).success && matchingMetadata(v, v.key),
  );
export type ExpectedContext = z.infer<typeof expectedContextSchema>;
export type CreateKey = z.infer<typeof createKeySchema>;
export type KeyMetadata = z.infer<typeof keyMetadataSchema>;
export type CredentialFile = z.infer<typeof credentialFileSchema>;
export const credentialResultSchema = z
  .strictObject({
    schema: z.literal("ant0-api-key-result/v1"),
    credential_file_sha256: z.string().regex(/^[0-9a-f]{64}$/),
    key: z.object(metadataShape).strict(),
  })
  .refine((value) => keyMetadataSchema.safeParse(value.key).success);
export type CredentialResult = z.infer<typeof credentialResultSchema>;

const principalSchema = z.object({
  kind: z.literal("api_key"),
  key_id: keyId,
  user_id: keyId,
  workspace_id: keyId,
  device_id: deviceId,
  role_ceiling: role,
  current_role: role,
  scopes,
  expires_at: date,
});
const keyReadStatusSchema = z
  .object({
    state: z.literal("active"),
    mode: z.literal("enforce"),
    plan: z.string().regex(/^[a-z0-9_-]{1,64}$/),
    limits: z.object({ profiles: count, seats: count.min(1) }),
    used: count,
    used_local: count,
    features: z
      .array(z.string().max(64))
      .max(100)
      .transform((v) =>
        v.filter((feature) =>
          ["api", "mcp", "sync", "teams", "priority_support"].includes(feature),
        ),
      ),
    billing: z.enum(["active", "past_due", "lapsed"]),
    expires_at: z.null(),
    grace_until: z.null(),
    online: z.literal(true),
    last_refresh_at: date,
  })
  .refine((v) => v.used >= v.used_local);
const automationStatusSchema = z.object({
  principal: principalSchema,
  daemon: z.object({
    ok: z.literal(true),
    version: z.string().regex(/^[A-Za-z0-9.+-]{1,64}$/),
    uptime_s: count,
  }),
  licence: keyReadStatusSchema,
});
export class CredentialFailure extends Error {
  constructor(message = "invalid private credential file") {
    super(message);
  }
}
/** Allowlisted metadata is still untrusted text. Never echo a credential disguised as a label. */
export function rejectCredentialEcho(value: unknown, credential?: string): void {
  const suffix = credential?.slice(-43);
  const text = JSON.stringify(value);
  if (
    text !== undefined &&
    (/ant0_sk_v1_[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}_[A-Za-z0-9_-]{43}/i.test(
      text,
    ) ||
      (credential !== undefined && text.includes(credential)) ||
      (suffix !== undefined && text.includes(suffix)))
  )
    throw new CredentialFailure("credential echoed in metadata");
}
export function projectKeyMetadata(value: unknown): KeyMetadata {
  const parsed = keyMetadataSchema.safeParse(value);
  if (!parsed.success) throw new CredentialFailure("invalid API key metadata");
  rejectCredentialEcho(parsed.data);
  return parsed.data;
}
export function projectExpectedContext(value: unknown): ExpectedContext {
  const parsed = expectedContextSchema.safeParse(value);
  if (!parsed.success) throw new CredentialFailure("invalid API key context");
  return parsed.data;
}
export function projectKeyList(value: unknown) {
  const parsed = z
    .object({
      items: z.array(keyMetadataSchema).max(100),
      next_cursor: z.string().min(1).max(4096).nullable(),
    })
    .safeParse(value);
  if (
    !parsed.success ||
    new Set(parsed.data.items.map((v) => v.id)).size !== parsed.data.items.length
  )
    throw new CredentialFailure("invalid API key metadata");
  rejectCredentialEcho(parsed.data);
  return parsed.data;
}
export function projectAutomationStatus(
  value: unknown,
  file: CredentialFile,
  consumer: "api" | "mcp" = "api",
) {
  const parsed = automationStatusSchema.safeParse(value);
  if (!parsed.success) throw new CredentialFailure("invalid API key status");
  const p = parsed.data.principal;
  if (
    p.key_id !== file.create.id ||
    p.user_id !== file.expected.user_id ||
    p.workspace_id !== file.expected.workspace_id ||
    p.device_id !== file.expected.device_id ||
    p.expires_at !== file.key?.expires_at ||
    p.role_ceiling !== file.key?.role_ceiling ||
    [...p.scopes].sort().join() !== [...file.create.scopes].sort().join() ||
    !p.scopes.includes("status:read") ||
    Date.parse(p.expires_at) <= Date.now() ||
    !parsed.data.licence.features.includes("api") ||
    (consumer === "mcp" && !parsed.data.licence.features.includes("mcp"))
  )
    throw new CredentialFailure("invalid API key status");
  rejectCredentialEcho(parsed.data, file.create.credential);
  return parsed.data;
}
export const API_KEY_ENV = "ANT0_API_KEY";
export interface KeyGrant {
  id: string;
  credential: string;
  scopes: readonly KeyScope[];
  file?: CredentialFile;
}
export function apiKeyId(credential: string): string | undefined {
  const match =
    /^ant0_sk_v1_([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})_([A-Za-z0-9_-]{43})$/.exec(
      credential,
    );
  if (!match) return undefined;
  const bytes = Buffer.from(match[2]!, "base64url");
  return bytes.length === 32 && bytes.toString("base64url") === match[2] ? match[1] : undefined;
}
export function fileGrant(file: CredentialFile): KeyGrant {
  return {
    id: file.create.id,
    credential: file.create.credential,
    scopes: file.create.scopes,
    file,
  };
}
function sameScopes(a: readonly string[], b: readonly string[]): boolean {
  return [...a].sort().join() === [...b].sort().join();
}
export function grantFromStatus(
  value: unknown,
  credential: string,
  consumer: "api" | "mcp" = "api",
): { grant: KeyGrant; status: z.infer<typeof automationStatusSchema> } {
  const id = apiKeyId(credential);
  const parsed = automationStatusSchema.safeParse(value);
  if (!id || !parsed.success) throw new CredentialFailure("invalid API key status");
  const p = parsed.data.principal;
  if (
    p.key_id !== id ||
    !p.scopes.includes("status:read") ||
    Date.parse(p.expires_at) <= Date.now() ||
    !parsed.data.licence.features.includes("api") ||
    (consumer === "mcp" && !parsed.data.licence.features.includes("mcp"))
  )
    throw new CredentialFailure("invalid API key status");
  rejectCredentialEcho(parsed.data, credential);
  return { grant: { id, credential, scopes: [...p.scopes] }, status: parsed.data };
}
export function projectGrantStatus(
  value: unknown,
  grant: KeyGrant,
  consumer: "api" | "mcp" = "api",
) {
  if (grant.file) return projectAutomationStatus(value, grant.file, consumer);
  const { grant: current, status } = grantFromStatus(value, grant.credential, consumer);
  if (current.id !== grant.id || !sameScopes(current.scopes, grant.scopes))
    throw new CredentialFailure("invalid API key status");
  return status;
}
