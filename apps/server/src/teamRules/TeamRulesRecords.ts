// @effect-diagnostics nodeBuiltinImport:off globalDateInEffect:off preferSchemaOverJson:off - streams a read-only database to a file from a CLI, and reads the OS user name.
import * as NodeFS from "node:fs";
import * as NodeOS from "node:os";

import type { AuthPrincipal, ServerSettings } from "@specweave-studio/contracts";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as SqlClient from "effect/sql/SqlClient";

import { openLiveDatabaseReadOnly } from "../persistence/liveDatabaseSnapshot.ts";
import { currentTeamRules } from "./TeamRules.ts";

/** Who is acting, as this machine's session knows them. Reported by the client, so not proof. */
export interface TeamRulesActorValue {
  readonly person: string;
  readonly device: {
    readonly sessionId: string;
    readonly type?: string | undefined;
    readonly label?: string | undefined;
  };
}

/** Set by the request that changes settings. Undefined for an agent tool or the server itself. */
export class TeamRulesActor extends Context.Reference<TeamRulesActorValue | undefined>(
  "studio/teamRules/TeamRulesActor",
  { defaultValue: () => undefined },
) {}

const osUser = () => {
  try {
    return NodeOS.userInfo().username;
  } catch {
    return null;
  }
};

export const teamRulesActorOfSession = (session: {
  readonly sessionId: string;
  readonly subject: string;
  readonly principal?: AuthPrincipal | undefined;
  readonly clientDeviceType?: string | undefined;
  readonly clientLabel?: string | undefined;
}): TeamRulesActorValue => ({
  person:
    session.principal === undefined
      ? session.subject
      : session.principal.kind === "device"
        ? `device:${session.principal.id}`
        : `coordinator:${session.principal.environmentId}`,
  device: {
    sessionId: session.sessionId,
    ...(session.clientDeviceType === undefined ? {} : { type: session.clientDeviceType }),
    ...(session.clientLabel === undefined ? {} : { label: session.clientLabel }),
  },
});

/** Remembers who sent a command, so its events can name them. No rules, no write. */
export const recordTeamRulesCommandActor = (actor: TeamRulesActorValue, commandId: string) =>
  Effect.gen(function* () {
    if ((yield* currentTeamRules).status === "none") return;
    const sql = yield* SqlClient.SqlClient;
    yield* sql`
      INSERT OR IGNORE INTO team_rules_command_actors (command_id, person, os_user, device_json)
      VALUES (${commandId}, ${actor.person}, ${osUser()}, ${JSON.stringify(actor.device)})
    `;
  }).pipe(Effect.ignore({ log: true }));

const isPlainObject = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

const MAX_PATH_DEPTH = 4;

/**
 * The setting paths a write changed. Paths only: a value here could be an API
 * key or a person's instructions, and a record must never hold it.
 */
export function changedSettingPaths(
  before: ServerSettings,
  after: ServerSettings,
): ReadonlyArray<string> {
  const paths: Array<string> = [];
  const walk = (left: unknown, right: unknown, path: ReadonlyArray<string>) => {
    if (JSON.stringify(left) === JSON.stringify(right)) return;
    if (isPlainObject(left) && isPlainObject(right) && path.length < MAX_PATH_DEPTH) {
      for (const key of new Set([...Object.keys(left), ...Object.keys(right)])) {
        walk(left[key], right[key], [...path, key]);
      }
      return;
    }
    paths.push(path.join("."));
  };
  walk(before, after, []);
  return paths;
}

/** Records a settings write. No rules, no write; a failure never blocks the setting. */
export const recordTeamRulesSettingsChange = (paths: ReadonlyArray<string>) =>
  Effect.gen(function* () {
    if (paths.length === 0) return;
    if ((yield* currentTeamRules).status === "none") return;
    const actor = yield* TeamRulesActor;
    const sql = yield* SqlClient.SqlClient;
    yield* sql`
      INSERT INTO team_rules_settings_changes
        (occurred_at, paths_json, person, os_user, device_json)
      VALUES (
        ${new Date().toISOString()},
        ${JSON.stringify(paths)},
        ${actor?.person ?? null},
        ${osUser()},
        ${actor === undefined ? null : JSON.stringify(actor.device)}
      )
    `;
  }).pipe(Effect.ignore({ log: true }));

export interface TeamRulesRecordsQuery {
  readonly dbPath: string;
  /** ISO timestamps; either end may be open. */
  readonly since?: string | undefined;
  readonly until?: string | undefined;
}

interface EventRow {
  readonly occurred_at: string;
  readonly event_type: string;
  readonly thread_id: string;
  readonly run_id: string | null;
  readonly command_id: string | null;
  readonly provider: string | null;
  readonly person: string | null;
  readonly os_user: string | null;
  readonly device_json: string | null;
}

interface SettingsRow {
  readonly occurred_at: string;
  readonly paths_json: string;
  readonly person: string | null;
  readonly os_user: string | null;
  readonly device_json: string | null;
}

const parsedDevice = (text: string | null): unknown => (text === null ? null : JSON.parse(text));

function* mergedByTime<
  Left extends { readonly occurred_at: string },
  Right extends { readonly occurred_at: string },
>(
  left: Iterator<Left>,
  right: Iterator<Right>,
  ofLeft: (row: Left) => string,
  ofRight: (row: Right) => string,
): Generator<string> {
  let nextLeft = left.next();
  let nextRight = right.next();
  while (!nextLeft.done || !nextRight.done) {
    if (
      nextRight.done ||
      (!nextLeft.done && nextLeft.value.occurred_at <= nextRight.value.occurred_at)
    ) {
      yield ofLeft(nextLeft.value as Left);
      nextLeft = left.next();
    } else {
      yield ofRight(nextRight.value);
      nextRight = right.next();
    }
  }
}

/**
 * Each record as one line of JSON, oldest first. Type, ids and time, and never
 * a payload: events hold message text and tool output. Sequence order avoids a
 * sort over the whole table, so a large export does not load it into memory.
 */
export function* teamRulesRecordLines(query: TeamRulesRecordsQuery): Generator<string> {
  const database = openLiveDatabaseReadOnly(query.dbPath);
  try {
    const tables = new Set(
      (
        database
          .prepare(`SELECT name FROM sqlite_master WHERE type = 'table'`)
          .all() as unknown as ReadonlyArray<{ readonly name: string }>
      ).map(({ name }) => name),
    );
    const since = query.since ?? "";
    const until = query.until ?? "\uffff";
    const machine = NodeOS.hostname();
    const hasActors = tables.has("team_rules_command_actors");
    const events = tables.has("orchestration_v2_events")
      ? (database
          .prepare(
            hasActors
              ? `SELECT e.occurred_at, e.event_type, e.thread_id, e.run_id, e.command_id, e.provider,
                   a.person, a.os_user, a.device_json
                 FROM orchestration_v2_events e
                 LEFT JOIN team_rules_command_actors a ON a.command_id = e.command_id
                 WHERE e.occurred_at >= ? AND e.occurred_at <= ?
                 ORDER BY e.sequence`
              : `SELECT occurred_at, event_type, thread_id, run_id, command_id, provider,
                   NULL AS person, NULL AS os_user, NULL AS device_json
                 FROM orchestration_v2_events
                 WHERE occurred_at >= ? AND occurred_at <= ?
                 ORDER BY sequence`,
          )
          .iterate(since, until) as unknown as Iterator<EventRow>)
      : [][Symbol.iterator]();
    const settings = tables.has("team_rules_settings_changes")
      ? (database
          .prepare(
            `SELECT occurred_at, paths_json, person, os_user, device_json
             FROM team_rules_settings_changes
             WHERE occurred_at >= ? AND occurred_at <= ?
             ORDER BY sequence`,
          )
          .iterate(since, until) as unknown as Iterator<SettingsRow>)
      : [][Symbol.iterator]();
    yield* mergedByTime<EventRow, SettingsRow>(
      events,
      settings,
      (row) =>
        JSON.stringify({
          at: row.occurred_at,
          kind: "event",
          type: row.event_type,
          threadId: row.thread_id,
          runId: row.run_id,
          commandId: row.command_id,
          provider: row.provider,
          person: row.person,
          osUser: row.os_user,
          device: parsedDevice(row.device_json),
          machine,
        }),
      (row) =>
        JSON.stringify({
          at: row.occurred_at,
          kind: "settings-change",
          paths: JSON.parse(row.paths_json),
          person: row.person,
          osUser: row.os_user,
          device: parsedDevice(row.device_json),
          machine,
        }),
    );
  } finally {
    database.close();
  }
}

/** Writes records to a new private file, refusing to overwrite one. Returns how many. */
export function writeTeamRulesRecordsFile(query: TeamRulesRecordsQuery, output: string): number {
  // The database opens first, so a failure leaves no empty file to block a retry.
  const lines = teamRulesRecordLines(query);
  try {
    let next = lines.next();
    const file = NodeFS.openSync(output, "wx", 0o600);
    let count = 0;
    try {
      for (; next.done !== true; next = lines.next()) {
        NodeFS.writeSync(file, `${next.value}\n`);
        count += 1;
      }
    } finally {
      NodeFS.closeSync(file);
    }
    return count;
  } finally {
    lines.return(undefined);
  }
}
