/**
 * PersonalDataAccess - which other machines' work may read the owner's mail,
 * calendar and files on this machine.
 *
 * A machine link, a work grant and a project's own Google switch never imply
 * this: the owner allows one machine one source in Settings. A refused read is
 * kept as a request for the owner, and every grant, revoke, refusal and use is
 * logged. Grants, requests and the log live in
 * `<stateDir>/personal-data-access.json`.
 *
 * @module PersonalDataAccess
 */
import {
  type EnvironmentId,
  PERSONAL_DATA_SOURCES,
  PersonalDataAccessError,
  type PersonalDataAccessStatus,
  PersonalDataLogEntry,
  type PersonalDataSetAccessInput,
  PersonalDataSource,
} from "@specweave-studio/contracts";
import { HostProcessPlatform } from "@specweave-studio/shared/hostProcess";
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

export const PERSONAL_DATA_ACCESS_FILE = "personal-data-access.json";
/** The log keeps the newest entries; older ones are dropped. */
export const PERSONAL_DATA_LOG_LIMIT = 200;
/** A repeat of the same read or refusal within this window is one log line. */
export const PERSONAL_DATA_LOG_REPEAT_MS = 10 * 60 * 1000;

const SourcesByMachine = Schema.Record(Schema.String, Schema.Array(PersonalDataSource));
const AccessFile = Schema.fromJsonString(
  Schema.Struct({
    version: Schema.Literal(1),
    grants: SourcesByMachine,
    requests: SourcesByMachine,
    /** Oldest first. */
    log: Schema.Array(PersonalDataLogEntry),
  }),
);
type AccessFile = typeof AccessFile.Type;
const decodeFile = Schema.decodeUnknownOption(AccessFile);
const encodeFile = Schema.encodeSync(AccessFile);
const EMPTY: AccessFile = { version: 1, grants: {}, requests: {}, log: [] };

export interface PersonalDataMachine {
  readonly environmentId: EnvironmentId;
  readonly label: string;
}

export interface PersonalDataAccessShape {
  /**
   * Whether this machine's work may read the source now. A refusal is kept as
   * a request for the owner; both answers are logged.
   */
  readonly check: (
    input: PersonalDataMachine & {
      readonly source: PersonalDataSource;
      readonly tool: string;
    },
  ) => Effect.Effect<boolean>;
  /** Records a read by a machine that needs no grant (the owner's own). */
  readonly noteUse: (
    input: PersonalDataMachine & {
      readonly source: PersonalDataSource;
      readonly tool: string;
    },
  ) => Effect.Effect<void>;
  /** The owner's change; only an owner's connection may reach this. */
  readonly set: (
    input: PersonalDataSetAccessInput,
    label: string,
  ) => Effect.Effect<void, PersonalDataAccessError>;
  /** What is allowed and asked for, for the machines given and any other that holds a grant or request. */
  readonly status: (
    machines: ReadonlyArray<PersonalDataMachine & { readonly ownMachine?: boolean }>,
  ) => Effect.Effect<PersonalDataAccessStatus>;
}

/** Without the layer nothing is allowed: personal data stays closed rather than open. */
const closed: PersonalDataAccessShape = {
  check: () => Effect.succeed(false),
  noteUse: () => Effect.void,
  set: () => Effect.fail(new PersonalDataAccessError({ reason: "save_failed" })),
  status: () => Effect.succeed({ machines: [], log: [] }),
};

export class PersonalDataAccess extends Context.Reference<PersonalDataAccessShape>(
  "studio/personalData/PersonalDataAccess",
  { defaultValue: () => closed },
) {}

const without = <A>(list: ReadonlyArray<A>, value: A) => list.filter((entry) => entry !== value);
const withValue = <A>(list: ReadonlyArray<A>, value: A) =>
  list.includes(value) ? list : [...list, value];

/** The map with one machine's list replaced; a machine left with nothing is dropped. */
const setList = (
  map: Readonly<Record<string, ReadonlyArray<PersonalDataSource>>>,
  environmentId: string,
  list: ReadonlyArray<PersonalDataSource>,
) => {
  const { [environmentId]: _dropped, ...rest } = map;
  return list.length === 0 ? rest : { ...rest, [environmentId]: list };
};

const make = Effect.gen(function* () {
  const config = yield* ServerConfig.ServerConfig;
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const platform = yield* HostProcessPlatform;
  const filePath = path.join(config.stateDir, PERSONAL_DATA_ACCESS_FILE);

  const loaded = decodeFile(
    yield* fs.readFileString(filePath).pipe(Effect.orElseSucceed(() => "")),
  );
  let state: AccessFile = loaded._tag === "Some" ? loaded.value : EMPTY;
  const lock = yield* Semaphore.make(1);

  const save = (next: AccessFile) =>
    writeFileStringAtomically({ filePath, contents: encodeFile(next) }).pipe(
      Effect.provideService(FileSystem.FileSystem, fs),
      Effect.provideService(Path.Path, path),
      Effect.provideService(HostProcessPlatform, platform),
      Effect.mapError((cause) => new PersonalDataAccessError({ reason: "save_failed", cause })),
      Effect.tap(() =>
        Effect.sync(() => {
          state = next;
        }),
      ),
    );

  const appended = (
    file: AccessFile,
    entry: Omit<PersonalDataLogEntry, "at">,
    now: DateTime.Utc,
  ): AccessFile => {
    const nowMs = DateTime.toEpochMillis(now);
    const repeat = file.log.findLast(
      (logged) =>
        logged.environmentId === entry.environmentId &&
        logged.source === entry.source &&
        logged.action === entry.action &&
        logged.tool === entry.tool,
    );
    if (
      repeat !== undefined &&
      (entry.action === "used" || entry.action === "refused") &&
      nowMs - Date.parse(repeat.at) < PERSONAL_DATA_LOG_REPEAT_MS
    )
      return file;
    return {
      ...file,
      log: [...file.log, { ...entry, at: DateTime.formatIso(now) }].slice(-PERSONAL_DATA_LOG_LIMIT),
    };
  };

  /** A read that cannot be logged is still answered: the grant decides, not the disk. */
  const record = (change: (file: AccessFile, now: DateTime.Utc) => AccessFile) =>
    lock.withPermits(1)(
      Effect.gen(function* () {
        const next = change(state, yield* DateTime.now);
        if (next !== state) yield* save(next);
      }),
    );
  const recordQuietly = (change: (file: AccessFile, now: DateTime.Utc) => AccessFile) =>
    record(change).pipe(
      Effect.catch((error) =>
        Effect.logWarning("Could not write the personal data log", { reason: error.reason }),
      ),
    );

  const logLine = (
    input: PersonalDataMachine & { readonly source: PersonalDataSource; readonly tool: string },
    action: "used" | "refused",
  ) => ({
    environmentId: input.environmentId,
    label: input.label || "another machine",
    source: input.source,
    action,
    tool: input.tool,
  });

  const check: PersonalDataAccessShape["check"] = (input) =>
    Effect.gen(function* () {
      const allowed = (state.grants[input.environmentId] ?? []).includes(input.source);
      yield* recordQuietly((file, now) => {
        const logged = appended(file, logLine(input, allowed ? "used" : "refused"), now);
        if (allowed) return logged;
        const asked = file.requests[input.environmentId] ?? [];
        return asked.includes(input.source)
          ? logged
          : {
              ...logged,
              requests: setList(logged.requests, input.environmentId, [...asked, input.source]),
            };
      });
      return allowed;
    });

  const noteUse: PersonalDataAccessShape["noteUse"] = (input) =>
    recordQuietly((file, now) => appended(file, logLine(input, "used"), now));

  const set: PersonalDataAccessShape["set"] = (input, label) =>
    record((file, now) => {
      const granted = file.grants[input.environmentId] ?? [];
      const asked = file.requests[input.environmentId] ?? [];
      const has = granted.includes(input.source);
      if (input.change === "allow" && has && !asked.includes(input.source)) return file;
      if (input.change === "revoke" && !has) return file;
      if (input.change === "dismiss" && !asked.includes(input.source)) return file;
      const next: AccessFile = {
        ...file,
        grants:
          input.change === "dismiss"
            ? file.grants
            : setList(
                file.grants,
                input.environmentId,
                input.change === "allow"
                  ? withValue(granted, input.source)
                  : without(granted, input.source),
              ),
        requests: setList(file.requests, input.environmentId, without(asked, input.source)),
      };
      if (input.change === "allow" && has) return next;
      return appended(
        next,
        {
          environmentId: input.environmentId,
          label: label || "another machine",
          source: input.source,
          action:
            input.change === "allow"
              ? "granted"
              : input.change === "revoke"
                ? "revoked"
                : "dismissed",
        },
        now,
      );
    });

  const status: PersonalDataAccessShape["status"] = (machines) =>
    Effect.sync(() => {
      const labels = new Map<string, string>(
        machines.map((machine) => [machine.environmentId, machine.label]),
      );
      const own = new Set<string>(
        machines.filter((machine) => machine.ownMachine === true).map((m) => m.environmentId),
      );
      // A machine no longer allowed to run work here still shows what it holds, so it can be taken back.
      for (const id of [...Object.keys(state.grants), ...Object.keys(state.requests)]) {
        if (!labels.has(id))
          labels.set(
            id,
            state.log.findLast((entry) => entry.environmentId === id)?.label ?? "Another machine",
          );
      }
      const inOrder = (list: ReadonlyArray<PersonalDataSource> | undefined) =>
        PERSONAL_DATA_SOURCES.filter((source) => (list ?? []).includes(source));
      return {
        machines: [...labels].map(([environmentId, label]) => ({
          environmentId: environmentId as EnvironmentId,
          label: label || "Another machine",
          ownMachine: own.has(environmentId),
          sources: inOrder(state.grants[environmentId]),
          requested: inOrder(state.requests[environmentId]),
        })),
        log: state.log.toReversed(),
      };
    });

  return { check, noteUse, set, status } satisfies PersonalDataAccessShape;
});

export const layer = Layer.effect(PersonalDataAccess, make);
