// @effect-diagnostics nodeBuiltinImport:off - token generation and constant-time comparison.
import * as NodeCrypto from "node:crypto";

/**
 * A transfer grant lets one destination read one folder for one copy, and
 * nothing else: the source serves only paths in that operation's manifest, every
 * request presents the bearer and is checked again, and the grant ends when the
 * copy is committed, cancelled or released. Only a hash of the token is stored,
 * as with app sessions; the token itself travels once, inside the person's own
 * authenticated app connection, from the source to the destination.
 */
export const TRANSFER_GRANT_SCOPE = "folder-transfer:read" as const;
const TOKEN_PREFIX = "swcft_";
/** Idle limit: a copy that stops pulling for a day must be offered again. */
export const TRANSFER_GRANT_IDLE_MS = 24 * 60 * 60 * 1000;
/** Hard limit for one copy, however long it keeps pulling. */
export const TRANSFER_GRANT_MAX_MS = 7 * 24 * 60 * 60 * 1000;

export interface TransferGrantRecord {
  readonly operationId: string;
  readonly scope: typeof TRANSFER_GRANT_SCOPE;
  readonly tokenSha256: string;
  /** The real folder served; requests can only name manifest paths below it. */
  readonly root: string;
  readonly projectId: string;
  readonly destinationEnvironmentId: string;
  readonly issuedAt: number;
  readonly lastUsedAt: number;
  readonly revokedAt: number | null;
  readonly revokedReason: string | null;
}

export type TransferGrantRefusal = "missing" | "invalid" | "operation" | "expired" | "revoked";

const digest = (token: string) => NodeCrypto.createHash("sha256").update(token).digest("hex");

export function mintTransferGrant(input: {
  readonly operationId: string;
  readonly root: string;
  readonly projectId: string;
  readonly destinationEnvironmentId: string;
  readonly now: number;
}): { readonly token: string; readonly record: TransferGrantRecord } {
  const token = `${TOKEN_PREFIX}${NodeCrypto.randomBytes(32).toString("base64url")}`;
  return {
    token,
    record: {
      operationId: input.operationId,
      scope: TRANSFER_GRANT_SCOPE,
      tokenSha256: digest(token),
      root: input.root,
      projectId: input.projectId,
      destinationEnvironmentId: input.destinationEnvironmentId,
      issuedAt: input.now,
      lastUsedAt: input.now,
      revokedAt: null,
      revokedReason: null,
    },
  };
}

export function transferGrantExpiresAt(record: TransferGrantRecord): number {
  return Math.min(
    record.issuedAt + TRANSFER_GRANT_MAX_MS,
    record.lastUsedAt + TRANSFER_GRANT_IDLE_MS,
  );
}

/** The bearer from an `Authorization` header, or null. */
export function bearerToken(header: string | undefined | null): string | null {
  if (!header) return null;
  const match = /^Bearer\s+(\S+)$/i.exec(header.trim());
  return match?.[1] ?? null;
}

/**
 * Checks one request. Returns the refreshed record (its last use moved to now)
 * or the refusal; callers answer every refusal with the same 401 or 404.
 */
export function verifyTransferGrant(
  record: TransferGrantRecord | null,
  request: { readonly operationId: string; readonly token: string | null; readonly now: number },
):
  | { readonly ok: true; readonly record: TransferGrantRecord }
  | { readonly ok: false; readonly reason: TransferGrantRefusal } {
  if (!request.token) return { ok: false, reason: "missing" };
  if (!record) return { ok: false, reason: "operation" };
  const presented = Buffer.from(digest(request.token), "hex");
  const stored = Buffer.from(record.tokenSha256, "hex");
  if (presented.length !== stored.length || !NodeCrypto.timingSafeEqual(presented, stored))
    return { ok: false, reason: "invalid" };
  if (record.operationId !== request.operationId || record.scope !== TRANSFER_GRANT_SCOPE)
    return { ok: false, reason: "operation" };
  if (record.revokedAt !== null) return { ok: false, reason: "revoked" };
  if (request.now >= transferGrantExpiresAt(record)) return { ok: false, reason: "expired" };
  return { ok: true, record: { ...record, lastUsedAt: request.now } };
}

export function revokeTransferGrant(
  record: TransferGrantRecord,
  reason: string,
  now: number,
): TransferGrantRecord {
  return record.revokedAt !== null
    ? record
    : { ...record, revokedAt: now, revokedReason: reason.slice(0, 200) };
}
