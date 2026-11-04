/**
 * AccessRequests - apps and devices an agent asks the user to let it use.
 *
 * The card is an `access_request` turn item in the agent's thread; the agent's
 * tool call waits on it (OrchestratorMcpService.requestAccess). The user's
 * Allow writes grants here first, then records the card, so a card that says
 * allowed always has its grants. A grant lasts for one thread or, with
 * "Always on this machine", for every thread on this server. Thread grants
 * are dropped 30 days after they were given; machine grants stay until revoked.
 *
 * Grants live in `<stateDir>/access-grants.json`.
 *
 * @module AccessRequests
 */
import {
  type AccessGrant,
  type AccessGrantListResult,
  AccessRequestError,
  type AccessRequestAnswerInput,
  type AccessRequestScope,
  type AccessRequestSubject,
  CommandId,
  type ThreadId,
} from "@specweave-studio/contracts";
import { HostProcessPlatform } from "@specweave-studio/shared/hostProcess";
import * as Clock from "effect/Clock";
import * as Context from "effect/Context";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Path from "effect/Path";
import * as Schema from "effect/Schema";
import * as Semaphore from "effect/Semaphore";

import { writeFileStringAtomically } from "../atomicWrite.ts";
import * as ServerConfig from "../config.ts";
import * as ThreadManagementService from "../orchestration-v2/ThreadManagementService.ts";

export const ACCESS_GRANTS_FILE = "access-grants.json";

const StoredGrant = Schema.Struct({
  kind: Schema.Literals(["app", "device", "machine", "folder"]),
  key: Schema.String,
  label: Schema.String,
  grantedAt: Schema.String,
});

const GrantsFile = Schema.fromJsonString(
  Schema.Struct({
    version: Schema.Literal(1),
    machine: Schema.Array(StoredGrant),
    threads: Schema.Record(Schema.String, Schema.Array(StoredGrant)),
  }),
);
type GrantsFile = typeof GrantsFile.Type;
const decodeGrantsFile = Schema.decodeUnknownOption(GrantsFile);
const encodeGrantsFile = Schema.encodeSync(GrantsFile);

/** How long a thread grant lasts; machine grants never expire. */
export const THREAD_GRANT_MAX_AGE_MS = 30 * 24 * 60 * 60 * 1000;

/** Whether a thread grant is still in force; an unreadable date is kept rather than guessed at. */
export function isThreadGrantCurrent(grant: { readonly grantedAt: string }, nowMs: number) {
  const at = Date.parse(grant.grantedAt);
  return Number.isNaN(at) || nowMs - at <= THREAD_GRANT_MAX_AGE_MS;
}

/** The grants without thread grants older than 30 days, and without emptied threads. */
export function dropExpiredThreadGrants(file: GrantsFile, nowMs: number): GrantsFile {
  let changed = false;
  const threads: Record<string, ReadonlyArray<typeof StoredGrant.Type>> = {};
  for (const [threadId, list] of Object.entries(file.threads)) {
    const kept = list.filter((grant) => isThreadGrantCurrent(grant, nowMs));
    if (kept.length !== list.length) changed = true;
    if (kept.length > 0) threads[threadId] = kept;
    else changed = true;
  }
  return changed ? { ...file, threads } : file;
}

export class AccessRequests extends Context.Service<
  AccessRequests,
  {
    /** Answers a pending card: Allow writes its grants, then the card records the answer. */
    readonly answer: (input: AccessRequestAnswerInput) => Effect.Effect<void, AccessRequestError>;
    /** Whether a subject key is allowed in this thread, by its own or a machine grant. */
    readonly isAllowed: (threadId: ThreadId, key: string) => Effect.Effect<boolean>;
    /** Whether the thread holds any grant of this kind (its own or the machine's). */
    readonly hasAnyGrant: (
      threadId: ThreadId,
      kind: AccessRequestSubject["kind"],
    ) => Effect.Effect<boolean>;
    /** "Always on this machine" grants, newest first. */
    readonly listMachineGrants: Effect.Effect<AccessGrantListResult>;
    readonly revokeMachineGrant: (
      key: string,
    ) => Effect.Effect<AccessGrantListResult, AccessRequestError>;
  }
>()("specweave-studio/access/AccessRequests") {}

const make = Effect.gen(function* () {
  const config = yield* ServerConfig.ServerConfig;
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const platform = yield* HostProcessPlatform;
  const threadManagement = yield* ThreadManagementService.ThreadManagementService;
  const filePath = path.join(config.stateDir, ACCESS_GRANTS_FILE);

  const loaded = decodeGrantsFile(
    yield* fs.readFileString(filePath).pipe(Effect.orElseSucceed(() => "")),
  );
  const stored: GrantsFile =
    loaded._tag === "Some" ? loaded.value : { version: 1, machine: [], threads: {} };
  let grants = dropExpiredThreadGrants(stored, yield* Clock.currentTimeMillis);
  const writeLock = yield* Semaphore.make(1);
  // One answer at a time, so two Allows on one card cannot both write grants.
  const answerLock = yield* Semaphore.make(1);

  const save = (next: GrantsFile) =>
    Effect.gen(function* () {
      const pruned = dropExpiredThreadGrants(next, yield* Clock.currentTimeMillis);
      yield* writeFileStringAtomically({ filePath, contents: encodeGrantsFile(pruned) }).pipe(
        Effect.provideService(FileSystem.FileSystem, fs),
        Effect.provideService(Path.Path, path),
        Effect.provideService(HostProcessPlatform, platform),
        Effect.mapError((cause) => new AccessRequestError({ reason: "grant_failed", cause })),
      );
      grants = pruned;
    });

  // Expired grants found at start are written away now; the file is rewritten on the next grant otherwise.
  if (grants !== stored) {
    yield* save(grants).pipe(
      Effect.catch((error) =>
        Effect.logWarning("Could not drop expired access grants", { reason: error.reason }),
      ),
    );
  }

  const grantedIn = (list: ReadonlyArray<{ readonly key: string }>, key: string) =>
    list.some((grant) => grant.key === key);

  /** The thread's own grants still in force: one that expired while the server ran counts for nothing. */
  const currentThreadGrants = (threadId: ThreadId) =>
    Effect.map(Clock.currentTimeMillis, (nowMs) =>
      (grants.threads[threadId] ?? []).filter((grant) => isThreadGrantCurrent(grant, nowMs)),
    );

  const isAllowed: AccessRequests["Service"]["isAllowed"] = (threadId, key) =>
    grantedIn(grants.machine, key)
      ? Effect.succeed(true)
      : Effect.map(currentThreadGrants(threadId), (list) => grantedIn(list, key));

  const hasAnyGrant: AccessRequests["Service"]["hasAnyGrant"] = (threadId, kind) =>
    grants.machine.some((grant) => grant.kind === kind)
      ? Effect.succeed(true)
      : Effect.map(currentThreadGrants(threadId), (list) =>
          list.some((grant) => grant.kind === kind),
        );

  /** Adds grants; returns the keys that were new, so a failed record can take them back. */
  const grant = (
    threadId: ThreadId,
    subjects: ReadonlyArray<AccessRequestSubject>,
    scope: AccessRequestScope,
  ) =>
    writeLock.withPermits(1)(
      Effect.gen(function* () {
        const grantedAt = DateTime.formatIso(yield* DateTime.now);
        // An expired thread grant is given again, not taken as already there.
        const current = scope === "machine" ? grants.machine : yield* currentThreadGrants(threadId);
        const added: Array<AccessGrant> = subjects
          .filter(
            (subject, index) =>
              !grantedIn(current, subject.key) &&
              subjects.findIndex((other) => other.key === subject.key) === index,
          )
          .map((subject) => ({
            kind: subject.kind,
            key: subject.key,
            label: subject.label,
            grantedAt,
          }));
        if (added.length === 0) return [] as ReadonlyArray<string>;
        const nextList = [...current, ...added];
        yield* save(
          scope === "machine"
            ? { ...grants, machine: nextList }
            : { ...grants, threads: { ...grants.threads, [threadId]: nextList } },
        );
        return added.map((entry) => entry.key);
      }),
    );

  const ungrant = (threadId: ThreadId, keys: ReadonlyArray<string>, scope: AccessRequestScope) =>
    keys.length === 0
      ? Effect.void
      : writeLock
          .withPermits(1)(
            Effect.gen(function* () {
              const drop = (list: ReadonlyArray<AccessGrant>) =>
                list.filter((entry) => !keys.includes(entry.key));
              yield* save(
                scope === "machine"
                  ? { ...grants, machine: drop(grants.machine) }
                  : {
                      ...grants,
                      threads: {
                        ...grants.threads,
                        [threadId]: drop(grants.threads[threadId] ?? []),
                      },
                    },
              );
            }),
          )
          .pipe(
            Effect.catch((error) =>
              Effect.logWarning("Could not take back access grants", { reason: error.reason }),
            ),
          );

  const answer: AccessRequests["Service"]["answer"] = (input) =>
    // The card is read inside the lock, so an answer that waited sees the one before it.
    answerLock
      .withPermits(1)(
        Effect.gen(function* () {
          yield* Effect.annotateCurrentSpan({
            "orchestration_v2.thread_id": input.threadId,
            "access_request.answer": input.answer.type,
          });
          const records = yield* threadManagement
            .getThreadRecords(input.threadId, ["runs", "turnItems"], {
              turnItemTypes: ["access_request"],
              messageRoles: [],
            })
            .pipe(
              Effect.mapError((cause) => new AccessRequestError({ reason: "load_failed", cause })),
            );
          const item = records.turnItems.find((candidate) => candidate.id === input.turnItemId);
          if (item?.type !== "access_request" || item.runId === null || item.nodeId === null) {
            return yield* new AccessRequestError({ reason: "not_found" });
          }
          if (item.accessStatus !== "pending") {
            return yield* new AccessRequestError({ reason: "already_answered" });
          }
          // The agent waits inside the run that asked; once that run has ended,
          // an Allow would grant access to nobody who asked for it.
          const run = records.runs.find((candidate) => candidate.id === item.runId);
          if (run === undefined || ThreadManagementService.isTerminalRunStatus(run.status)) {
            return yield* new AccessRequestError({ reason: "agent_stopped" });
          }
          const allowed = input.answer.type === "allow" ? input.answer : null;
          // Grants first: the card says allowed only once they are written.
          const added =
            allowed === null ? [] : yield* grant(input.threadId, item.subjects, allowed.scope);
          const accessStatus = allowed === null ? "denied" : "allowed";
          yield* threadManagement
            .dispatch({
              type: "access_request.record",
              commandId: CommandId.make(`access-request:${item.id}:${accessStatus}`),
              threadId: input.threadId,
              runId: item.runId,
              nodeId: item.nodeId,
              turnItemId: item.id,
              accessTitle: item.accessTitle,
              reason: item.reason,
              subjects: item.subjects,
              accessStatus,
              ...(allowed === null ? {} : { accessScope: allowed.scope }),
            })
            .pipe(
              Effect.mapError(
                (cause) => new AccessRequestError({ reason: "record_failed", cause }),
              ),
              // The card still says pending, so the user can answer again.
              Effect.tapError(() =>
                allowed === null ? Effect.void : ungrant(input.threadId, added, allowed.scope),
              ),
            );
          if (allowed === null) return;
          // A card is answered once: if the agent's wait closed it between the
          // checks above and this record, nobody receives the access.
          const recorded = yield* threadManagement
            .getThreadRecords(input.threadId, ["turnItems"], {
              turnItemTypes: ["access_request"],
              messageRoles: [],
            })
            .pipe(
              Effect.mapError(
                (cause) => new AccessRequestError({ reason: "record_failed", cause }),
              ),
            );
          const card = recorded.turnItems.find((candidate) => candidate.id === item.id);
          if (card?.type === "access_request" && card.accessStatus !== "allowed") {
            yield* ungrant(input.threadId, added, allowed.scope);
            return yield* new AccessRequestError({ reason: "agent_stopped" });
          }
        }),
      )
      .pipe(Effect.withSpan("AccessRequests.answer"));

  const listMachineGrants = Effect.sync((): AccessGrantListResult => ({
    grants: grants.machine.toReversed(),
  }));

  const revokeMachineGrant: AccessRequests["Service"]["revokeMachineGrant"] = (key) =>
    writeLock
      .withPermits(1)(
        // Read inside the lock, so a grant written while this waited is kept.
        Effect.suspend(() =>
          save({ ...grants, machine: grants.machine.filter((entry) => entry.key !== key) }),
        ),
      )
      .pipe(Effect.andThen(listMachineGrants));

  return AccessRequests.of({
    answer,
    isAllowed,
    hasAnyGrant,
    listMachineGrants,
    revokeMachineGrant,
  });
});

export const layer = Layer.effect(AccessRequests, make);
