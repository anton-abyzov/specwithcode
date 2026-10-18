import * as DateTime from "effect/DateTime";
import type {
  StudioFleetWorkerAccess,
  StudioFleetWorkers,
  StudioFleetWorkersProblem,
} from "@specweave-studio/contracts/studioFleet";
import { StudioFleetWorkerAccess as WorkerAccessSchema } from "@specweave-studio/contracts/studioFleet";
import * as KeyedLock from "@specweave-studio/shared/KeyedLock";
import * as Clock from "effect/Clock";
import * as Context from "effect/Context";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Ref from "effect/Ref";
import * as Schedule from "effect/Schedule";
import * as Schema from "effect/Schema";

import * as ServerSecretStore from "../auth/ServerSecretStore.ts";
import * as ServerEnvironment from "../environment/ServerEnvironment.ts";
import type { FleetTarget } from "../studioFleet.ts";
import * as FleetTargets from "./FleetTargets.ts";
import {
  canRenewWorkerGrant,
  mintWorkerGrant,
  renewWorkerGrant,
  WorkerGrantRenewError,
  revokeWorkerSessions,
  sessionIdOfToken,
  WorkerGrantMintError,
  workerClientName,
} from "./workerGrantMint.ts";

/** Renewal starts this long before a grant expires. */
const RENEW_BEFORE = Duration.days(7);
const MINT_INTERVAL = Duration.minutes(1);
const RENEWAL_INTERVAL = Duration.minutes(5);

const secretName = (machineId: string) => `fleet-worker-grant-${machineId}`;

const GrantFields = {
  machineId: Schema.String,
  environmentId: Schema.String,
  origin: Schema.String,
  resource: Schema.String,
  accessToken: Schema.String,
  expiresAt: Schema.String,
  access: WorkerAccessSchema,
  clientLabel: Schema.String,
  mintedAt: Schema.String,
  status: Schema.Literals(["active", "revoked"]),
};
const StoredGrant = Schema.Union([
  Schema.Struct({ ...GrantFields, v: Schema.Literal(1) }),
  Schema.Struct({
    ...GrantFields,
    v: Schema.Literal(2),
    coordinatorEnvironmentId: Schema.String,
    ongoingConsent: Schema.Boolean,
  }),
]);
type StoredGrant = typeof StoredGrant.Type;
const StoredGrantJson = Schema.fromJsonString(StoredGrant);
const decodeStoredGrant = Schema.decodeUnknownOption(StoredGrantJson);
const encodeStoredGrant = Schema.encodeSync(StoredGrantJson);

export const FleetWorkerGrantErrorReason = Schema.Literals([
  "unknown_machine",
  "not_allowed",
  "revoked",
  "expired",
  "rate_limited",
  "storage",
  "config",
]);

export class FleetWorkerGrantError extends Schema.TaggedError<FleetWorkerGrantError>()(
  "FleetWorkerGrantError",
  { reason: FleetWorkerGrantErrorReason, cause: Schema.optional(Schema.Defect()) },
) {
  override get message(): string {
    return {
      unknown_machine: "This machine is not configured.",
      not_allowed: "This server is not allowed to start workers on that machine.",
      revoked: "That machine revoked this server's worker access.",
      expired: "This server's worker access on that machine expired.",
      rate_limited: "Wait a minute before allowing workers on this machine again.",
      storage: "The worker grant could not be saved.",
      config: "Private machine configuration could not be read securely.",
    }[this.reason];
  }
}

/** What remote calls need: the configured target and a live grant on it. Never leaves the server. */
export interface WorkerCredential {
  readonly target: FleetTarget;
  readonly accessToken: string;
  readonly access: StudioFleetWorkerAccess;
  readonly expiresAt: string;
}

export class FleetWorkerGrants extends Context.Service<
  FleetWorkerGrants,
  {
    /** The status the UI and `studio_machine_list` show; never the token. */
    readonly status: (machineId: string) => Effect.Effect<StudioFleetWorkers>;
    readonly allow: (input: {
      readonly machineId: string;
      readonly access: StudioFleetWorkerAccess;
      readonly pairingCode?: string | undefined;
    }) => Effect.Effect<StudioFleetWorkers, FleetWorkerGrantError>;
    readonly stop: (
      machineId: string,
    ) => Effect.Effect<
      { readonly workers: StudioFleetWorkers; readonly remoteSessionKept: boolean },
      FleetWorkerGrantError
    >;
    readonly credential: (
      machineId: string,
    ) => Effect.Effect<WorkerCredential, FleetWorkerGrantError>;
    /** The other machine answered 401 to this token: it was revoked there. Never re-minted. */
    readonly reportRejected: (machineId: string, accessToken: string) => Effect.Effect<void>;
    readonly reportAccepted: (machineId: string) => Effect.Effect<void>;
    /** One renewal pass over every grant that is due. */
    readonly renewDue: Effect.Effect<void>;
  }
>()("specweave-studio/fleet/FleetWorkerGrants") {}

const make = Effect.gen(function* () {
  const targets = yield* FleetTargets.FleetTargets;
  const secrets = yield* ServerSecretStore.ServerSecretStore;
  const environment = yield* ServerEnvironment.ServerEnvironment;
  const localEnvironmentId = yield* environment.getEnvironmentId;
  const clientName = workerClientName(localEnvironmentId);
  const lock = yield* KeyedLock.make<string>();
  const lastMint = yield* Ref.make<ReadonlyMap<string, number>>(new Map());
  const lastRenewal = yield* Ref.make<ReadonlyMap<string, number>>(new Map());
  const problems = yield* Ref.make<ReadonlyMap<string, StudioFleetWorkersProblem>>(new Map());

  const loadConfig = targets.load.pipe(
    Effect.mapError((cause) => new FleetWorkerGrantError({ reason: "config", cause })),
  );
  const findTarget = (machineId: string) =>
    loadConfig.pipe(
      Effect.flatMap((config) => {
        const target = config?.machines.find((machine) => machine.id === machineId);
        return target === undefined
          ? Effect.fail(new FleetWorkerGrantError({ reason: "unknown_machine" }))
          : Effect.succeed(target);
      }),
    );

  /** A stored grant counts only while it names the machine as configured now. */
  const readGrant = (target: FleetTarget) =>
    secrets.get(secretName(target.id)).pipe(
      Effect.map((bytes) =>
        Option.flatMap(bytes, (value) => decodeStoredGrant(new TextDecoder().decode(value))).pipe(
          Option.filter(
            (grant) =>
              grant.machineId === target.id &&
              grant.environmentId === target.environmentId &&
              grant.origin === target.url &&
              Number.isFinite(Date.parse(grant.expiresAt)) &&
              grant.resource === `${target.url}/mcp` &&
              grant.clientLabel === clientName &&
              (grant.v === 1 || grant.coordinatorEnvironmentId === localEnvironmentId),
          ),
          Option.getOrUndefined,
        ),
      ),
      Effect.orElseSucceed(() => undefined),
    );
  const writeGrant = (grant: StoredGrant) =>
    secrets
      .set(secretName(grant.machineId), new TextEncoder().encode(encodeStoredGrant(grant)))
      .pipe(Effect.mapError((cause) => new FleetWorkerGrantError({ reason: "storage", cause })));

  const describe = (target: FleetTarget, grant: StoredGrant | undefined, now: number) =>
    Effect.gen(function* () {
      const problem = (yield* Ref.get(problems)).get(target.id) ?? null;
      const renewable =
        canRenewWorkerGrant(target) &&
        (grant === undefined || (grant.v === 2 && grant.ongoingConsent));
      if (grant === undefined)
        return {
          status: "not_allowed",
          access: null,
          expiresAt: null,
          renewable,
          problem,
        } as const;
      const expiresAtMs = Date.parse(grant.expiresAt);
      const status =
        grant.status === "revoked"
          ? ("revoked" as const)
          : expiresAtMs <= now
            ? ("expired" as const)
            : !renewable && expiresAtMs - now < Duration.toMillis(RENEW_BEFORE)
              ? ("expiring" as const)
              : ("allowed" as const);
      return { status, access: grant.access, expiresAt: grant.expiresAt, renewable, problem };
    });

  const status: FleetWorkerGrants["Service"]["status"] = (machineId) =>
    Effect.gen(function* () {
      const target = yield* findTarget(machineId);
      return yield* describe(target, yield* readGrant(target), yield* Clock.currentTimeMillis);
    }).pipe(
      Effect.orElseSucceed((): StudioFleetWorkers => ({
        status: "not_allowed",
        access: null,
        expiresAt: null,
        renewable: false,
        problem: null,
      })),
    );

  const setProblem = (machineId: string, problem: StudioFleetWorkersProblem | null) =>
    Ref.update(problems, (current) => {
      const next = new Map(current);
      if (problem === null) next.delete(machineId);
      else next.set(machineId, problem);
      return next;
    });

  /** The session a stored grant signs in as on the other machine, when its token names it. */
  const heldSessionIds = (grant: StoredGrant | undefined) => {
    const sessionId = grant === undefined ? undefined : sessionIdOfToken(grant.accessToken);
    return sessionId === undefined ? [] : [sessionId];
  };

  /** Revokes this server's sessions there; never fails, a lost machine reads as incomplete. */
  const revokeSessions = (
    target: FleetTarget,
    options: {
      readonly keepNewest: boolean;
      readonly sessionIds: ReadonlyArray<string>;
      readonly keepSessionId?: string | undefined;
    },
  ) =>
    Effect.tryPromise(() =>
      revokeWorkerSessions({ fetcher: targets.fetch, target, clientName, ...options }),
    ).pipe(
      Effect.orElseSucceed(() => ({ revoked: 0, complete: false, swept: false })),
      Effect.tap((result) =>
        result.complete || !target.managementToken
          ? Effect.void
          : Effect.logWarning("Could not revoke every worker session on a fleet machine.", {
              machineId: target.id,
              revoked: result.revoked,
            }),
      ),
    );

  /** Mints and stores a grant; a mint failure is recorded as the machine's problem. */
  const mintAndStore = (
    target: FleetTarget,
    access: StudioFleetWorkerAccess,
    pairingCode: string | undefined,
  ) =>
    Effect.gen(function* () {
      const now = yield* Clock.currentTimeMillis;
      const minted = yield* Effect.tryPromise({
        try: () =>
          mintWorkerGrant({
            fetcher: targets.fetch,
            target,
            access,
            clientName,
            pairingCode,
            now: () => now,
          }),
        catch: (error) =>
          error instanceof WorkerGrantMintError ? error : new WorkerGrantMintError("unreachable"),
      }).pipe(Effect.result);
      const previous = yield* readGrant(target);
      if (minted._tag === "Failure") {
        yield* setProblem(target.id, minted.failure.reason);
        yield* Effect.logWarning("Could not allow workers on a fleet machine.", {
          machineId: target.id,
          reason: minted.failure.reason,
        });
        return false;
      }
      yield* writeGrant({
        v: 2,
        coordinatorEnvironmentId: localEnvironmentId,
        ongoingConsent: canRenewWorkerGrant(target),
        machineId: target.id,
        environmentId: target.environmentId,
        origin: target.url,
        resource: minted.success.resource,
        accessToken: minted.success.accessToken,
        expiresAt: minted.success.expiresAt,
        access,
        clientLabel: clientName,
        mintedAt: DateTime.formatIso(DateTime.makeUnsafe(now)),
        status: "active",
      });
      yield* setProblem(target.id, null);
      // An explicit Allow replaces the old session there. Renewal retains its ID.
      yield* revokeSessions(target, {
        keepNewest: true,
        sessionIds: heldSessionIds(previous),
        keepSessionId: sessionIdOfToken(minted.success.accessToken),
      });
      yield* Effect.logInfo("Allowed workers on a fleet machine.", {
        machineId: target.id,
        access,
      });
      return true;
    });

  /** Called only under the machine lock, with persisted explicit consent. */
  const renewIfDue = (target: FleetTarget, grant: StoredGrant | undefined) =>
    Effect.gen(function* () {
      if (
        !grant ||
        grant.v !== 2 ||
        !grant.ongoingConsent ||
        grant.status !== "active" ||
        !canRenewWorkerGrant(target)
      )
        return;
      const now = yield* Clock.currentTimeMillis;
      const remaining = Date.parse(grant.expiresAt) - now;
      if (!Number.isFinite(remaining) || remaining >= Duration.toMillis(RENEW_BEFORE)) return;
      const previous = (yield* Ref.get(lastRenewal)).get(target.id);
      if (previous !== undefined && now - previous < Duration.toMillis(MINT_INTERVAL)) return;
      yield* Ref.update(lastRenewal, (current) => new Map(current).set(target.id, now));
      const renewed = yield* Effect.tryPromise({
        try: () =>
          renewWorkerGrant({
            fetcher: targets.fetch,
            target,
            accessToken: grant.accessToken,
            coordinatorEnvironmentId: localEnvironmentId,
            now: () => now,
          }),
        catch: (error) =>
          error instanceof WorkerGrantRenewError || error instanceof WorkerGrantMintError
            ? error
            : new WorkerGrantRenewError("unreachable"),
      }).pipe(Effect.result);
      if (renewed._tag === "Failure") {
        const reason = renewed.failure.reason;
        if (reason === "revoked" || reason === "missing" || reason === "invalid") {
          // An authoritative refusal is sticky. Only a new explicit Allow can replace it.
          yield* writeGrant({ ...grant, status: "revoked", ongoingConsent: false });
          yield* setProblem(target.id, null);
        } else yield* setProblem(target.id, reason);
        return;
      }
      yield* writeGrant({
        ...grant,
        accessToken: renewed.success.accessToken,
        expiresAt: renewed.success.expiresAt,
      });
      yield* setProblem(target.id, null);
    });

  /**
   * A grant stored for this machine at the address it had before `fleet add`
   * moved it. Workers were allowed on the machine (pinned by its environment
   * id), not on an address, so an active one is minted again at the new
   * address with the same access. Called only under the machine lock.
   */
  const carryToNewAddress = (target: FleetTarget) =>
    Effect.gen(function* () {
      if (!target.managementToken) return;
      const moved = yield* secrets.get(secretName(target.id)).pipe(
        Effect.map((bytes) =>
          Option.flatMap(bytes, (value) => decodeStoredGrant(new TextDecoder().decode(value))).pipe(
            Option.filter(
              (grant) =>
                grant.machineId === target.id &&
                grant.environmentId === target.environmentId &&
                grant.origin !== target.url &&
                grant.status === "active" &&
                grant.clientLabel === clientName &&
                (grant.v === 1 || grant.coordinatorEnvironmentId === localEnvironmentId),
            ),
            Option.getOrUndefined,
          ),
        ),
        Effect.orElseSucceed(() => undefined),
      );
      if (moved === undefined) return;
      const now = yield* Clock.currentTimeMillis;
      if (!(Date.parse(moved.expiresAt) > now)) return;
      const previous = (yield* Ref.get(lastMint)).get(target.id);
      if (previous !== undefined && now - previous < Duration.toMillis(MINT_INTERVAL)) return;
      yield* Ref.update(lastMint, (current) => new Map(current).set(target.id, now));
      if (yield* mintAndStore(target, moved.access, undefined))
        yield* Effect.logInfo("Moved worker access to a fleet machine's new address.", {
          machineId: target.id,
        });
    });

  const allow: FleetWorkerGrants["Service"]["allow"] = (input) =>
    Effect.gen(function* () {
      const target = yield* findTarget(input.machineId);
      const now = yield* Clock.currentTimeMillis;
      const rateLimited = yield* Ref.modify(lastMint, (current) => {
        const previous = current.get(target.id);
        if (previous !== undefined && now - previous < Duration.toMillis(MINT_INTERVAL))
          return [true, current] as const;
        return [false, new Map(current).set(target.id, now)] as const;
      });
      if (rateLimited) return yield* new FleetWorkerGrantError({ reason: "rate_limited" });
      return yield* lock.withLock(
        target.id,
        Effect.gen(function* () {
          yield* mintAndStore(target, input.access, input.pairingCode);
          return yield* describe(target, yield* readGrant(target), yield* Clock.currentTimeMillis);
        }),
      );
    });

  const stop: FleetWorkerGrants["Service"]["stop"] = (machineId) =>
    Effect.gen(function* () {
      const target = yield* findTarget(machineId);
      return yield* lock.withLock(
        target.id,
        Effect.gen(function* () {
          const held = heldSessionIds(yield* readGrant(target));
          yield* secrets
            .remove(secretName(target.id))
            .pipe(
              Effect.mapError((cause) => new FleetWorkerGrantError({ reason: "storage", cause })),
            );
          yield* setProblem(target.id, null);
          const revoked = yield* revokeSessions(target, { keepNewest: false, sessionIds: held });
          return {
            workers: yield* describe(target, undefined, yield* Clock.currentTimeMillis),
            // Without the sweep only the session this server knew of is gone.
            remoteSessionKept: !revoked.complete || (held.length === 0 && !revoked.swept),
          };
        }),
      );
    });

  const credential: FleetWorkerGrants["Service"]["credential"] = (machineId) =>
    Effect.gen(function* () {
      const target = yield* findTarget(machineId);
      return yield* lock.withLock(
        target.id,
        Effect.gen(function* () {
          yield* carryToNewAddress(target);
          yield* renewIfDue(target, yield* readGrant(target));
          const grant = yield* readGrant(target);
          if (grant === undefined)
            return yield* new FleetWorkerGrantError({ reason: "not_allowed" });
          if (grant.status === "revoked")
            return yield* new FleetWorkerGrantError({ reason: "revoked" });
          if (
            !Number.isFinite(Date.parse(grant.expiresAt)) ||
            Date.parse(grant.expiresAt) <= (yield* Clock.currentTimeMillis)
          )
            return yield* new FleetWorkerGrantError({ reason: "expired" });
          return {
            target,
            accessToken: grant.accessToken,
            access: grant.access,
            expiresAt: grant.expiresAt,
          };
        }),
      );
    });

  const reportRejected: FleetWorkerGrants["Service"]["reportRejected"] = (machineId, token) =>
    Effect.gen(function* () {
      const target = yield* findTarget(machineId);
      yield* lock.withLock(
        target.id,
        Effect.gen(function* () {
          const grant = yield* readGrant(target);
          if (grant === undefined || grant.accessToken !== token || grant.status === "revoked")
            return;
          yield* writeGrant({ ...grant, status: "revoked" });
          yield* Effect.logWarning("A fleet machine revoked this server's worker access.", {
            machineId,
          });
        }),
      );
    }).pipe(Effect.ignore);

  // Retained for callers; recent activity is no longer an authorization signal.
  const reportAccepted: FleetWorkerGrants["Service"]["reportAccepted"] = () => Effect.void;

  const renewDue: FleetWorkerGrants["Service"]["renewDue"] = Effect.gen(function* () {
    const config = yield* loadConfig;
    for (const target of config?.machines ?? []) {
      yield* lock
        .withLock(
          target.id,
          Effect.gen(function* () {
            yield* carryToNewAddress(target);
            yield* renewIfDue(target, yield* readGrant(target));
          }),
        )
        .pipe(
          Effect.catch((error) =>
            Effect.logWarning("Worker grant renewal failed.", {
              machineId: target.id,
              reason: error.reason,
            }),
          ),
        );
    }
  }).pipe(
    Effect.catch((error) =>
      Effect.logWarning("Worker grant renewal pass failed.", { reason: error.reason }),
    ),
  );

  return FleetWorkerGrants.of({
    status,
    allow,
    stop,
    credential,
    reportRejected,
    reportAccepted,
    renewDue,
  });
});

export const layer = Layer.effect(FleetWorkerGrants, make);

/** Recovers idle/offline grants in bounded passes, including after server restart. */
export const layerRenewal = Layer.effectDiscard(
  Effect.gen(function* () {
    const grants = yield* FleetWorkerGrants;
    yield* grants.renewDue.pipe(
      // A crashed pass must not end recovery.
      Effect.catchCause(() => Effect.logWarning("Worker grant renewal pass crashed.")),
      Effect.repeat(Schedule.spaced(RENEWAL_INTERVAL)),
      Effect.forkScoped,
    );
  }),
);
