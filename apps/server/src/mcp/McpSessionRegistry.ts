// @effect-diagnostics-next-line nodeBuiltinImport:off -- Effect's Crypto has no createHmac.
import * as NodeCrypto from "node:crypto";

import { ProviderInstanceId, ThreadId } from "@specweave-studio/contracts";
import * as Clock from "effect/Clock";
import * as Context from "effect/Context";
import * as Crypto from "effect/Crypto";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Schedule from "effect/Schedule";
import * as Schema from "effect/Schema";
import * as Scope from "effect/Scope";
import * as Semaphore from "effect/Semaphore";
import * as SynchronizedRef from "effect/SynchronizedRef";
import * as SqlClient from "effect/sql/SqlClient";
import { HttpServer } from "effect/http";
import * as NetAddress from "effect/net/NetAddress";

import * as ServerSecretStore from "../auth/ServerSecretStore.ts";
import * as ServerEnvironment from "../environment/ServerEnvironment.ts";
import * as McpInvocationContext from "./McpInvocationContext.ts";
import * as McpProviderSession from "./McpProviderSession.ts";

export interface McpCredentialRequest {
  readonly threadId: ThreadId;
  readonly providerInstanceId: ProviderInstanceId;
  /**
   * When false, the credential is minted without the "preview" capability so
   * the user's choice to withhold agent browser access holds everywhere the
   * token is honored (#7083). Defaults to full access.
   */
  readonly browserToolsAvailable?: boolean;
  readonly capabilities?: ReadonlySet<McpInvocationContext.McpCapability>;
}

export interface McpIssuedCredential {
  readonly config: McpProviderSession.McpProviderSessionConfig;
}

export interface McpSessionRegistryShape {
  /**
   * Issues the thread's credential for a provider instance. The token is
   * derived from a persisted per-install key, the thread, the provider
   * instance and the thread's generation, so issuing again (after a restart,
   * a capability change or a revocation by a released session) yields the
   * same token: every copy an agent already holds keeps working. The record's
   * capabilities are replaced by the request's, effective for every holder.
   */
  readonly issue: (request: McpCredentialRequest) => Effect.Effect<McpIssuedCredential>;
  readonly resolve: (
    rawToken: string,
  ) => Effect.Effect<McpInvocationContext.McpThreadInvocationScope | undefined>;
  /**
   * Records a sign of life for every credential bound to `threadId`. Provider
   * turns call this so that a session which is plainly alive keeps its
   * credential even when it goes a long time without touching an MCP tool.
   */
  readonly touch: (threadId: ThreadId) => Effect.Effect<void>;
  /** Stops honoring a credential until it is issued again; its token value is unchanged. */
  readonly revokeProviderSession: (providerSessionId: string) => Effect.Effect<void>;
  /** Stops honoring the thread's credentials until issued again; token values are unchanged. */
  readonly revokeThread: (threadId: ThreadId) => Effect.Effect<void>;
  /**
   * The same for one provider instance of the thread only. Another instance's
   * session (a provider the thread switched away from, whose background
   * agents may still be working) keeps its credential: calls it makes are
   * checked against who runs the thread now and refused with a reason, not
   * with a 401 that makes its MCP client drop SpecWithCode's tools for good.
   */
  readonly revokeThreadInstance: (
    threadId: ThreadId,
    providerInstanceId: ProviderInstanceId,
  ) => Effect.Effect<void>;
  /**
   * Permanently retires every token the thread was ever issued by advancing
   * its generation (thread archived or deleted, or a suspected leak). The
   * next issue yields a different token. Fails if the retirement could not
   * be made durable (neither the state written nor the key retired); it is
   * still in force for this process, and retrying stores it.
   */
  readonly invalidateThread: (
    threadId: ThreadId,
  ) => Effect.Effect<void, McpCredentialRevocationError>;
  readonly revokeAll: Effect.Effect<void>;
}

export class McpCredentialRevocationError extends Schema.TaggedError<McpCredentialRevocationError>()(
  "McpCredentialRevocationError",
  { threadId: Schema.String },
) {
  override get message(): string {
    return `Could not store the retirement of thread ${this.threadId}'s MCP credentials.`;
  }
}

/**
 * Reports which threads may no longer hold MCP credentials (archived, deleted
 * or unknown). The registry asks on startup, so a retirement whose outbox
 * effect was cancelled or never stored still takes effect after a restart.
 */
export class McpRetiredThreads extends Context.Service<
  McpRetiredThreads,
  {
    readonly retiredAmong: (
      threadIds: ReadonlyArray<ThreadId>,
    ) => Effect.Effect<ReadonlyArray<ThreadId>, unknown>;
  }
>()("specweave-studio/mcp/McpRetiredThreads") {}

export class McpSessionRegistry extends Context.Service<
  McpSessionRegistry,
  McpSessionRegistryShape
>()("specweave-studio/mcp/McpSessionRegistry") {}

/** Registry credentials always belong to a provider session, so their scope has a thread. */
interface CredentialRecord {
  readonly tokenHash: string;
  readonly scope: McpInvocationContext.McpThreadInvocationScope;
  readonly lastAliveAt: number;
}

interface RegistryState {
  readonly records: ReadonlyMap<string, CredentialRecord>;
  readonly generations: ReadonlyMap<string, number>;
}

export interface McpSessionRegistryOptions {
  readonly livenessWindowMs?: number;
  readonly now?: () => number;
  /**
   * Where the derivation key, the credential records (token hashes only) and
   * the per-thread credential files live. Defaults to the server's
   * `ServerSecretStore` when one is provided; without either the registry
   * uses an ephemeral key and keeps nothing across restarts.
   */
  readonly secretStore?: ServerSecretStore.ServerSecretStore["Service"];
  /** Defaults to the `McpRetiredThreads` service when one is provided. */
  readonly retiredThreads?: McpRetiredThreads["Service"];
}

/**
 * How long a credential outlives the last sign of life from its provider
 * session.
 *
 * Liveness is refreshed both by MCP traffic and by `touch` on every provider
 * turn, so a session that is still doing work never expires no matter how long
 * it goes between browser tool calls. This window therefore only bounds
 * credentials whose session died without a clean stop — the normal paths
 * (`stopSession`, `stopAll`) revoke eagerly and do not wait for it.
 *
 * The bound matters because `/mcp` is mounted outside the environment auth
 * stack and is reachable on whatever host the server binds to, so this token is
 * the only thing guarding the `studio-code` toolkits on a remote-reachable server.
 */
const DEFAULT_LIVENESS_WINDOW_MS = 24 * 60 * 60 * 1_000;

/** Liveness is written back at most this often per credential; issue and revoke write at once. */
const LIVENESS_PERSIST_INTERVAL_MS = 10 * 60 * 1_000;

const CREDENTIAL_KEY_SECRET = "mcp-credential-key";
const CREDENTIAL_KEY_BYTES = 32;
const CREDENTIAL_STATE_SECRET = "mcp-credentials";
const TOKEN_DERIVATION_LABEL = "specwithcode-mcp-credential/v1";

const PersistedRecord = Schema.Struct({
  tokenHash: Schema.String,
  threadId: Schema.String,
  providerSessionId: Schema.String,
  providerInstanceId: Schema.String,
  capabilities: Schema.Array(Schema.String),
  issuedAt: Schema.Number,
  lastAliveAt: Schema.Number,
});

const PersistedState = Schema.Struct({
  version: Schema.Literal(1),
  environmentId: Schema.String,
  /** Fingerprint of the key the state was recorded under. */
  keyId: Schema.String,
  generations: Schema.Array(Schema.Struct({ threadId: Schema.String, generation: Schema.Number })),
  records: Schema.Array(PersistedRecord),
});
type PersistedState = typeof PersistedState.Type;

const decodePersistedState = Schema.decodeUnknownEffect(Schema.fromJsonString(PersistedState));
const encodePersistedState = Schema.encodeEffect(Schema.fromJsonString(PersistedState));

const bytesToHex = (bytes: Uint8Array): string =>
  Array.from(bytes, (byte) => byte.toString(16).padStart(2, "0")).join("");

const keyIdOf = (key: Uint8Array): string =>
  NodeCrypto.createHmac("sha256", key).update(`${TOKEN_DERIVATION_LABEL}\0key-id`).digest("hex");

// One file per thread and provider instance: a process left over from the
// thread's previous provider must not pick up another instance's credential.
const credentialFileSecretName = (
  environmentId: string,
  threadId: string,
  providerInstanceId: string,
) =>
  `mcp-session-${NodeCrypto.createHash("sha256")
    .update(`${environmentId}\0${threadId}\0${providerInstanceId}`)
    .digest("hex")
    .slice(0, 32)}`;

// A wildcard bind is reachable on loopback, which is where the provider
// subprocesses run; anything else is announced as the address it bound.
const getHttpMcpEndpointHost = (address: NetAddress.IpAddress): string =>
  NetAddress.isUnspecified(address)
    ? "127.0.0.1"
    : NetAddress.formatUrlHostString(NetAddress.formatIp(address));

const makeWithOptions = Effect.fn("McpSessionRegistry.make")(function* (
  options: McpSessionRegistryOptions = {},
) {
  const crypto = yield* Crypto.Crypto;
  const environment = yield* ServerEnvironment.ServerEnvironment;
  const environmentId = yield* environment.getEnvironmentId;
  const httpServer = yield* HttpServer.HttpServer;
  const secretStore =
    options.secretStore ??
    Option.getOrUndefined(yield* Effect.serviceOption(ServerSecretStore.ServerSecretStore));
  const retiredThreads =
    options.retiredThreads ?? Option.getOrUndefined(yield* Effect.serviceOption(McpRetiredThreads));
  const currentTimeMillis = options.now ? Effect.sync(options.now) : Clock.currentTimeMillis;
  const livenessWindowMs = options.livenessWindowMs ?? DEFAULT_LIVENESS_WINDOW_MS;
  const livenessPersistIntervalMs = Math.min(
    LIVENESS_PERSIST_INTERVAL_MS,
    Math.max(1, Math.floor(livenessWindowMs / 4)),
  );
  const endpoint = NetAddress.isInetAddress(httpServer.address)
    ? `http://${getHttpMcpEndpointHost(httpServer.address.address)}:${httpServer.address.port}/mcp`
    : "http://127.0.0.1/mcp";

  const deriveToken = (threadId: string, providerInstanceId: string, generation: number) =>
    NodeCrypto.createHmac("sha256", derivationKey)
      .update(
        `${TOKEN_DERIVATION_LABEL}\0${environmentId}\0${threadId}\0${providerInstanceId}\0${generation}`,
      )
      .digest("base64url");

  const hashToken = (token: string) =>
    crypto
      .digest("SHA-256", new TextEncoder().encode(token))
      .pipe(Effect.map(bytesToHex), Effect.orDie);

  const restore = (persisted: PersistedState, timestamp: number): RegistryState => {
    const records = new Map<string, CredentialRecord>();
    for (const record of persisted.records) {
      if (timestamp - record.lastAliveAt > livenessWindowMs) continue;
      records.set(record.tokenHash, {
        tokenHash: record.tokenHash,
        lastAliveAt: record.lastAliveAt,
        scope: {
          environmentId,
          requestNamespace: record.providerSessionId,
          thread: {
            threadId: ThreadId.make(record.threadId),
            providerSessionId: record.providerSessionId,
            providerInstanceId: ProviderInstanceId.make(record.providerInstanceId),
          },
          client: undefined,
          capabilities: new Set(record.capabilities.filter(McpInvocationContext.isMcpCapability)),
          issuedAt: record.issuedAt,
        },
      });
    }
    return {
      records,
      generations: new Map(
        persisted.generations.map((entry) => [entry.threadId, entry.generation] as const),
      ),
    };
  };

  const emptyState: RegistryState = { records: new Map(), generations: new Map() };
  const generateKey = crypto.randomBytes(CREDENTIAL_KEY_BYTES).pipe(Effect.orDie);

  /**
   * Loads the key and the state recorded under it. Generations are what keep
   * an invalidated thread's old tokens dead, so the state is only trusted
   * with the exact key (by fingerprint) and environment it was written for.
   * Anything else (a missing, truncated or unreadable key or state, a state
   * of another key or environment) starts over with a new key, which retires
   * every earlier token instead of resetting generations under the old key.
   * The new key reaches the store with the first persisted state.
   */
  const loadKeyAndState = (
    store: ServerSecretStore.ServerSecretStore["Service"],
    timestamp: number,
  ) =>
    Effect.gen(function* () {
      const storedKey = yield* store.get(CREDENTIAL_KEY_SECRET);
      const storedState = yield* store.get(CREDENTIAL_STATE_SECRET);
      if (Option.isNone(storedKey) && Option.isNone(storedState)) return undefined;
      if (Option.isSome(storedKey) && storedKey.value.length === CREDENTIAL_KEY_BYTES) {
        const key = storedKey.value;
        const restored = Option.isNone(storedState)
          ? Option.none()
          : yield* decodePersistedState(new TextDecoder().decode(storedState.value)).pipe(
              Effect.option,
            );
        if (
          Option.isSome(restored) &&
          restored.value.environmentId === environmentId &&
          restored.value.keyId === keyIdOf(key)
        ) {
          return {
            key,
            state: restore(restored.value, timestamp),
            // Expired records included: their thread may have been retired
            // by an invalidation that never reached the store.
            persistedThreadIds: [
              ...new Set(restored.value.records.map((record) => ThreadId.make(record.threadId))),
            ],
          };
        }
      }
      yield* Effect.logWarning(
        "MCP credential state does not match its key; rotating the credential key.",
      );
      return undefined;
    }).pipe(
      Effect.catch((cause) =>
        Effect.logWarning("MCP credential state is unreadable; rotating the credential key.", {
          cause,
        }).pipe(Effect.as(undefined)),
      ),
    );

  const initialTimestamp = yield* currentTimeMillis;
  const loaded =
    secretStore === undefined ? undefined : yield* loadKeyAndState(secretStore, initialTimestamp);
  const derivationKey: Uint8Array = loaded?.key ?? (yield* generateKey);
  const keyId = keyIdOf(derivationKey);
  const initialState = loaded?.state ?? emptyState;
  const state = yield* SynchronizedRef.make<RegistryState>(initialState);
  const persistedAliveAt = new Map<string, number>(
    Array.from(initialState.records, ([tokenHash, record]) => [tokenHash, record.lastAliveAt]),
  );
  /** Whether the store holds `derivationKey`; false until a new key is first written. */
  let keyStored = loaded !== undefined;
  /** Set while the store may still honor something this process revoked. */
  let revocationPending = false;
  const writeLock = yield* Semaphore.make(1);
  // Issue and invalidation each change the state, persist it and publish or
  // remove credential files; serializing them keeps a slow issue from
  // republishing a token that an invalidation retired meanwhile.
  const mutationLock = yield* Semaphore.make(1);

  /**
   * Writes the current records (hashes only) and generations, then the key if
   * the store lacks it. Serialized and always from the latest state, so
   * the last write wins with the newest data. The state names its key's
   * fingerprint, so a partial write (new key, old state or the reverse) never
   * restores: the next start rotates the key instead.
   */
  const persistOrFail: Effect.Effect<void, unknown> =
    secretStore === undefined
      ? Effect.void
      : writeLock.withPermits(1)(
          Effect.gen(function* () {
            const current = yield* SynchronizedRef.get(state);
            const records = Array.from(current.records.values());
            const encoded = yield* encodePersistedState({
              version: 1,
              environmentId,
              keyId,
              generations: Array.from(current.generations, ([threadId, generation]) => ({
                threadId,
                generation,
              })),
              records: records.map((record) => ({
                tokenHash: record.tokenHash,
                threadId: record.scope.thread.threadId,
                providerSessionId: record.scope.thread.providerSessionId,
                providerInstanceId: record.scope.thread.providerInstanceId,
                capabilities: Array.from(record.scope.capabilities),
                issuedAt: record.scope.issuedAt,
                lastAliveAt: record.lastAliveAt,
              })),
            });
            yield* secretStore.set(CREDENTIAL_STATE_SECRET, new TextEncoder().encode(encoded));
            // The key follows its state: until it lands, the stored state
            // names a key the store lacks, which only ever rotates.
            if (!keyStored) {
              yield* secretStore.set(CREDENTIAL_KEY_SECRET, derivationKey);
              keyStored = true;
            }
            revocationPending = false;
            persistedAliveAt.clear();
            for (const record of records) {
              persistedAliveAt.set(record.tokenHash, record.lastAliveAt);
            }
          }),
        );

  /** Liveness only: a failed write is logged and retried with the next change. */
  const persist: Effect.Effect<void> = persistOrFail.pipe(
    Effect.catchCause((cause) =>
      Effect.logWarning("Could not persist MCP credentials.", { cause }),
    ),
  );

  const registryScope = Option.getOrUndefined(yield* Effect.serviceOption(Scope.Scope));
  let revocationRetrying = false;
  /**
   * Keeps writing a revocation that could not be stored until a write lands,
   * also while no MCP traffic or provider turn would write it.
   */
  const retryPendingRevocation: Effect.Effect<void> = Effect.suspend(() => {
    if (revocationRetrying) return Effect.void;
    revocationRetrying = true;
    const retry = Effect.suspend(() => (revocationPending ? persistOrFail : Effect.void)).pipe(
      Effect.retry(Schedule.min([Schedule.exponential("1 second"), Schedule.spaced("1 minute")])),
      Effect.ensuring(
        Effect.sync(() => {
          revocationRetrying = false;
        }),
      ),
    );
    return (
      registryScope === undefined ? Effect.forkDetach(retry) : Effect.forkIn(retry, registryScope)
    ).pipe(Effect.asVoid);
  });

  /**
   * For changes that take authority away (revocation, invalidation, fewer
   * capabilities), which must survive a restart. If the state cannot be
   * written, removing the key makes the next start rotate it, retiring every
   * token. If that fails too, every later write retries until one lands.
   */
  const persistRevocation: Effect.Effect<void> =
    secretStore === undefined
      ? Effect.void
      : persistOrFail.pipe(
          Effect.catchCause((cause) =>
            Effect.logError("Could not persist an MCP credential revocation; retiring the key.", {
              cause,
            }).pipe(
              Effect.andThen(secretStore.remove(CREDENTIAL_KEY_SECRET)),
              Effect.andThen(
                Effect.sync(() => {
                  // The store has no key now; a later write stores this one
                  // again together with the state that records the revocation.
                  keyStored = false;
                }),
              ),
              Effect.catchCause((removeCause) =>
                Effect.sync(() => {
                  revocationPending = true;
                }).pipe(
                  Effect.andThen(retryPendingRevocation),
                  Effect.andThen(
                    Effect.logError(
                      "Could not retire the MCP credential key; a revoked credential may be honored after a restart until a write succeeds.",
                      { cause: removeCause },
                    ),
                  ),
                ),
              ),
            ),
          ),
        );

  const persistIfLivenessStale = (tokenHashes: Iterable<string>, timestamp: number) =>
    Effect.suspend(() => {
      if (revocationPending) return persistRevocation;
      for (const tokenHash of tokenHashes) {
        const persistedAt = persistedAliveAt.get(tokenHash);
        if (persistedAt === undefined || timestamp - persistedAt >= livenessPersistIntervalMs) {
          return persist;
        }
      }
      return Effect.void;
    });

  const credentialFilePath =
    secretStore?.pathOf === undefined
      ? undefined
      : (threadId: string, providerInstanceId: string) =>
          secretStore.pathOf!(
            credentialFileSecretName(environmentId, threadId, providerInstanceId),
          );

  const writeCredentialFile = (
    threadId: string,
    providerInstanceId: string,
    authorizationHeader: string,
  ) =>
    secretStore === undefined
      ? Effect.void
      : secretStore
          .set(
            credentialFileSecretName(environmentId, threadId, providerInstanceId),
            new TextEncoder().encode(
              JSON.stringify({ endpoint, authorization: authorizationHeader }),
            ),
          )
          .pipe(
            Effect.catchCause((cause) =>
              Effect.logWarning("Could not write the MCP credential file.", { threadId, cause }),
            ),
          );

  const removeCredentialFile = (threadId: string, providerInstanceId: string) =>
    secretStore === undefined
      ? Effect.void
      : secretStore
          .remove(credentialFileSecretName(environmentId, threadId, providerInstanceId))
          .pipe(
            Effect.catchCause((cause) =>
              Effect.logWarning("Could not remove the MCP credential file.", { threadId, cause }),
            ),
          );

  /**
   * Drops credentials without a recent sign of life. While liveness cannot be
   * stored, a stored credential also lapses one window (plus the write
   * interval) after its last stored sign of life, so a credential that only a
   * failed revocation left on disk cannot be kept alive indefinitely.
   */
  const isAlive = (record: CredentialRecord, timestamp: number) => {
    if (timestamp - record.lastAliveAt > livenessWindowMs) return false;
    const storedAliveAt = persistedAliveAt.get(record.tokenHash);
    return (
      storedAliveAt === undefined ||
      timestamp - storedAliveAt <= livenessWindowMs + livenessPersistIntervalMs
    );
  };

  const pruneDead = (records: ReadonlyMap<string, CredentialRecord>, timestamp: number) => {
    const next = new Map(Array.from(records).filter(([, record]) => isAlive(record, timestamp)));
    return next.size === records.size ? records : next;
  };

  const issue: McpSessionRegistryShape["issue"] = Effect.fn("McpSessionRegistry.issue")(
    function* (request) {
      return yield* mutationLock.withPermits(1)(issueUnlocked(request));
    },
  );

  const issueUnlocked = Effect.fnUntraced(function* (request: McpCredentialRequest) {
    const issuedAt = yield* currentTimeMillis;
    const freshProviderSessionId = yield* crypto.randomUUIDv4.pipe(Effect.orDie);
    const threadId = ThreadId.make(request.threadId);
    const providerInstanceId = ProviderInstanceId.make(request.providerInstanceId);
    const browserToolsAvailable = request.browserToolsAvailable ?? true;
    const capabilities = new Set<McpInvocationContext.McpCapability>([
      "orchestration",
      "worktree",
      "pull-requests",
      ...(request.capabilities ?? (browserToolsAvailable ? (["preview"] as const) : [])),
    ]);
    const { rawToken, scope, reduced } = yield* SynchronizedRef.modifyEffect(state, (current) =>
      Effect.gen(function* () {
        const generation = current.generations.get(threadId) ?? 0;
        const rawToken = deriveToken(threadId, providerInstanceId, generation);
        const tokenHash = yield* hashToken(rawToken);
        const records = new Map(pruneDead(current.records, issuedAt));
        const existing = records.get(tokenHash);
        // A credential that is still honored keeps its identity, so a live
        // session's record of it stays accurate across re-issues.
        const providerSessionId =
          existing?.scope.thread.providerSessionId ?? freshProviderSessionId;
        const scope: McpInvocationContext.McpThreadInvocationScope = {
          environmentId,
          requestNamespace: providerSessionId,
          thread: { threadId, providerSessionId, providerInstanceId },
          client: undefined,
          capabilities,
          issuedAt: existing?.scope.issuedAt ?? issuedAt,
        };
        records.set(tokenHash, { tokenHash, scope, lastAliveAt: issuedAt });
        const reduced =
          existing !== undefined &&
          Array.from(existing.scope.capabilities).some(
            (capability) => !capabilities.has(capability),
          );
        return [
          { rawToken, scope, reduced },
          { ...current, records },
        ] as const;
      }),
    );
    const authorizationHeader = `Bearer ${rawToken}`;
    yield* reduced ? persistRevocation : persist;
    yield* writeCredentialFile(threadId, providerInstanceId, authorizationHeader);
    const credentialFile = credentialFilePath?.(threadId, providerInstanceId);
    return {
      config: {
        environmentId,
        threadId: scope.thread.threadId,
        providerSessionId: scope.thread.providerSessionId,
        providerInstanceId: scope.thread.providerInstanceId,
        endpoint,
        authorizationHeader,
        ...(credentialFile === undefined ? {} : { credentialFile }),
        browserToolsAvailable: scope.capabilities.has("preview"),
        capabilities: scope.capabilities,
      },
    };
  });

  const resolve: McpSessionRegistryShape["resolve"] = Effect.fn("McpSessionRegistry.resolve")(
    function* (rawToken) {
      if (rawToken.length === 0) return undefined;
      const tokenHash = yield* hashToken(rawToken);
      const timestamp = yield* currentTimeMillis;
      const scope = yield* SynchronizedRef.modify(state, (current) => {
        const records = pruneDead(current.records, timestamp);
        const record = records.get(tokenHash);
        if (!record) return [undefined, { ...current, records }] as const;
        const next = new Map(records);
        next.set(tokenHash, { ...record, lastAliveAt: timestamp });
        return [record.scope, { ...current, records: next }] as const;
      });
      if (scope !== undefined) yield* persistIfLivenessStale([tokenHash], timestamp);
      return scope;
    },
  );

  const touch: McpSessionRegistryShape["touch"] = Effect.fn("McpSessionRegistry.touch")(
    function* (threadId) {
      const timestamp = yield* currentTimeMillis;
      const touched = yield* SynchronizedRef.modify(state, (current) => {
        const records = pruneDead(current.records, timestamp);
        const next = new Map(records);
        const touched: Array<string> = [];
        for (const [tokenHash, record] of records) {
          if (record.scope.thread.threadId === threadId) {
            next.set(tokenHash, { ...record, lastAliveAt: timestamp });
            touched.push(tokenHash);
          }
        }
        return [touched, { ...current, records: next }] as const;
      });
      yield* persistIfLivenessStale(touched, timestamp);
    },
  );

  /** Retires several threads with one write, so a crash cannot store only some of them. */
  const invalidateThreadsUnlocked = Effect.fnUntraced(function* (
    threadIds: ReadonlyArray<ThreadId>,
  ) {
    if (threadIds.length === 0) return;
    const retiring = new Set<string>(threadIds);
    const removed = yield* SynchronizedRef.modify(state, (current) => {
      const generations = new Map(current.generations);
      for (const threadId of retiring) {
        generations.set(threadId, (current.generations.get(threadId) ?? 0) + 1);
      }
      const removed: Array<readonly [ThreadId, string]> = [];
      const records = new Map(current.records);
      for (const [tokenHash, record] of current.records) {
        if (!retiring.has(record.scope.thread.threadId)) continue;
        removed.push([record.scope.thread.threadId, record.scope.thread.providerInstanceId]);
        records.delete(tokenHash);
      }
      return [removed, { generations, records }] as const;
    });
    // The new generations must be durable, or the retired tokens would be
    // honored again after a restart.
    yield* persistRevocation;
    // Files of already-revoked records stay behind, but they can only hold
    // a token of a retired generation, which is never honored again.
    yield* Effect.forEach(
      removed,
      ([threadId, providerInstanceId]) => removeCredentialFile(threadId, providerInstanceId),
      { discard: true },
    );
    if (revocationPending) {
      return yield* new McpCredentialRevocationError({ threadId: threadIds.join(", ") });
    }
  });

  // Always stored, even if nothing changed here: the store may still hold a
  // credential this process never loaded or failed to revoke.
  const revokeWhere = (predicate: (record: CredentialRecord) => boolean) =>
    SynchronizedRef.update(state, (current) => ({
      ...current,
      records: new Map(Array.from(current.records).filter(([, record]) => !predicate(record))),
    })).pipe(Effect.andThen(persistRevocation));

  // Retire persisted credentials of threads archived or deleted meanwhile. If
  // that cannot be checked, retire them all: a thread that is still active
  // gets a new token with its next session, which its bridge picks up from
  // the credential file.
  const persistedThreadIds = loaded?.persistedThreadIds ?? [];
  if (retiredThreads !== undefined && persistedThreadIds.length > 0) {
    const retired = yield* Effect.result(retiredThreads.retiredAmong(persistedThreadIds));
    if (retired._tag === "Success") {
      yield* invalidateThreadsUnlocked(retired.success).pipe(Effect.ignore);
    } else {
      yield* Effect.logWarning("Could not check restored MCP credentials; retiring them.", {
        cause: retired.failure,
      });
      yield* invalidateThreadsUnlocked(persistedThreadIds).pipe(Effect.ignore);
    }
  }

  return McpSessionRegistry.of({
    issue,
    resolve,
    touch,
    revokeProviderSession: Effect.fn("McpSessionRegistry.revokeProviderSession")(
      function* (providerSessionId) {
        yield* revokeWhere((record) => record.scope.thread.providerSessionId === providerSessionId);
      },
    ),
    revokeThread: Effect.fn("McpSessionRegistry.revokeThread")(function* (threadId) {
      yield* revokeWhere((record) => record.scope.thread.threadId === threadId);
    }),
    revokeThreadInstance: Effect.fn("McpSessionRegistry.revokeThreadInstance")(
      function* (threadId, providerInstanceId) {
        yield* revokeWhere(
          (record) =>
            record.scope.thread.threadId === threadId &&
            record.scope.thread.providerInstanceId === providerInstanceId,
        );
      },
    ),
    invalidateThread: Effect.fn("McpSessionRegistry.invalidateThread")(function* (threadId) {
      yield* mutationLock.withPermits(1)(invalidateThreadsUnlocked([threadId]));
    }),
    revokeAll: SynchronizedRef.update(state, (current) => ({
      ...current,
      records: new Map(),
    })).pipe(Effect.andThen(persistRevocation)),
  });
});

let activeMcpSessionRegistry: McpSessionRegistryShape | undefined;

const makeActive = (options?: McpSessionRegistryOptions) =>
  Effect.acquireRelease(
    makeWithOptions(options).pipe(
      Effect.tap((registry) =>
        Effect.sync(() => {
          activeMcpSessionRegistry = registry;
        }),
      ),
    ),
    (registry) =>
      Effect.sync(() => {
        if (activeMcpSessionRegistry === registry) {
          activeMcpSessionRegistry = undefined;
        }
      }),
  );

const make = makeActive();

export const layer = Layer.effect(McpSessionRegistry, make);

/** Retired: archived, deleted, or absent from the orchestration projection. */
export const layerRetiredThreads = Layer.effect(
  McpRetiredThreads,
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;
    return McpRetiredThreads.of({
      retiredAmong: (threadIds) =>
        sql<{ readonly thread_id: string }>`
          SELECT thread_id FROM orchestration_v2_projection_threads
          WHERE thread_id IN ${sql.in(threadIds)}
            AND archived_at IS NULL AND deleted_at IS NULL
        `.pipe(
          Effect.map((rows) => {
            const active = new Set(rows.map((row) => row.thread_id));
            return threadIds.filter((threadId) => !active.has(threadId));
          }),
        ),
    });
  }),
);

export const issueActiveMcpCredential = (
  request: McpCredentialRequest,
): Effect.Effect<McpIssuedCredential | undefined> =>
  activeMcpSessionRegistry
    ? activeMcpSessionRegistry
        .revokeThreadInstance(request.threadId, request.providerInstanceId)
        .pipe(Effect.andThen(activeMcpSessionRegistry.issue(request)))
    : Effect.undefined;

/**
 * Refreshes the liveness of a thread's MCP credential. Called on every provider
 * turn so an active session is never mistaken for an abandoned one.
 */
export const touchActiveMcpThread = (threadId: ThreadId): Effect.Effect<void> =>
  activeMcpSessionRegistry ? activeMcpSessionRegistry.touch(threadId) : Effect.void;

/** Retires the thread's credentials for good (thread archived or deleted). */
export const invalidateActiveMcpThread = (
  threadId: ThreadId,
): Effect.Effect<void, McpCredentialRevocationError> =>
  Effect.suspend(() => {
    McpProviderSession.clearMcpProviderSession(threadId);
    return activeMcpSessionRegistry
      ? activeMcpSessionRegistry.invalidateThread(threadId)
      : Effect.void;
  });

const revokeActiveMcpThread = (threadId: ThreadId): Effect.Effect<void> =>
  activeMcpSessionRegistry ? activeMcpSessionRegistry.revokeThread(threadId) : Effect.void;

const revokeAllActiveMcpCredentials = (): Effect.Effect<void> =>
  activeMcpSessionRegistry ? activeMcpSessionRegistry.revokeAll : Effect.void;

/** Exposed for tests. */
export const __testing = {
  make: makeWithOptions,
  makeActive,
};
