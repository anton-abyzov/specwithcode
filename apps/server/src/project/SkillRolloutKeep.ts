/**
 * SkillRolloutKeep — "Keep updated on these machines" (increment 1399).
 *
 * One record per skill (source repo, skill, scope, machines) in one small
 * file in this machine's state folder. It is never sent to the other
 * machines and never rolls anything out by itself: a later Update offers the
 * same machines again, ticked, behind the same review and Save.
 *
 * @module project/SkillRolloutKeep
 */
import {
  ProjectSkillRolloutKeep,
  ProjectSkillsActionError,
  type ProjectSkillsRolloutKeepInput,
  type ProjectSkillsRolloutKeepResult,
} from "@specweave-studio/contracts";
import * as Clock from "effect/Clock";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Option from "effect/Option";
import * as Path from "effect/Path";
import * as Schema from "effect/Schema";
import * as Semaphore from "effect/Semaphore";

const MAX_STORE_BYTES = 256 * 1024;
const MAX_RECORDS = 500;

const StoreFile = Schema.fromJsonString(
  Schema.Struct({ version: Schema.Literal(1), records: Schema.Array(ProjectSkillRolloutKeep) }),
);
const decodeStore = Schema.decodeUnknownOption(StoreFile);
const encodeStore = Schema.encodeSync(StoreFile);

const sameRecord = (
  record: Pick<ProjectSkillRolloutKeep, "repo" | "skill" | "scope">,
  other: Pick<ProjectSkillRolloutKeep, "repo" | "skill" | "scope">,
) =>
  record.repo.toLowerCase() === other.repo.toLowerCase() &&
  record.skill === other.skill &&
  record.scope === other.scope;

export const makeSkillRolloutKeep = Effect.fn("SkillRolloutKeep.make")(function* (deps: {
  readonly storePath: string;
}) {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const lock = yield* Semaphore.make(1);

  const readStore: Effect.Effect<ReadonlyArray<ProjectSkillRolloutKeep>> = Effect.gen(function* () {
    const info = yield* fs.stat(deps.storePath).pipe(Effect.option);
    if (
      Option.isNone(info) ||
      info.value.type !== "File" ||
      info.value.size > BigInt(MAX_STORE_BYTES)
    )
      return [];
    const text = yield* fs.readFileString(deps.storePath).pipe(Effect.option);
    if (Option.isNone(text)) return [];
    const decoded = decodeStore(text.value);
    return Option.isNone(decoded) ? [] : decoded.value.records;
  });

  const writeStore = (records: ReadonlyArray<ProjectSkillRolloutKeep>) =>
    Effect.gen(function* () {
      const millis = yield* Clock.currentTimeMillis;
      const temporary = `${deps.storePath}.${millis}.tmp`;
      yield* fs.makeDirectory(path.dirname(deps.storePath), { recursive: true });
      yield* fs
        .writeFileString(temporary, `${encodeStore({ version: 1, records: [...records] })}\n`, {
          flag: "wx",
          mode: 0o600,
        })
        .pipe(
          Effect.andThen(fs.rename(temporary, deps.storePath)),
          Effect.onError(() => fs.remove(temporary).pipe(Effect.ignore)),
        );
    });

  const change = (
    input: ProjectSkillsRolloutKeepInput,
  ): Effect.Effect<ProjectSkillsRolloutKeepResult, ProjectSkillsActionError> =>
    lock.withPermits(1)(
      Effect.gen(function* () {
        const records = yield* readStore;
        if (input.operation === "read") return { records };
        const others = records.filter((record) => !sameRecord(record, input));
        const next =
          input.operation === "clear"
            ? others
            : [
                ...others,
                {
                  repo: input.repo,
                  skill: input.skill,
                  scope: input.scope,
                  machineIds: [...new Set(input.machineIds)],
                  updatedAt: DateTime.formatIso(
                    DateTime.makeUnsafe(yield* Clock.currentTimeMillis),
                  ),
                },
              ].slice(-MAX_RECORDS);
        yield* writeStore(next).pipe(
          Effect.mapError(
            (cause) =>
              new ProjectSkillsActionError({
                projectId: input.projectId,
                reason: "read_failed",
                detail: "The keep-updated setting could not be saved on this machine.",
                cause,
              }),
          ),
        );
        return { records: next };
      }),
    );

  return { change, records: readStore };
});

export type SkillRolloutKeep = Effect.Success<ReturnType<typeof makeSkillRolloutKeep>>;

// ---------------------------------------------------------------------------
// Where each copy was last confirmed, for the catalog note
// ---------------------------------------------------------------------------

const SeenEntry = Schema.Struct({
  repo: Schema.String,
  skill: Schema.String,
  machine: Schema.String,
  contentHash: Schema.String,
  at: Schema.String,
});
type SeenEntry = typeof SeenEntry.Type;
const SeenFile = Schema.fromJsonString(
  Schema.Struct({ version: Schema.Literal(1), entries: Schema.Array(SeenEntry) }),
);
const decodeSeen = Schema.decodeUnknownOption(SeenFile);
const encodeSeen = Schema.encodeSync(SeenFile);

/**
 * The machines a rollout from here confirmed, with the copy each got. A machine's
 * newer confirmation replaces its older one; an Undo removes it.
 */
export const makeSkillRolloutSeen = Effect.fn("SkillRolloutSeen.make")(function* (deps: {
  readonly storePath: string;
}) {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const lock = yield* Semaphore.make(1);

  const read: Effect.Effect<ReadonlyArray<SeenEntry>> = Effect.gen(function* () {
    const info = yield* fs.stat(deps.storePath).pipe(Effect.option);
    if (
      Option.isNone(info) ||
      info.value.type !== "File" ||
      info.value.size > BigInt(MAX_STORE_BYTES)
    )
      return [];
    const text = yield* fs.readFileString(deps.storePath).pipe(Effect.option);
    const decoded = Option.isNone(text) ? Option.none() : decodeSeen(text.value);
    return Option.isNone(decoded) ? [] : decoded.value.entries;
  });

  const record = (
    changes: ReadonlyArray<{
      readonly repo: string;
      readonly skill: string;
      readonly machine: string;
      /** Null when the copy was removed there. */
      readonly contentHash: string | null;
    }>,
  ) =>
    lock.withPermits(1)(
      Effect.gen(function* () {
        if (changes.length === 0) return;
        const at = DateTime.formatIso(DateTime.makeUnsafe(yield* Clock.currentTimeMillis));
        const key = (entry: { repo: string; skill: string; machine: string }) =>
          `${entry.repo.toLowerCase()}\u0000${entry.skill}\u0000${entry.machine}`;
        const touched = new Set(changes.map(key));
        const next = [
          ...(yield* read).filter((entry) => !touched.has(key(entry))),
          ...changes.flatMap((change) =>
            change.contentHash === null
              ? []
              : [
                  {
                    repo: change.repo,
                    skill: change.skill,
                    machine: change.machine,
                    contentHash: change.contentHash,
                    at,
                  },
                ],
          ),
        ].slice(-2000);
        const temporary = `${deps.storePath}.${yield* Clock.currentTimeMillis}.tmp`;
        yield* fs.makeDirectory(path.dirname(deps.storePath), { recursive: true });
        yield* fs
          .writeFileString(temporary, `${encodeSeen({ version: 1, entries: next })}\n`, {
            flag: "wx",
            mode: 0o600,
          })
          .pipe(
            Effect.andThen(fs.rename(temporary, deps.storePath)),
            Effect.onError(() => fs.remove(temporary).pipe(Effect.ignore)),
          );
      }).pipe(Effect.ignore),
    );

  return { read, record };
});
