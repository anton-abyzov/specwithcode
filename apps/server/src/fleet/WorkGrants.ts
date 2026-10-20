import { EnvironmentId, type ThreadId } from "@specweave-studio/contracts";
import {
  StudioFleetWorkerAccess,
  StudioWorkGrantAccounts,
  StudioWorkGrantOwner,
  StudioWorkGrantProjects,
  WORK_GRANT_REVOKE_GRACE_MS,
  workGrantHopLimit,
  type StudioWorkGrantUpdateInput,
} from "@specweave-studio/contracts/studioFleet";
import * as Clock from "effect/Clock";
import * as Context from "effect/Context";
import * as Crypto from "effect/Crypto";
import * as DateTime from "effect/DateTime";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Path from "effect/Path";
import * as Schema from "effect/Schema";
import * as Semaphore from "effect/Semaphore";

import * as EnvironmentAuth from "../auth/EnvironmentAuth.ts";
import * as ServerConfig from "../config.ts";
import {
  coordinatorOfWorkerLabel,
  type EffectiveWorkGrant,
  newGrantDefaults,
  unscopedGrant,
  type WorkOrigin,
} from "./workGrantPolicy.ts";

/**
 * What this machine lets other machines' coordinators do here: one policy per
 * coordinator machine (projects, sign-ins, whose machine it is, revoked), and
 * where each thread they started came from. The machine doing the work keeps
 * and enforces these; the coordinator's own records are only a convenience.
 *
 * A JSON file, like the remote worker records, so the database stays
 * byte-identical across an update. Written only when something changes.
 */
const FILE_NAME = "work-grants.json";
const ORIGIN_KEEP = Duration.days(90);
const MAX_ORIGINS = 5_000;

export const WorkGrantPolicyRecord = Schema.Struct({
  coordinatorEnvironmentId: Schema.String,
  projects: StudioWorkGrantProjects,
  accounts: StudioWorkGrantAccounts,
  owner: StudioWorkGrantOwner,
  /** Allowed before grants had scopes; unscoped until the user edits it. */
  legacy: Schema.Boolean,
  runtimeCap: Schema.NullOr(StudioFleetWorkerAccess),
  createdAt: Schema.String,
  updatedAt: Schema.String,
  revokedAt: Schema.NullOr(Schema.String),
  interruptAt: Schema.NullOr(Schema.String),
  interruptedAt: Schema.NullOr(Schema.String),
});
export type WorkGrantPolicyRecord = typeof WorkGrantPolicyRecord.Type;

export const WorkOriginRecord = Schema.Struct({
  threadId: Schema.String,
  coordinatorEnvironmentId: Schema.String,
  path: Schema.Array(Schema.String),
  hops: Schema.Int,
  recordedAt: Schema.String,
});
export type WorkOriginRecord = typeof WorkOriginRecord.Type;

const StoreFile = Schema.Struct({
  version: Schema.Literal(1),
  initializedAt: Schema.String,
  policies: Schema.Array(WorkGrantPolicyRecord),
  origins: Schema.Array(WorkOriginRecord),
});
type StoreFile = typeof StoreFile.Type;
const StoreFileJson = Schema.fromJsonString(StoreFile);
const decodeStoreFile = Schema.decodeUnknownEffect(StoreFileJson);
const encodeStoreFile = Schema.encodeEffect(StoreFileJson);

export class WorkGrantsError extends Schema.TaggedError<WorkGrantsError>()("WorkGrantsError", {
  reason: Schema.Literals(["storage", "unknown_grant"]),
  cause: Schema.optional(Schema.Defect()),
}) {
  override get message(): string {
    return this.reason === "unknown_grant"
      ? "No machine with that id may run work here."
      : "This machine could not read or save who may run work on it.";
  }
}

export interface WorkGrantsShape {
  readonly enabled: boolean;
  /**
   * The grant a worker-grant client acts under, noting the runtime cap it
   * signed in with; undefined for every other caller.
   */
  readonly forClient: (
    client:
      | {
          readonly label: string;
          readonly access: string;
        }
      | undefined,
  ) => Effect.Effect<EffectiveWorkGrant | undefined, WorkGrantsError>;
  readonly forCoordinator: (
    coordinatorEnvironmentId: EnvironmentId,
  ) => Effect.Effect<EffectiveWorkGrant, WorkGrantsError>;
  /** Where a thread's work came from, its own record or its root thread's. */
  readonly originOf: (thread: {
    readonly id: ThreadId;
    readonly lineage?: {
      readonly rootThreadId: ThreadId;
      readonly parentThreadId: ThreadId | null;
    };
  }) => Effect.Effect<WorkOrigin | undefined, WorkGrantsError>;
  readonly recordOrigin: (
    threadId: ThreadId,
    origin: WorkOrigin,
  ) => Effect.Effect<void, WorkGrantsError>;
  readonly policies: Effect.Effect<ReadonlyArray<WorkGrantPolicyRecord>, WorkGrantsError>;
  readonly origins: Effect.Effect<ReadonlyArray<WorkOriginRecord>, WorkGrantsError>;
  readonly update: (
    input: StudioWorkGrantUpdateInput,
  ) => Effect.Effect<WorkGrantPolicyRecord, WorkGrantsError>;
  /** Refuses the machine at once; its running threads are interrupted after the grace. */
  readonly revoke: (
    coordinatorEnvironmentId: EnvironmentId,
  ) => Effect.Effect<WorkGrantPolicyRecord, WorkGrantsError>;
  readonly restore: (
    coordinatorEnvironmentId: EnvironmentId,
  ) => Effect.Effect<WorkGrantPolicyRecord, WorkGrantsError>;
  readonly markInterrupted: (
    coordinatorEnvironmentId: EnvironmentId,
  ) => Effect.Effect<void, WorkGrantsError>;
}

/** Without the layer nothing is scoped: grants act as they did before scopes. */
const disabled: WorkGrantsShape = {
  enabled: false,
  forClient: () => Effect.succeed(undefined),
  forCoordinator: (id) => Effect.succeed(unscopedGrant(id)),
  originOf: () => Effect.succeed(undefined),
  recordOrigin: () => Effect.void,
  policies: Effect.succeed([]),
  origins: Effect.succeed([]),
  update: () => Effect.fail(new WorkGrantsError({ reason: "storage" })),
  revoke: () => Effect.fail(new WorkGrantsError({ reason: "storage" })),
  restore: () => Effect.fail(new WorkGrantsError({ reason: "storage" })),
  markInterrupted: () => Effect.void,
};

export class WorkGrants extends Context.Reference<WorkGrantsShape>("studio/fleet/WorkGrants", {
  defaultValue: () => disabled,
}) {}
const isWorkGrantsError = Schema.is(WorkGrantsError);
const decodeWorkerAccess = Schema.decodeUnknownOption(StudioFleetWorkerAccess);

export const effectiveGrant = (record: WorkGrantPolicyRecord): EffectiveWorkGrant =>
  record.legacy
    ? {
        ...unscopedGrant(EnvironmentId.make(record.coordinatorEnvironmentId)),
        revoked: record.revokedAt !== null,
      }
    : {
        coordinatorEnvironmentId: EnvironmentId.make(record.coordinatorEnvironmentId),
        projects: record.projects,
        accounts: record.accounts,
        owner: record.owner,
        hopLimit: workGrantHopLimit(record.owner),
        revoked: record.revokedAt !== null,
      };

const isoOf = (millis: number) => DateTime.formatIso(DateTime.makeUnsafe(millis));

export const make = Effect.gen(function* () {
  const fileSystem = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const crypto = yield* Crypto.Crypto;
  const config = yield* ServerConfig.ServerConfig;
  const auth = yield* EnvironmentAuth.EnvironmentAuth;
  const filePath = path.join(config.stateDir, FILE_NAME);
  const lock = yield* Semaphore.make(1);
  const storageError = (cause: unknown) => new WorkGrantsError({ reason: "storage", cause });

  /** Every coordinator whose worker grant is live here now. */
  const liveCoordinators = auth.listSessions().pipe(
    Effect.map(
      (sessions) =>
        new Set(
          sessions
            .filter((session) => session.subject === EnvironmentAuth.MCP_CLIENT_SUBJECT)
            .flatMap((session) => {
              const id = coordinatorOfWorkerLabel(session.client.label ?? undefined);
              return id === undefined ? [] : [id as string];
            }),
        ),
    ),
  );

  const write = (file: StoreFile) =>
    Effect.gen(function* () {
      const text = yield* encodeStoreFile(file);
      const temporary = `${filePath}.${(yield* crypto.randomUUIDv4).slice(0, 8)}.tmp`;
      yield* Effect.scoped(
        Effect.gen(function* () {
          const handle = yield* fileSystem.open(temporary, { flag: "w", mode: 0o600 });
          yield* handle.writeAll(new TextEncoder().encode(text));
          yield* handle.sync;
        }),
      );
      yield* fileSystem.chmod(temporary, 0o600);
      yield* fileSystem.rename(temporary, filePath);
    }).pipe(Effect.mapError(storageError));

  /**
   * The first read after an update finds no file: every coordinator already
   * allowed here keeps working as before (legacy, unscoped). Grants made
   * after that start scoped.
   */
  const read: Effect.Effect<StoreFile, WorkGrantsError> = Effect.gen(function* () {
    if (yield* fileSystem.exists(filePath))
      return yield* decodeStoreFile(yield* fileSystem.readFileString(filePath));
    const now = isoOf(yield* Clock.currentTimeMillis);
    const existing = yield* liveCoordinators;
    const file: StoreFile = {
      version: 1,
      initializedAt: now,
      policies: [...existing].map((coordinatorEnvironmentId) => ({
        coordinatorEnvironmentId,
        projects: { kind: "all" },
        accounts: { kind: "all" },
        owner: "self",
        legacy: true,
        runtimeCap: null,
        createdAt: now,
        updatedAt: now,
        revokedAt: null,
        interruptAt: null,
        interruptedAt: null,
      })),
      origins: [],
    };
    yield* write(file);
    return file;
  }).pipe(Effect.mapError((cause) => (isWorkGrantsError(cause) ? cause : storageError(cause))));

  const modify = <A>(
    change: (file: StoreFile, now: number) => readonly [A, StoreFile | undefined],
  ) =>
    lock.withPermit(
      Effect.gen(function* () {
        const file = yield* read;
        const [result, next] = change(file, yield* Clock.currentTimeMillis);
        if (next !== undefined) yield* write(next);
        return result;
      }),
    );

  const freshPolicy = (coordinatorEnvironmentId: string, now: number): WorkGrantPolicyRecord => ({
    coordinatorEnvironmentId,
    ...newGrantDefaults("self"),
    legacy: false,
    runtimeCap: null,
    createdAt: isoOf(now),
    updatedAt: isoOf(now),
    revokedAt: null,
    interruptAt: null,
    interruptedAt: null,
  });

  const upsertPolicy = (
    file: StoreFile,
    coordinatorEnvironmentId: string,
    now: number,
    change: (record: WorkGrantPolicyRecord) => WorkGrantPolicyRecord,
  ) => {
    const index = file.policies.findIndex(
      (policy) => policy.coordinatorEnvironmentId === coordinatorEnvironmentId,
    );
    const current =
      index === -1 ? freshPolicy(coordinatorEnvironmentId, now) : file.policies[index]!;
    const next = change(current);
    const changed = index === -1 || JSON.stringify(next) !== JSON.stringify(current);
    return [
      next,
      changed
        ? {
            ...file,
            policies:
              index === -1
                ? [...file.policies, next]
                : file.policies.map((policy, position) => (position === index ? next : policy)),
          }
        : undefined,
    ] as const;
  };

  const forCoordinator: WorkGrantsShape["forCoordinator"] = (coordinatorEnvironmentId) =>
    modify((file, now) =>
      upsertPolicy(file, coordinatorEnvironmentId, now, (record) => record),
    ).pipe(Effect.map(effectiveGrant));

  const forClient: WorkGrantsShape["forClient"] = (client) => {
    const coordinator = coordinatorOfWorkerLabel(client?.label);
    if (client === undefined || coordinator === undefined) return Effect.succeed(undefined);
    const cap = decodeWorkerAccess(client.access);
    return modify((file, now) =>
      upsertPolicy(file, coordinator, now, (record) =>
        cap._tag === "Some" && record.runtimeCap !== cap.value
          ? { ...record, runtimeCap: cap.value }
          : record,
      ),
    ).pipe(Effect.map(effectiveGrant));
  };

  const originOf: WorkGrantsShape["originOf"] = (thread) =>
    lock.withPermit(read).pipe(
      Effect.map((file) => {
        const candidates = [
          thread.id,
          thread.lineage?.parentThreadId ?? undefined,
          thread.lineage?.rootThreadId,
        ].filter((id): id is ThreadId => id !== undefined && id !== null);
        for (const id of candidates) {
          const found = file.origins.find((origin) => origin.threadId === id);
          if (found !== undefined)
            return {
              coordinatorEnvironmentId: EnvironmentId.make(found.coordinatorEnvironmentId),
              path: found.path.map((entry) => EnvironmentId.make(entry)),
              hops: found.hops,
            } satisfies WorkOrigin;
        }
        return undefined;
      }),
    );

  const recordOrigin: WorkGrantsShape["recordOrigin"] = (threadId, origin) =>
    modify((file, now) => {
      const keepAfter = now - Duration.toMillis(ORIGIN_KEEP);
      const origins = [
        ...file.origins.filter(
          (entry) => entry.threadId !== threadId && Date.parse(entry.recordedAt) >= keepAfter,
        ),
        {
          threadId,
          coordinatorEnvironmentId: origin.coordinatorEnvironmentId,
          path: [...origin.path],
          hops: origin.hops,
          recordedAt: isoOf(now),
        },
      ].slice(-MAX_ORIGINS);
      return [undefined, { ...file, origins }] as const;
    });

  const known = (file: StoreFile, coordinatorEnvironmentId: string) =>
    file.policies.some((policy) => policy.coordinatorEnvironmentId === coordinatorEnvironmentId);

  const update: WorkGrantsShape["update"] = (input) =>
    modify((file, now) => {
      if (!known(file, input.coordinatorEnvironmentId)) return [undefined, undefined] as const;
      return upsertPolicy(file, input.coordinatorEnvironmentId, now, (record) => {
        // A legacy record holds the unscoped values, so editing it starts from them.
        const owner = input.owner ?? record.owner;
        // Marking it another person's withdraws the sign-ins unless chosen in the same edit.
        const accounts =
          input.accounts ??
          (owner === "other" && record.owner !== "other"
            ? ({ kind: "none" } as const)
            : record.accounts);
        return {
          ...record,
          projects: input.projects ?? record.projects,
          accounts,
          owner,
          legacy: false,
          updatedAt: isoOf(now),
        };
      });
    }).pipe(
      Effect.flatMap((record) =>
        record === undefined
          ? Effect.fail(new WorkGrantsError({ reason: "unknown_grant" }))
          : Effect.succeed(record),
      ),
    );

  const revokeSessions = (coordinatorEnvironmentId: EnvironmentId) =>
    auth.listSessions().pipe(
      Effect.flatMap((sessions) =>
        Effect.forEach(
          sessions.filter(
            (session) =>
              session.subject === EnvironmentAuth.MCP_CLIENT_SUBJECT &&
              coordinatorOfWorkerLabel(session.client.label ?? undefined) ===
                coordinatorEnvironmentId,
          ),
          (session) => auth.revokeSession(session.sessionId),
          { discard: true },
        ),
      ),
      Effect.mapError(storageError),
    );

  const revoke: WorkGrantsShape["revoke"] = (coordinatorEnvironmentId) =>
    Effect.gen(function* () {
      const record = yield* modify((file, now) => {
        if (!known(file, coordinatorEnvironmentId)) return [undefined, undefined] as const;
        return upsertPolicy(file, coordinatorEnvironmentId, now, (current) =>
          current.revokedAt !== null
            ? current
            : {
                ...current,
                revokedAt: isoOf(now),
                interruptAt: isoOf(now + WORK_GRANT_REVOKE_GRACE_MS),
                interruptedAt: null,
                updatedAt: isoOf(now),
              },
        );
      });
      if (record === undefined) return yield* new WorkGrantsError({ reason: "unknown_grant" });
      // The policy refuses it first, so a session minted meanwhile is refused too.
      yield* revokeSessions(coordinatorEnvironmentId);
      return record;
    });

  const restore: WorkGrantsShape["restore"] = (coordinatorEnvironmentId) =>
    modify((file, now) => {
      if (!known(file, coordinatorEnvironmentId)) return [undefined, undefined] as const;
      return upsertPolicy(file, coordinatorEnvironmentId, now, (current) => ({
        ...current,
        revokedAt: null,
        interruptAt: null,
        interruptedAt: null,
        updatedAt: isoOf(now),
      }));
    }).pipe(
      Effect.flatMap((record) =>
        record === undefined
          ? Effect.fail(new WorkGrantsError({ reason: "unknown_grant" }))
          : Effect.succeed(record),
      ),
    );

  const markInterrupted: WorkGrantsShape["markInterrupted"] = (coordinatorEnvironmentId) =>
    modify((file, now) =>
      upsertPolicy(file, coordinatorEnvironmentId, now, (current) =>
        current.revokedAt === null ? current : { ...current, interruptedAt: isoOf(now) },
      ),
    ).pipe(Effect.asVoid);

  // Settles which grants predate scopes before any new one can be minted.
  yield* lock
    .withPermit(read)
    .pipe(
      Effect.catch((error) =>
        Effect.logWarning("Could not read who may run work here.", { error }),
      ),
    );

  return {
    enabled: true,
    forClient,
    forCoordinator,
    originOf,
    recordOrigin,
    policies: lock.withPermit(read).pipe(Effect.map((file) => file.policies)),
    origins: lock.withPermit(read).pipe(Effect.map((file) => file.origins)),
    update,
    revoke,
    restore,
    markInterrupted,
  } satisfies WorkGrantsShape;
});

export const layer = Layer.effect(WorkGrants, make);
