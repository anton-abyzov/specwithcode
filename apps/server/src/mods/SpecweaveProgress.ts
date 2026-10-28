/**
 * SpecweaveProgress - the read-only SpecWeave summary behind the
 * `specweave:read` mod permission.
 *
 * For each project on this host it reads `<root>/.specweave/increments/*`:
 * `metadata.json` for status, `spec.md` for acceptance criteria and tasks,
 * `ledger.jsonl` for task state and `reports/verify.json` for the last verify
 * run. It never runs the SpecWeave CLI and never writes. The summary leaves
 * out paths, spec prose, ledger owners (they carry host names), evidence and
 * the commands a task or verify ran.
 *
 * Unlike the Project Plan reader, which fails closed on its one configured
 * increment, this reader is tolerant: an increment it cannot parse is listed
 * as unreadable instead of failing the whole summary.
 *
 * @module SpecweaveProgress
 */
import type {
  ModSpecweaveIncrement,
  ModSpecweaveResult,
  ModSpecweaveTask,
  ThreadIncrementAcWaiver,
} from "@specweave-studio/contracts";
import { compareIncrementFoldersNewestFirst } from "@specweave-studio/shared/specweaveIncrement";
import * as Clock from "effect/Clock";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";

export const MAX_PROJECTS = 20;
export const MAX_INCREMENTS = 60;
export const MAX_INCREMENTS_PER_PROJECT = 25;
/**
 * Folders whose metadata is read per project. Only metadata is read for
 * each, so an open increment is never dropped for being old; this bounds a
 * runaway folder only.
 */
const MAX_DIRECTORIES_SCANNED = 5_000;
const METADATA_CONCURRENCY = 16;
const MAX_CRITERIA = 64;
const MAX_TASKS = 200;
const MAX_TASK_CRITERIA = 16;
const SPEC_BYTES = 262_144;
const LEDGER_BYTES = 1_048_576;
const SMALL_BYTES = 65_536;
/** SpecWeave appends sync events to metadata.json; past this an increment reads as unknown. */
const METADATA_BYTES = 524_288;
const LEASE_MS = 2 * 3_600_000;
/** Closed increments stay listed this long, so a standup can say what finished. */
export const RECENTLY_CLOSED_MS = 7 * 24 * 3_600_000;
const CLOSED_STATUSES = new Set(["completed", "abandoned", "archived", "cancelled", "closed"]);
const INCREMENT_DIRECTORY = /^\d{4,}[A-Za-z]?-[a-z0-9]+(?:-[a-z0-9]+)*$/u;
/** The contract carries increment ids up to this length; longer folders are skipped. */
const MAX_INCREMENT_ID = 160;
const MAX_LEDGER_LINES = 10_000;
const META_EVENTS = new Set(["note", "session", "handoff", "pickup"]);
/** SpecWeave caps `--line` at 100 characters. */
const CARD_LINE_CHARS = 100;
const CARD_LINK_CHARS = 2_048;
const EVIDENCE_CHARS = 8_192;

export interface SpecweaveAcceptedSkip extends ThreadIncrementAcWaiver {
  readonly ac: string;
}

/** Same complete-record rule as SpecWeave #2175; never changes task state. */
function acceptedSkip(raw: Record<string, unknown>): SpecweaveAcceptedSkip | null {
  if (typeof raw.t !== "string" || !/^AC-/i.test(raw.t)) return null;
  const fields = ["check", "reason", "acceptedBy", "acceptedAt", "authorization"] as const;
  for (const field of fields)
    if (typeof raw[field] !== "string" || !(raw[field] as string).trim()) return null;
  if (
    typeof raw.by !== "string" ||
    !raw.by.trim() ||
    isoOrNull(raw.at) === null ||
    !Number.isFinite(Date.parse(raw.acceptedAt as string))
  )
    return null;
  return {
    ac: raw.t.toUpperCase(),
    check: (raw.check as string).trim(),
    reason: (raw.reason as string).trim(),
    acceptedBy: (raw.acceptedBy as string).trim(),
    acceptedAt: (raw.acceptedAt as string).trim(),
    authorization: (raw.authorization as string).trim(),
    by: raw.by,
    at: raw.at as string,
  };
}

/** A task as its card shows it: SpecWeave's `card.state`, line and raw link. */
export type SpecweaveCardState = "todo" | "doing" | "waiting" | "done" | "skipped";

export interface SpecweaveCard {
  readonly id: string;
  readonly state: SpecweaveCardState;
  /** The latest `line` an accepted event carried, else the task title. */
  readonly line: string;
  /** The latest `link` an accepted event carried, else one derived from the done evidence; unsanitised. */
  readonly link: string | null;
}

/** A card line as SpecWeave stores it: whitespace collapsed, over 100 chars cut to 99 plus "…". */
function cardLine(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const text = value.replace(/\s+/gu, " ").trim();
  if (text.length === 0) return null;
  return text.length > CARD_LINE_CHARS ? `${text.slice(0, CARD_LINE_CHARS - 1).trimEnd()}…` : text;
}

/** The card state of a folded task status. */
export function cardState(status: ModSpecweaveTask["status"]): SpecweaveCardState {
  switch (status) {
    case "claimed":
    case "stale":
      return "doing";
    case "blocked":
      return "waiting";
    case "done":
      return "done";
    case "skipped":
      return "skipped";
    default:
      return "todo";
  }
}

const TASK_ID = /^[A-Za-z]{1,8}-[A-Za-z0-9_-]{1,32}$/u;
const PULL_REQUEST_URL = /https:\/\/github\.com\/[\w.-]+\/[\w.-]+\/pull\/\d+/u;
const LOG_PATH = /(?:^|\s)log:\s*(\S+)/u;
const HEAD_SHA = /\bHEAD\s+([0-9a-f]{7,40})\b/iu;
const GITHUB_ORIGIN =
  /^(?:https:\/\/github\.com\/|git@github\.com:|ssh:\/\/git@github\.com\/)([\w.-]+)\/([\w.-]+?)(?:\.git)?\/?$/u;

/** `https://github.com/o/r` for a GitHub remote URL (https or ssh form); null otherwise. */
export function githubRepositoryUrl(origin: string | null | undefined): string | null {
  const match = origin ? GITHUB_ORIGIN.exec(origin.trim()) : null;
  return match ? `https://github.com/${match[1]}/${match[2]}` : null;
}

/**
 * The link a done event's evidence implies, in SpecWeave's order: a GitHub
 * pull request URL, then a `log: <path>` token (relative to the increment
 * folder, its `.specweave/increments/<id>/` prefix stripped), then
 * `HEAD <sha>` (the commit URL with a GitHub origin, else the bare sha).
 * Null when the evidence names none of them.
 */
export function deriveCardLink(
  evidence: string | null,
  options: { readonly origin?: string | null; readonly incrementId?: string | null } = {},
): string | null {
  if (evidence === null) return null;
  const pullRequest = PULL_REQUEST_URL.exec(evidence)?.[0];
  if (pullRequest !== undefined) return pullRequest;
  const log = LOG_PATH.exec(evidence)?.[1];
  if (log !== undefined) {
    const prefix = /^(?:\.\/)?\.specweave\/increments\/([^/]+)\//u.exec(log);
    return prefix !== null && (!options.incrementId || prefix[1] === options.incrementId)
      ? log.slice(prefix[0].length)
      : log;
  }
  const sha = HEAD_SHA.exec(evidence)?.[1]?.toLowerCase();
  if (sha === undefined) return null;
  const repository = githubRepositoryUrl(options.origin);
  return repository === null ? sha : `${repository}/commit/${sha}`;
}

const bounded = (value: unknown, maximum: number): string | null => {
  if (typeof value !== "string") return null;
  const text = value.replace(/\s+/gu, " ").trim();
  if (text.length === 0) return null;
  return text.length > maximum ? `${text.slice(0, maximum - 1)}…` : text;
};

const isoOrNull = (value: unknown): string | null =>
  typeof value === "string" &&
  /^\d{4}-\d\d-\d\dT/u.test(value) &&
  Number.isFinite(Date.parse(value))
    ? value
    : null;

interface ParsedSpec {
  readonly title: string | null;
  readonly criteria: ReadonlyArray<{
    readonly id: string;
    readonly text: string;
    /** Ticked in the spec (`- [x] AC-..`): a declaration, never proof. Absent when unticked. */
    readonly checked?: true;
    /** The user story it belongs to (`US-001`), from its id or the story heading above it. */
    readonly story?: string;
  }>;
  readonly tasks: ReadonlyArray<{
    readonly id: string;
    readonly title: string;
    readonly criteria: ReadonlyArray<string>;
    /** Older increments kept status in tasks.md as `**Status**: [x] completed`. */
    readonly checked: boolean;
  }>;
}

/**
 * Reads acceptance criteria (`- [ ] AC-NN: text`, also the older
 * `- [ ] **AC-US1-01**: text` and `- AC-US1-01 — text` forms) and tasks (`### T-NN Title`, also
 * `### T-001: Title`) with the AC ids each task cites. Fenced blocks are
 * skipped. The spec's checkboxes are not authoritative: an AC's tick is kept
 * only as `checked`, a declaration readers must not show as verified. An AC
 * belongs to the user story its id names (`AC-US2-01`) or, failing that, the
 * `US-NNN` heading above it.
 */
export function parseSpecweaveSpec(spec: string): ParsedSpec {
  let title: string | null = null;
  const criteria = new Map<string, { text: string; checked: boolean; story: string | null }>();
  let story: string | null = null;
  const tasks: Array<{ id: string; title: string; criteria: string[]; checked: boolean }> = [];
  let current: { id: string; title: string; criteria: string[]; checked: boolean } | null = null;
  let fenced = false;
  for (const line of spec.split(/\r?\n/u)) {
    if (/^\s*(```|~~~)/u.test(line)) {
      fenced = !fenced;
      continue;
    }
    if (fenced) continue;
    const heading = /^# (.+)$/u.exec(line);
    if (heading && title === null) {
      title = bounded(heading[1], 120);
      continue;
    }
    const task = /^### (T-[A-Za-z0-9_-]{1,32}):?\s+(.+?)\s*$/u.exec(line);
    if (task) {
      current = null;
      if (tasks.length >= MAX_TASKS || tasks.some((entry) => entry.id === task[1])) continue;
      current = {
        id: task[1]!,
        title: bounded(task[2], 200) ?? task[1]!,
        criteria: [],
        checked: false,
      };
      tasks.push(current);
      continue;
    }
    const storyHeading = /^#{2,4}\s+\**(US-\d{1,4})\b/u.exec(line);
    if (storyHeading) {
      current = null;
      story = storyHeading[1]!;
      continue;
    }
    if (/^#{1,3} /u.test(line)) {
      current = null;
      if (/^## /u.test(line)) story = null;
      continue;
    }
    // A task's own `- AC-..` bullet cites criteria; it does not define them.
    const criterion =
      current === null
        ? /^\s*- (?:\[([ xX])\]\s*)?\**(AC-[A-Za-z0-9_-]{1,40})\**\s*(?::|—|–|-)?\**\s*(.*)$/u.exec(
            line,
          )
        : null;
    if (criterion) {
      const id = criterion[2]!;
      if (criteria.size < MAX_CRITERIA && !criteria.has(id)) {
        const named = /^AC-US(\d{1,4})-/u.exec(id);
        criteria.set(id, {
          text: bounded(criterion[3], 300) ?? id,
          checked: criterion[1] !== undefined && criterion[1].toLowerCase() === "x",
          story: named ? `US-${named[1]!.padStart(3, "0")}` : story,
        });
      }
      continue;
    }
    if (current && /\*\*Status\*\*:\s*\[x\]/iu.test(line)) current.checked = true;
    if (current && /\bAC\b|\*\*AC\*\*|Satisfies ACs?/iu.test(line)) {
      for (const id of line.match(/AC-[A-Za-z0-9_-]{1,40}/gu) ?? []) {
        if (current.criteria.length < MAX_TASK_CRITERIA && !current.criteria.includes(id)) {
          current.criteria.push(id);
        }
      }
    }
  }
  return {
    title,
    criteria: [...criteria.entries()].map(([id, entry]) => ({
      id,
      text: entry.text,
      ...(entry.checked ? { checked: true as const } : {}),
      ...(entry.story === null ? {} : { story: entry.story }),
    })),
    tasks,
  };
}

/**
 * Folds `ledger.jsonl` onto the spec's tasks with the same rules as the
 * SpecWeave 3.0.6 ledger (`foldLedger`): a claim held by someone else for less
 * than two hours is not taken over, done needs evidence and skip needs a
 * reason, skipped is terminal and done takes no claim, block or skip, only the
 * owner releases, and a claim older than two hours shows as stale. Lines it
 * cannot read, and lines past the 10,000th, are skipped and counted. `cards`
 * is SpecWeave's card fold over the same events (see {@link SpecweaveCard}).
 */
export function foldSpecweaveLedger(
  tasks: ParsedSpec["tasks"],
  ledger: string,
  now: number,
  options: {
    /** The repository's GitHub origin, which turns `HEAD <sha>` into a commit URL. */
    readonly origin?: string | null;
    /** The increment folder name, stripped from `log:` paths. */
    readonly incrementId?: string | null;
  } = {},
): {
  readonly tasks: ModSpecweaveTask[];
  readonly cards: SpecweaveCard[];
  readonly malformed: number;
  readonly acceptedSkips: readonly SpecweaveAcceptedSkip[];
} {
  type State = {
    status: ModSpecweaveTask["status"];
    owner: string | null;
    since: number;
    changedAt: string | null;
    note: string | null;
    line: string | null;
    link: string | null;
    evidence: string | null;
  };
  const fresh = (checked: boolean): State => ({
    status: checked ? "done" : "planned",
    owner: null,
    since: 0,
    changedAt: null,
    note: null,
    line: null,
    link: null,
    evidence: null,
  });
  const states = new Map<string, State>(tasks.map((task) => [task.id, fresh(task.checked)]));
  /** Ids only the ledger names (SpecWeave's branch cards, `C-NN`), in first-appearance order. */
  const ledgerOnly = new Map<string, State>();
  const stateFor = (id: string) => {
    let state = states.get(id) ?? ledgerOnly.get(id);
    if (state === undefined && id !== "*" && TASK_ID.test(id)) {
      state = fresh(false);
      ledgerOnly.set(id, state);
    }
    return state;
  };
  let malformed = 0;
  const entries: Array<{
    t: string;
    e: string;
    by: string;
    at: number;
    iso: string;
    note: string | null;
    hasEvidence: boolean;
    evidence: string | null;
    line: string | null;
    link: string | null;
    index: number;
    waiver: SpecweaveAcceptedSkip | null;
  }> = [];
  ledger
    .replace(/^\uFEFF/u, "")
    .split("\n")
    .forEach((line, index) => {
      if (!line.trim()) return;
      if (index >= MAX_LEDGER_LINES) {
        malformed++;
        return;
      }
      try {
        const raw: unknown = JSON.parse(line);
        if (typeof raw !== "object" || raw === null) throw new Error("not an object");
        const entry = raw as Record<string, unknown>;
        const iso = isoOrNull(entry.at);
        if (
          typeof entry.t !== "string" ||
          typeof entry.e !== "string" ||
          typeof entry.by !== "string" ||
          iso === null
        ) {
          throw new Error("missing fields");
        }
        entries.push({
          t: entry.t,
          e: entry.e,
          by: entry.by,
          at: Date.parse(iso),
          iso,
          note: bounded(entry.note, 200),
          hasEvidence: typeof entry.evidence === "string" && entry.evidence.trim() !== "",
          // Evidence itself never leaves this function; only the link it implies does.
          evidence:
            typeof entry.evidence === "string" ? entry.evidence.slice(0, EVIDENCE_CHARS) : null,
          line: cardLine(entry.line),
          link: bounded(entry.link, CARD_LINK_CHARS),
          index,
          waiver: entry.e === "accept-skip" ? acceptedSkip(entry) : null,
        });
      } catch {
        malformed++;
      }
    });
  entries.sort((a, b) => a.at - b.at || (a.by < b.by ? -1 : a.by > b.by ? 1 : a.index - b.index));
  const acceptedSkips: SpecweaveAcceptedSkip[] = [];
  const waiverKeys = new Set<string>();
  for (const entry of entries) {
    if (entry.e === "accept-skip") {
      const waiver = entry.waiver;
      if (waiver !== null) {
        const key = JSON.stringify([waiver.ac, waiver.check.toLowerCase()]);
        if (!waiverKeys.has(key)) {
          waiverKeys.add(key);
          acceptedSkips.push(waiver);
        }
      }
      continue;
    }
    if (META_EVENTS.has(entry.e)) {
      // A note on a task carries its card line and link; it changes no state.
      if (entry.e === "note" && entry.t !== "*" && (entry.line !== null || entry.link !== null)) {
        const noted = stateFor(entry.t);
        if (noted) {
          if (entry.line !== null) noted.line = entry.line;
          if (entry.link !== null) noted.link = entry.link;
        }
      }
      continue;
    }
    const state = stateFor(entry.t);
    if (!state) continue;
    const finished = state.status === "done" || state.status === "skipped";
    const heldByOther =
      (state.status === "claimed" || state.status === "blocked") &&
      state.owner !== entry.by &&
      entry.at - state.since <= LEASE_MS;
    // Only an event the fold accepts changes the card.
    const card = () => {
      if (entry.line !== null) state.line = entry.line;
      if (entry.link !== null) state.link = entry.link;
    };
    const take = (status: ModSpecweaveTask["status"]) => {
      Object.assign(state, {
        status,
        owner: entry.by,
        since: entry.at,
        changedAt: entry.iso,
        note: status === "blocked" || status === "skipped" ? entry.note : null,
        evidence: status === "done" ? entry.evidence : state.evidence,
      });
      card();
    };
    switch (entry.e) {
      case "claim":
      case "block":
        if (!finished && !heldByOther) take(entry.e === "claim" ? "claimed" : "blocked");
        break;
      case "done":
        if (entry.hasEvidence && state.status !== "skipped" && !heldByOther) take("done");
        break;
      case "skip":
        if (entry.note !== null && !finished && !heldByOther) take("skipped");
        break;
      case "release":
        if (
          (state.status === "claimed" || state.status === "blocked") &&
          state.owner === entry.by
        ) {
          Object.assign(state, {
            status: "released",
            owner: null,
            changedAt: entry.iso,
            note: null,
          });
          card();
        }
        break;
    }
  }
  const folded = tasks.map((task) => {
    const state = states.get(task.id)!;
    return {
      id: task.id,
      title: task.title,
      criteria: [...task.criteria],
      status: state.status === "claimed" && now - state.since > LEASE_MS ? "stale" : state.status,
      changedAt: state.changedAt,
      note: state.note,
    } satisfies ModSpecweaveTask;
  });
  const derive = (state: State) =>
    state.link ??
    (state.status === "done"
      ? deriveCardLink(state.evidence, {
          origin: options.origin ?? null,
          incrementId: options.incrementId ?? null,
        })
      : null);
  return {
    tasks: folded,
    cards: [
      ...folded.map((task) => {
        const state = states.get(task.id)!;
        return {
          id: task.id,
          state: cardState(task.status),
          line: state.line ?? task.title,
          link: derive(state),
        };
      }),
      ...[...ledgerOnly].map(([id, state]) => ({
        id,
        state: cardState(
          state.status === "claimed" && now - state.since > LEASE_MS ? "stale" : state.status,
        ),
        line: state.line ?? id,
        link: derive(state),
      })),
    ],
    malformed,
    acceptedSkips,
  };
}

/** `reports/verify.json` as `specweave verify` writes it; anything else is no run. */
export function parseVerifyReport(text: string | null): ModSpecweaveIncrement["verify"] {
  if (text === null) return null;
  try {
    const raw: unknown = JSON.parse(text);
    if (typeof raw !== "object" || raw === null) return null;
    const report = raw as Record<string, unknown>;
    const ranAt = isoOrNull(report.ranAt);
    return typeof report.ok === "boolean" && ranAt !== null ? { ok: report.ok, ranAt } : null;
  } catch {
    return null;
  }
}

/** `metadata.json` as an object; anything else reads as empty. */
export function parseIncrementMetadata(text: string | null): Record<string, unknown> {
  if (text === null) return {};
  try {
    const parsed: unknown = JSON.parse(text);
    return typeof parsed === "object" && parsed !== null && !Array.isArray(parsed)
      ? (parsed as Record<string, unknown>)
      : {};
  } catch {
    return {};
  }
}

export interface SpecweaveProject {
  readonly title: string;
  readonly workspaceRoot: string;
}

/** Reads the SpecWeave increments of the given projects. Never fails: unreadable parts are left out. */
export const readSpecweaveProgress = (projects: ReadonlyArray<SpecweaveProject>, at?: number) =>
  Effect.gen(function* () {
    const now = at ?? (yield* Clock.currentTimeMillis);
    const fs = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;

    const inside = (root: string, file: string) => {
      const relative = path.relative(root, file);
      return (
        relative === "" ||
        (!path.isAbsolute(relative) && relative !== ".." && !relative.startsWith(`..${path.sep}`))
      );
    };

    /** A file inside `root` (after resolving links) and no bigger than `maximum`, else null. */
    const readText = (root: string, file: string, maximum: number) =>
      Effect.gen(function* () {
        const resolved = yield* fs.realPath(file);
        if (!inside(root, resolved)) return null;
        const info = yield* fs.stat(resolved);
        if (info.type !== "File" || info.size > BigInt(maximum)) return null;
        const bytes = yield* fs.readFile(resolved);
        if (bytes.byteLength > maximum) return null;
        // Invalid UTF-8 must be a failure, not a defect, so the file reads as null.
        return yield* Effect.try({
          try: () => new TextDecoder("utf-8", { fatal: true }).decode(bytes),
          catch: () => "invalid-utf8" as const,
        });
      }).pipe(Effect.orElseSucceed(() => null));

    const increments: ModSpecweaveIncrement[] = [];
    let truncated = false;
    const seenRoots = new Set<string>();

    for (const project of projects.slice(0, MAX_PROJECTS)) {
      if (increments.length >= MAX_INCREMENTS) {
        truncated = true;
        break;
      }
      const root = yield* fs.realPath(project.workspaceRoot).pipe(Effect.orElseSucceed(() => null));
      if (root === null || seenRoots.has(root)) continue;
      seenRoots.add(root);
      // The increments folder itself must resolve inside the project.
      const directory = yield* fs
        .realPath(path.join(root, ".specweave", "increments"))
        .pipe(Effect.orElseSucceed(() => null));
      if (directory === null || !inside(root, directory)) continue;
      const names = yield* fs.readDirectory(directory).pipe(Effect.orElseSucceed(() => []));
      const folders = names
        .filter((name) => name.length <= MAX_INCREMENT_ID && INCREMENT_DIRECTORY.test(name))
        .sort(compareIncrementFoldersNewestFirst);
      if (folders.length > MAX_DIRECTORIES_SCANNED) truncated = true;

      // Metadata first, for every folder: it decides what is listed before any
      // spec or ledger is read, and closed increments past the window cost one read.
      const statuses = yield* Effect.forEach(
        folders.slice(0, MAX_DIRECTORIES_SCANNED),
        (name) =>
          readText(root, path.join(directory, name, "metadata.json"), METADATA_BYTES).pipe(
            Effect.map((text) => {
              const metadata = parseIncrementMetadata(text);
              const status = bounded(metadata.status, 32)?.toLowerCase() ?? "unknown";
              const updatedAt =
                isoOrNull(metadata.lastActivity) ??
                isoOrNull(metadata.updated) ??
                isoOrNull(metadata.created);
              const closed = CLOSED_STATUSES.has(status);
              const stale =
                closed && (updatedAt === null || now - Date.parse(updatedAt) > RECENTLY_CLOSED_MS);
              return { name, metadata, status, updatedAt, closed, stale };
            }),
          ),
        { concurrency: METADATA_CONCURRENCY },
      );
      const listable = statuses.filter((entry) => !entry.stale);
      const room = Math.min(MAX_INCREMENTS_PER_PROJECT, MAX_INCREMENTS - increments.length);
      if (listable.length > room) truncated = true;
      // When the cap is hit, open increments win over recently closed ones; the
      // chosen ones are still listed newest first.
      const chosen = new Set(
        [...listable.filter((entry) => !entry.closed), ...listable.filter((entry) => entry.closed)]
          .slice(0, room)
          .map((entry) => entry.name),
      );

      for (const { name, metadata, status, updatedAt } of listable) {
        if (!chosen.has(name)) continue;
        const folder = path.join(directory, name);
        const spec = yield* readText(root, path.join(folder, "spec.md"), SPEC_BYTES);
        // A ledger that exists but cannot be read must not fold as empty.
        const ledgerPath = path.join(folder, "ledger.jsonl");
        const ledgerExists = yield* fs.exists(ledgerPath).pipe(Effect.orElseSucceed(() => true));
        const ledger = ledgerExists ? yield* readText(root, ledgerPath, LEDGER_BYTES) : "";
        const verify = parseVerifyReport(
          yield* readText(root, path.join(folder, "reports", "verify.json"), SMALL_BYTES),
        );
        const fromSpec = spec === null ? null : parseSpecweaveSpec(spec);
        // Like SpecWeave's tasksFileFor: tasks.md, when present, holds the tasks.
        const tasksFile = yield* readText(root, path.join(folder, "tasks.md"), SPEC_BYTES);
        const parsed =
          fromSpec === null && tasksFile === null
            ? null
            : {
                title: fromSpec?.title ?? null,
                criteria: fromSpec?.criteria ?? [],
                tasks: tasksFile !== null ? parseSpecweaveSpec(tasksFile).tasks : fromSpec!.tasks,
              };
        const folded =
          parsed === null || parsed.tasks.length === 0 || ledger === null
            ? { tasks: [], malformed: 0 }
            : foldSpecweaveLedger(parsed.tasks, ledger, now);
        increments.push({
          project: bounded(project.title, 80) ?? "Untitled project",
          id: name,
          title: bounded(metadata.title, 120) ?? parsed?.title ?? null,
          status,
          updatedAt,
          readable: parsed !== null && parsed.tasks.length > 0 && ledger !== null,
          criteria: parsed?.criteria.map((criterion) => ({ ...criterion })) ?? [],
          tasks: folded.tasks,
          malformedLedgerLines: folded.malformed,
          verify,
        });
      }
    }
    return { increments, truncated } satisfies ModSpecweaveResult;
  });
