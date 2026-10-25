// @effect-diagnostics nodeBuiltinImport:off -- Hash the reported sign-in; never persist an email.
import { createHash } from "node:crypto";
/**
 * Which subscription a provider instance is signed in to, as the provider's
 * own status reports it, and the server's memory of it across restarts.
 *
 * A person can sign the same CLI in to another subscription (another account,
 * organization or plan) after a usage limit. Limits and resets belong to the
 * subscription that hit them, so recovery compares the subscription a stop
 * happened on with the one the CLI uses now. Only hashes are kept.
 *
 * @module provider/subscriptionIdentity
 */
import type { ServerProvider, ServerProviderUsageLimits } from "@specweave-studio/contracts";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";
import * as Schema from "effect/Schema";

const sha256 = (text: string) => createHash("sha256").update(text, "utf8").digest("hex");
const CODEX_POOL = /^codex:sha256:[a-f0-9]{64}$/;

/**
 * The key of a Claude subscription sign-in from the account the Claude Agent
 * SDK reports at initialization, or undefined when it names no plan (an API
 * key, the Console or a third-party backend) or no email.
 */
export function claudeSubscriptionKey(account: {
  readonly email?: string | undefined;
  readonly organization?: string | undefined;
  readonly subscriptionType?: string | undefined;
}): string | undefined {
  const email = account.email?.trim().toLowerCase();
  const plan = account.subscriptionType?.trim().toLowerCase();
  if (!email || !plan) return undefined;
  return `claude:sha256:${sha256(JSON.stringify([email, account.organization?.trim() || null, plan]))}`;
}

/** The subscription a usage read belongs to: its key, or Codex's account pool. */
export function subscriptionKeyOf(
  limits: ServerProviderUsageLimits | undefined,
): string | undefined {
  if (limits?.subscriptionKey) return limits.subscriptionKey;
  return limits?.quotaPoolId && CODEX_POOL.test(limits.quotaPoolId)
    ? limits.quotaPoolId
    : undefined;
}

/** A signed-in identity: the subscription key and a hash of the email, either may be unknown. */
export interface SubscriptionIdentity {
  readonly key?: string | undefined;
  readonly email?: string | undefined;
}

/**
 * Who a probe says is signed in, or undefined when it does not say: not
 * authenticated, billed to an API key, or neither a key nor an email.
 */
export function signedInIdentity(snapshot: ServerProvider): SubscriptionIdentity | undefined {
  if (snapshot.auth.status !== "authenticated") return undefined;
  if (snapshot.auth.apiKeyBilling === true || snapshot.auth.type === "apiKey") return undefined;
  const key = subscriptionKeyOf(snapshot.usageLimits);
  const email = snapshot.auth.email?.trim().toLowerCase();
  if (!key && !email) return undefined;
  return { ...(key ? { key } : {}), ...(email ? { email: sha256(email) } : {}) };
}

/**
 * Whether two known identities are different subscriptions. Keys decide when
 * both are known; otherwise emails do. Nothing known in common is no proof.
 */
export function identitiesDiffer(a: SubscriptionIdentity, b: SubscriptionIdentity): boolean {
  if (a.key && b.key) return a.key !== b.key;
  return a.email !== undefined && b.email !== undefined && a.email !== b.email;
}

/** The identity to remember after a read: what it reported, keeping a key it could not read for the same person. */
export function nextIdentity(
  previous: SubscriptionIdentity | undefined,
  probed: SubscriptionIdentity | undefined,
): SubscriptionIdentity | undefined {
  if (!probed) return previous;
  if (!previous || identitiesDiffer(previous, probed)) return probed;
  return {
    ...((probed.key ?? previous.key) ? { key: probed.key ?? previous.key } : {}),
    ...((probed.email ?? previous.email) ? { email: probed.email ?? previous.email } : {}),
  };
}

/** What survives a restart for one instance. */
export interface RememberedSubscription {
  readonly identity: SubscriptionIdentity;
  /** When this server first saw that identity replace another one. */
  readonly changedAt?: string | undefined;
}

const Remembered = Schema.Struct({
  version: Schema.Literal(1),
  identity: Schema.Struct({
    key: Schema.optional(Schema.String),
    email: Schema.optional(Schema.String),
  }),
  changedAt: Schema.optional(Schema.String),
});
const decodeRemembered = Schema.decodeUnknownOption(Schema.fromJsonString(Remembered));
const encodeRemembered = Schema.encodeSync(Schema.fromJsonString(Remembered));
const CachedAuth = Schema.Struct({
  auth: Schema.Struct({
    status: Schema.String,
    email: Schema.optional(Schema.String),
    type: Schema.optional(Schema.String),
    apiKeyBilling: Schema.optional(Schema.Boolean),
  }),
  usageLimits: Schema.optional(Schema.Struct({ quotaPoolId: Schema.optional(Schema.String) })),
});
const decodeCachedAuth = Schema.decodeUnknownOption(Schema.fromJsonString(CachedAuth));

export interface SubscriptionMemory {
  readonly load: Effect.Effect<RememberedSubscription | undefined>;
  readonly save: (remembered: RememberedSubscription) => Effect.Effect<void>;
}

/**
 * Remembers an instance's subscription in `<cacheDir>/<instanceId>.account.json`.
 * The first start with no memory falls back to the email of the provider
 * status cache the previous server wrote, so a sign-in changed across an
 * upgrade is still noticed. Reads and writes never fail the caller.
 */
export const makeSubscriptionMemory = (input: {
  readonly cacheDir: string;
  readonly instanceId: string;
  readonly fileSystem: FileSystem.FileSystem;
  readonly path: Path.Path;
}): SubscriptionMemory => {
  const filePath = input.path.join(input.cacheDir, `${input.instanceId}.account.json`);
  const statusCachePath = input.path.join(input.cacheDir, `${input.instanceId}.json`);
  const read = (file: string) =>
    input.fileSystem.readFileString(file).pipe(Effect.orElseSucceed(() => ""));
  return {
    load: Effect.gen(function* () {
      const stored = decodeRemembered((yield* read(filePath)).trim());
      if (stored._tag === "Some") {
        const { key, email } = stored.value.identity;
        if (!key && !email) return undefined;
        return {
          identity: { ...(key ? { key } : {}), ...(email ? { email } : {}) },
          ...(stored.value.changedAt ? { changedAt: stored.value.changedAt } : {}),
        };
      }
      const cached = decodeCachedAuth((yield* read(statusCachePath)).trim());
      if (cached._tag === "None") return undefined;
      const auth = cached.value.auth;
      const email = auth.email?.trim().toLowerCase();
      if (auth.status !== "authenticated" || auth.apiKeyBilling || auth.type === "apiKey" || !email)
        return undefined;
      // Codex's cached pool names the workspace, so a same-email switch
      // across the upgrade is still a change.
      const pool = cached.value.usageLimits?.quotaPoolId;
      return {
        identity: {
          ...(pool && CODEX_POOL.test(pool) ? { key: pool } : {}),
          email: sha256(email),
        },
      };
    }),
    save: (remembered) =>
      Effect.gen(function* () {
        const temporary = `${filePath}.${process.pid}.tmp`;
        yield* input.fileSystem.makeDirectory(input.cacheDir, { recursive: true });
        yield* input.fileSystem.writeFileString(
          temporary,
          `${encodeRemembered({
            version: 1,
            identity: {
              ...(remembered.identity.key ? { key: remembered.identity.key } : {}),
              ...(remembered.identity.email ? { email: remembered.identity.email } : {}),
            },
            ...(remembered.changedAt ? { changedAt: remembered.changedAt } : {}),
          })}\n`,
          { mode: 0o600 },
        );
        yield* input.fileSystem.rename(temporary, filePath);
      }).pipe(Effect.ignoreCause({ log: true })),
  };
};
