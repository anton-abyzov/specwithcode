/**
 * The first merge of a personal assistant that joins a link (1448 D-15):
 * automatic and lossless. Nothing is asked and nothing is dropped.
 *
 * Only the seat that joins runs this; existing members never rename anything.
 * `MEMORY.md` becomes the link's lines followed by this seat's lines the link
 * lacks. Any other shared file whose name the link holds with different
 * content keeps its content here under `<name>.from-<machine>.md`, and its
 * pointer in this seat's index lines follows it. Local-only and secret-flagged
 * files never sync and are left alone.
 *
 * Call `planAutoMerge` and `applyAutoMerge` (or `autoMergeJoiningSeat`) on
 * every join attempt, before the link is written on this seat: both are
 * idempotent, also after a restart between two writes.
 *
 * @module personalAutoMerge
 */
import {
  LINKED_MEMORY_HISTORY_LIMIT,
  PROJECT_MEMORY_FILE_BYTES,
  type ProjectId,
  ProjectWorkspaceError,
} from "@specweave-studio/contracts";
import { renamedMemoryName } from "@specweave-studio/shared/personalAssistantMigration";
import * as Effect from "effect/Effect";
import * as Result from "effect/Result";
import * as Schema from "effect/Schema";

import { memoryContentHash } from "./LinkedMemoryHistory.ts";
import type * as LinkedMemoryHistory from "./LinkedMemoryHistory.ts";
import { MEMORY_INDEX_NAME, type MemoryHistoryState } from "./linkedMemoryMerge.ts";
import { containsMemorySecret } from "./memorySecretScan.ts";
import type * as ProjectWorkspaceService from "./ProjectWorkspaceService.ts";

export interface AutoMergeLinkFile {
  readonly name: string;
  /** `memoryContentHash` of the content: lowercase hex SHA-256. */
  readonly sha256: string;
}

export interface AutoMergeSeatFile extends AutoMergeLinkFile {
  readonly content: string;
}

export interface AutoMergeLink {
  /** Every file the link shares, `MEMORY.md` included when it has one. */
  readonly files: ReadonlyArray<AutoMergeLinkFile>;
  /** The content of the link's `MEMORY.md`, or null when the link has none. */
  readonly index: string | null;
}

export interface AutoMergeInput {
  readonly link: AutoMergeLink;
  readonly seat: {
    /** Every memory file of the joining seat, shared or not. */
    readonly files: ReadonlyArray<AutoMergeSeatFile>;
    readonly machineLabel: string;
    readonly environmentId: string;
    /** Local-only and secret-flagged names: they never sync, so nothing here touches them. */
    readonly unshared: ReadonlySet<string>;
  };
}

export interface AutoMergeRename {
  readonly from: string;
  readonly to: string;
}

export interface AutoMergePlan {
  readonly renames: ReadonlyArray<AutoMergeRename>;
  /**
   * What this seat's `MEMORY.md` must hold, or null when the seat has no
   * shared index to change. `base` is the link's version the content was built
   * on: recorded as a version this seat has had, so the first sync sees the
   * union as the newer of the two and no seat merges them into clash markers.
   */
  readonly index: {
    readonly content: string;
    readonly base: { readonly sha256: string; readonly content: string } | null;
  } | null;
}

const MEMORY_NAME_MAX = 128;
const byteLength = (content: string) => new TextEncoder().encode(content).length;

/** A file's lines without their line feeds; a final line feed adds no empty line. */
const linesOf = (text: string): Array<string> => {
  if (text === "") return [];
  const lines = text.split("\n");
  if (lines.at(-1) === "") lines.pop();
  return lines;
};
/** Two lines are the same line when they differ only in trailing whitespace. */
const lineKey = (line: string) => line.trimEnd();

const escapePattern = (text: string) => text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

/** A Markdown link target or bare file name of exactly `name`, as `pointerRewriter` finds it. */
const namePattern = (names: string) =>
  `(?<![A-Za-z0-9_.-])(?:${names})(?![A-Za-z0-9_-]|\\.[A-Za-z0-9])`;
const mentions = (text: string, name: string) =>
  new RegExp(namePattern(escapePattern(name))).test(text);

/**
 * Rewrites each renamed file's old name to its new one, as a Markdown link
 * target or a bare file name, in one pass. A longer name that merely contains
 * the old one (`my-notes.md`, `notes.md.bak`) is another file and stays.
 */
const pointerRewriter = (renames: ReadonlyArray<AutoMergeRename>) => {
  if (renames.length === 0) return (text: string) => text;
  const targets = new Map(renames.map((rename) => [rename.from, rename.to]));
  const names = [...targets.keys()]
    .toSorted((left, right) => right.length - left.length)
    .map(escapePattern)
    .join("|");
  const pattern = new RegExp(namePattern(names), "g");
  return (text: string) => text.replace(pattern, (name) => targets.get(name) ?? name);
};

/**
 * The link's lines in their order, then this seat's lines the link lacks, in
 * their own order. A seat index that already starts with the link's lines is
 * an earlier union: only what follows them is this seat's own, so a second
 * run changes nothing and never rewrites a line that came from the link.
 */
const unionIndex = (link: string, seat: string, rewrite: (line: string) => string): string => {
  const linkLines = linesOf(link);
  const known = new Set(linkLines.map(lineKey));
  const seatLines = linesOf(seat);
  const unioned =
    linkLines.length > 0 &&
    seatLines.length >= linkLines.length &&
    linkLines.every((line, at) => lineKey(line) === lineKey(seatLines[at]!));
  const own = unioned ? seatLines.slice(linkLines.length) : seatLines;
  const extras = own.map(rewrite).filter((line) => !known.has(lineKey(line)));
  if (extras.length === 0) return link;
  return `${link === "" || link.endsWith("\n") ? link : `${link}\n`}${extras.join("\n")}\n`;
};

/**
 * Every renamed copy is reachable from the merged index (D-15). A copy the
 * index does not name yet, because this seat's line for it matched one of the
 * link's lines, gets this seat's lines for the old name pointed at the new
 * one, or a plain link when no line named it. A second run finds the names
 * and adds nothing.
 */
const pointToRenamedCopies = (
  content: string,
  seatIndex: string,
  renames: ReadonlyArray<AutoMergeRename>,
): string => {
  const missing = renames.filter(
    (rename) => rename.from !== MEMORY_INDEX_NAME && !mentions(content, rename.to),
  );
  if (missing.length === 0) return content;
  const rewrite = pointerRewriter(renames);
  const present = new Set(linesOf(content).map(lineKey));
  const added: Array<string> = [];
  const add = (line: string) => {
    if (present.has(lineKey(line))) return;
    present.add(lineKey(line));
    added.push(line);
  };
  for (const rename of missing) {
    const named = linesOf(seatIndex).filter((line) => mentions(line, rename.from));
    if (named.length === 0) add(`- [${rename.to}](${rename.to})`);
    else for (const line of named) add(rewrite(line));
  }
  if (added.length === 0) return content;
  return `${content === "" || content.endsWith("\n") ? content : `${content}\n`}${added.join("\n")}\n`;
};

/**
 * `<name>.from-<machine>.md`, then `-2`, `-3`… until a name is free or already
 * holds this content. Always the same name for the same inputs.
 */
const renameTarget = (
  name: string,
  machineLabel: string,
  environmentId: string,
  holds: (candidate: string) => "free" | "same" | "taken",
): string => {
  const first = renamedMemoryName(name, machineLabel, environmentId);
  const at = first.lastIndexOf(".from-");
  const stem = first.slice(0, at);
  const machine = first.slice(at, -".md".length);
  for (let attempt = 1; ; attempt += 1) {
    const suffix = `${machine}${attempt === 1 ? "" : `-${attempt}`}.md`;
    const kept = stem.slice(0, MEMORY_NAME_MAX - suffix.length).replace(/\.+$/, "");
    const candidate = `${kept.length > 0 ? kept : "memory"}${suffix}`;
    if (holds(candidate) !== "taken") return candidate;
  }
};

/**
 * Plans the joining seat's side of the first merge. Pure: the same input gives
 * the same plan, and the plan of an already merged seat renames nothing and
 * keeps its index.
 */
export const planAutoMerge = (input: AutoMergeInput): AutoMergePlan => {
  const { link, seat } = input;
  const linkShas = new Map(link.files.map((file) => [file.name, file.sha256]));
  const seatFiles = new Map(seat.files.map((file) => [file.name, file]));
  const taken = new Set<string>();
  const targetFor = (file: AutoMergeSeatFile) => {
    const target = renameTarget(file.name, seat.machineLabel, seat.environmentId, (candidate) => {
      // A name kept on this machine would keep the copy from being shared.
      if (taken.has(candidate) || seat.unshared.has(candidate)) return "taken";
      const mine = seatFiles.get(candidate);
      // The same content under the target is an earlier rename that stopped halfway.
      if (mine !== undefined) return mine.sha256 === file.sha256 ? "same" : "taken";
      const theirs = linkShas.get(candidate);
      return theirs === undefined || theirs === file.sha256 ? "free" : "taken";
    });
    taken.add(target);
    return target;
  };

  const renames: Array<AutoMergeRename> = [];
  for (const file of seat.files.toSorted((left, right) => (left.name < right.name ? -1 : 1))) {
    if (file.name === MEMORY_INDEX_NAME || seat.unshared.has(file.name)) continue;
    const theirs = linkShas.get(file.name);
    if (theirs === undefined || theirs === file.sha256) continue;
    renames.push({ from: file.name, to: targetFor(file) });
  }

  const seatIndex = seat.unshared.has(MEMORY_INDEX_NAME)
    ? undefined
    : seatFiles.get(MEMORY_INDEX_NAME);
  if (seatIndex === undefined) return { renames, index: null };
  const rewrite = pointerRewriter(renames);
  const listedSha = linkShas.get(MEMORY_INDEX_NAME);
  // The link has no index: this seat's stays, with its pointers following the renames.
  if (link.index === null && listedSha === undefined)
    return {
      renames,
      index: {
        content: pointToRenamedCopies(rewrite(seatIndex.content), seatIndex.content, renames),
        base: null,
      },
    };
  const content =
    link.index === null
      ? listedSha === seatIndex.sha256
        ? seatIndex.content
        : undefined
      : pointToRenamedCopies(
          unionIndex(link.index, seatIndex.content, rewrite),
          seatIndex.content,
          renames,
        );
  // An index that cannot be unioned (its text was not sent, or the union is too
  // large for one file) is kept like any other clashing file, so nothing is lost.
  if (content === undefined || byteLength(content) > PROJECT_MEMORY_FILE_BYTES)
    return {
      renames: [...renames, { from: MEMORY_INDEX_NAME, to: targetFor(seatIndex) }],
      index: null,
    };
  const base =
    link.index === null ? null : { sha256: memoryContentHash(link.index), content: link.index };
  return {
    renames,
    index: {
      content,
      base: base !== null && base.sha256 !== memoryContentHash(content) ? base : null,
    },
  };
};

/** Why a planned merge could not be written; the join stops and retries the same plan. */
export class PersonalAutoMergeError extends Schema.TaggedError<PersonalAutoMergeError>()(
  "PersonalAutoMergeError",
  {
    projectId: Schema.String,
    stage: Schema.Literals(["read", "index", "base", "rename", "tombstones"]),
    /** The memory file the stage was working on. */
    name: Schema.optional(Schema.String),
    cause: Schema.Defect(),
  },
) {
  override get message(): string {
    switch (this.stage) {
      case "read":
        return "Could not read this personal assistant's memory for the merge.";
      case "index":
        return "Could not write the merged MEMORY.md.";
      case "base":
        return "Could not record the link's MEMORY.md as the merge base.";
      case "rename":
        return `Could not rename memory file ${this.name ?? ""} for the merge.`;
      case "tombstones":
        return "Could not clear the deletions made before the link.";
    }
  }
}

export interface AutoMergeServices {
  readonly workspace: Pick<
    ProjectWorkspaceService.ProjectWorkspaceService["Service"],
    "readMemoryFiles" | "writeMemory" | "renameMemory"
  >;
  readonly histories: Pick<
    LinkedMemoryHistory.LinkedMemoryHistory["Service"],
    "saveVersion" | "modify"
  >;
}

export interface AutoMergeApplied {
  /** `MEMORY.md` was rewritten by this call. */
  readonly indexWritten: boolean;
  /** The renames this call made; ones an earlier attempt finished are not listed. */
  readonly renamed: ReadonlyArray<AutoMergeRename>;
}

/** `base` remembered as the version of `MEMORY.md` that `current` replaced here. */
const withMergeBase = (
  state: MemoryHistoryState,
  current: string,
  base: string,
): MemoryHistoryState => {
  const stored = state.files[MEMORY_INDEX_NAME];
  const history = [
    ...(stored?.history ?? []).filter((hash) => hash !== base && hash !== current),
    base,
    current,
  ].slice(-LINKED_MEMORY_HISTORY_LIMIT);
  return { ...state, files: { ...state.files, [MEMORY_INDEX_NAME]: { ...stored, history } } };
};

/**
 * Writes a plan to the joining seat: the index first, then the link's index as
 * its merge base, then one rename per file. A rename leaves no tombstone for
 * the old name, so the link's file of that name is never deleted by it. Every
 * step is skipped when an earlier attempt already made it.
 *
 * The merge base is what keeps the first sync clean. The link's index and the
 * union share no version otherwise, and `LinkedMemorySync` would merge two
 * such files into clash markers. With the link's hash in this seat's history,
 * this seat keeps the union and every other seat takes it as the newer version.
 *
 * `indexRevision` is the revision of `MEMORY.md` the plan was built from (null
 * for none). Given, the index is written only over that revision, so an edit
 * made since the plan read it fails the write instead of being replaced.
 */
export const applyAutoMerge = (
  services: AutoMergeServices,
  input: {
    readonly projectId: ProjectId;
    readonly plan: AutoMergePlan;
    readonly indexRevision?: number | null;
  },
): Effect.Effect<AutoMergeApplied, PersonalAutoMergeError> =>
  Effect.gen(function* () {
    const { workspace, histories } = services;
    const { projectId, plan } = input;
    const failed = (stage: PersonalAutoMergeError["stage"], name?: string) => (cause: unknown) =>
      new PersonalAutoMergeError({
        projectId,
        stage,
        ...(name === undefined ? {} : { name }),
        cause,
      });
    const files = new Map(
      (yield* workspace.readMemoryFiles({ projectId }).pipe(Effect.mapError(failed("read")))).map(
        (file) => [file.name, file],
      ),
    );

    let indexWritten = false;
    if (plan.index !== null) {
      const current = files.get(MEMORY_INDEX_NAME);
      if (current?.content !== plan.index.content) {
        yield* workspace
          .writeMemory({
            projectId,
            name: MEMORY_INDEX_NAME,
            content: plan.index.content,
            expectedRevision:
              input.indexRevision === undefined ? (current?.revision ?? null) : input.indexRevision,
          })
          .pipe(Effect.mapError(failed("index", MEMORY_INDEX_NAME)));
        indexWritten = true;
      }
      const base = plan.index.base;
      if (base !== null) {
        const sha = memoryContentHash(plan.index.content);
        // Kept readable too: a seat that joined at the same time merges against it.
        yield* histories
          .saveVersion(projectId, base.sha256, base.content)
          .pipe(Effect.mapError(failed("base", MEMORY_INDEX_NAME)));
        yield* histories
          .modify(projectId, (state) => withMergeBase(state, sha, base.sha256))
          .pipe(Effect.mapError(failed("base", MEMORY_INDEX_NAME)));
      }
    }

    const renamed: Array<AutoMergeRename> = [];
    for (const rename of plan.renames) {
      const source = files.get(rename.from);
      if (source === undefined) continue;
      yield* workspace
        .renameMemory({
          projectId,
          from: rename.from,
          to: rename.to,
          expectedRevision: source.revision,
        })
        .pipe(Effect.mapError(failed("rename", rename.from)));
      renamed.push(rename);
    }
    return { indexWritten, renamed };
  });

/** The index changed after the plan read it: plan again from what it is now. */
const isStaleIndex = (error: PersonalAutoMergeError) =>
  error.stage === "index" &&
  error.cause instanceof ProjectWorkspaceError &&
  error.cause.code === "conflict";

/** Attempts at a plan whose index is still current; a busy index fails the join, which retries. */
const AUTO_MERGE_ATTEMPTS = 3;

/**
 * Forgets this seat's deletion records for `names`, the files the other side
 * of a first link holds (D-15). A deletion made before the link was made
 * without the other seat; honoured, it would delete a file only that seat
 * still holds, here and on every member. The joining seat clears its own for
 * the link's files; the seat that starts the link or admits the joiner clears
 * its own for the joiner's files.
 */
export const forgetPreLinkTombstones = (
  histories: Pick<LinkedMemoryHistory.LinkedMemoryHistory["Service"], "modify">,
  projectId: ProjectId,
  names: Iterable<string>,
) => {
  const forget = new Set(names);
  return histories
    .modify(projectId, (state) =>
      Object.keys(state.tombstones).some((name) => forget.has(name))
        ? {
            ...state,
            tombstones: Object.fromEntries(
              Object.entries(state.tombstones).filter(([name]) => !forget.has(name)),
            ),
          }
        : state,
    )
    .pipe(Effect.asVoid);
};

/**
 * Reads the joining seat's memory, plans the merge against the link and
 * applies it, then forgets this seat's deletions of files the link holds.
 * When `MEMORY.md` changed between the read and the write, it reads and plans
 * again, so the edit is part of the union. `localOnly` is the seat's "Keep on this machine" list
 * (`localOnlyMemorySet`); secret-flagged files are found here.
 */
export const autoMergeJoiningSeat = (
  services: AutoMergeServices,
  input: {
    readonly projectId: ProjectId;
    readonly link: AutoMergeLink;
    readonly machineLabel: string;
    readonly environmentId: string;
    readonly localOnly: ReadonlySet<string>;
  },
): Effect.Effect<AutoMergeApplied & { readonly plan: AutoMergePlan }, PersonalAutoMergeError> =>
  Effect.gen(function* () {
    const attempt = Effect.gen(function* () {
      const files = yield* services.workspace
        .readMemoryFiles({ projectId: input.projectId })
        .pipe(
          Effect.mapError(
            (cause) =>
              new PersonalAutoMergeError({ projectId: input.projectId, stage: "read", cause }),
          ),
        );
      const plan = planAutoMerge({
        link: input.link,
        seat: {
          files: files.map((file) => ({
            name: file.name,
            content: file.content,
            sha256: memoryContentHash(file.content),
          })),
          machineLabel: input.machineLabel,
          environmentId: input.environmentId,
          unshared: new Set([
            ...input.localOnly,
            ...files.filter((file) => containsMemorySecret(file.content)).map((file) => file.name),
          ]),
        },
      });
      const indexRevision = files.find((file) => file.name === MEMORY_INDEX_NAME)?.revision ?? null;
      const applied = yield* applyAutoMerge(services, {
        projectId: input.projectId,
        plan,
        indexRevision,
      });
      return { ...applied, plan };
    });
    let result = yield* Effect.result(attempt);
    for (let tries = 1; tries < AUTO_MERGE_ATTEMPTS; tries += 1) {
      if (Result.isSuccess(result) || !isStaleIndex(result.failure)) break;
      result = yield* Effect.result(attempt);
    }
    if (Result.isFailure(result)) return yield* result.failure;
    const merged = result.success;
    yield* forgetPreLinkTombstones(
      services.histories,
      input.projectId,
      input.link.files.map((file) => file.name),
    ).pipe(
      Effect.mapError(
        (cause) =>
          new PersonalAutoMergeError({ projectId: input.projectId, stage: "tombstones", cause }),
      ),
    );
    return merged;
  });
