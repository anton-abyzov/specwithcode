// @effect-diagnostics nodeBuiltinImport:off -- A session is keyed by the file's real path and watches its size and time on disk.
/**
 * Live sessions on documents: one per sheet that is open, on the machine that
 * holds the file. A session keeps the sheet's merge document in memory, takes
 * changes from the windows open on it and from agents, checks each against the
 * writer's access before it merges, tells every window what merged and who is
 * here, and writes the merged sheet back to the plain file.
 *
 * The file is read and written only through `WorkspaceFileSystem`, so a
 * session reaches exactly what opening and saving the file reach.
 */
import * as NodeFSP from "node:fs/promises";
import * as NodePath from "node:path";

import {
  DOCUMENT_SESSION_ACTIVITY_LIMIT,
  DOCUMENT_SESSION_MAX_PARTICIPANTS,
  type DocumentSessionAccess,
  type DocumentSessionActivity,
  DocumentSessionError,
  type DocumentSessionEvent,
  type DocumentSessionOpenInput,
  type DocumentSessionParticipant,
  type DocumentSessionPlace,
  type DocumentSessionPresenceInput,
  type DocumentSessionUpdateInput,
  ProjectLibraryError,
  type ProjectId,
} from "@specweave-studio/contracts";
import {
  OFFICE_ARTIFACTS_DIR,
  SHEET_ARTIFACT_SUFFIX,
  SHEET_NAME_PATTERN,
  type SheetDocument,
  mergeSheetInput,
  serializeSheetDocument,
  sheetContentRevision,
  sheetSlug,
  validateSheetDocument,
} from "@specweave-studio/shared/officeSheet";
import {
  type SheetSnapshot,
  type SheetYDoc,
  applySheetUpdate,
  cloneSheetYDoc,
  encodeSheetState,
  encodeSheetStateVector,
  onSheetUpdate,
  readSheetYDoc,
  sheetHasUnappliedUpdate,
  sheetUpdateFromBase64,
  sheetUpdateToBase64,
  summarizeSheetChange,
  writeSheetChange,
} from "@specweave-studio/shared/sheetCollab";
import * as Cause from "effect/Cause";
import * as Context from "effect/Context";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Queue from "effect/Queue";
import * as Semaphore from "effect/Semaphore";
import * as Stream from "effect/Stream";

import type { SavedSheet } from "../project/OfficeArtifacts.ts";
import * as WorkspaceFileSystem from "../workspace/WorkspaceFileSystem.ts";
import {
  FILE_ORIGIN,
  SHEET_SIDECAR_MAX_BYTES,
  SHEET_SIDECAR_MAX_LINES,
  appendSheetSidecar,
  compactSheetSidecar,
  fileSnapshot,
  loadSheet,
  moveSheetSidecar,
  readSheetFileText,
  readSheetSidecar,
  removeSheetSidecar,
  sheetFileText,
  sheetSidecarLine,
  sheetSidecarMark,
  sheetSidecarPath,
  sweepSheetSidecars,
  unsavedSheetSidecar,
  writeSheetSidecar,
  type SheetSidecarBase,
} from "./sheetYDoc.ts";

/** How long merged changes wait before the file is written. */
const FLUSH_DELAY_MS = 350;
/** How often an open session looks for a change made to the file from outside. */
const WATCH_INTERVAL_MS = 1_500;
/** How long an agent stays shown on the sheet after its write. */
const AGENT_LINGER_MS = 4_000;
/** How long after a save that failed the next one is tried. */
const FLUSH_RETRY_MS = 5000;
const UNSAVED_DETAIL =
  "The sheet could not be saved to its file. Your edits are kept while it stays open, and saving is tried again.";
const WRITE_ATTEMPTS = 3;

const AGENT_ORIGIN = "agent";
const WINDOW_ORIGIN = "window";

type EventQueue = Queue.Queue<DocumentSessionEvent, Cause.Done>;

interface Subscriber {
  readonly sessionKey: string;
  readonly queue: EventQueue;
  participant: DocumentSessionParticipant;
}

interface Session {
  readonly key: string;
  readonly cwd: string;
  readonly relativePath: string;
  readonly absolutePath: string;
  readonly sidecarPath: string;
  readonly doc: SheetYDoc;
  readonly epoch: string;
  readonly lock: Semaphore.Semaphore;
  readonly subscribers: Map<string, Subscriber>;
  readonly agents: Map<string, DocumentSessionParticipant>;
  /** The file's sheet as last read or written, with its tabs' ids in the merge document. */
  saved: SheetSnapshot;
  /** What the merge document holds; always a valid sheet. */
  current: SheetSnapshot;
  fileRevision: string;
  fileStat: string;
  /** The merge document holds changes the file does not. */
  dirty: boolean;
  /** Merged updates the sidecar does not hold yet. */
  pending: Uint8Array[];
  sidecarLines: number;
  sidecarBytes: number;
  activity: DocumentSessionActivity[];
  counter: number;
  flushScheduled: boolean;
  /** Why the last save failed; null while the file is current or a save has not failed. */
  unsaved: string | null;
  /** The revision the sidecar's last line marks as saved; null when its last line is not a mark. */
  marked: string | null;
  /** The file as the log last marked it saved, kept so a long unsaved log can be made short. */
  base: SheetSidecarBase | null;
  /**
   * A window or an agent changed the sheet in this session. Until then nothing
   * is written beside the file: watching a sheet leaves no trace.
   */
  edited: boolean;
  /**
   * Someone who may change the sheet has been here: a window with edit access,
   * or an agent's write. A session only ever watched writes nothing, not the
   * file and not the sidecar, even when it holds edits kept from before.
   */
  authorized: boolean;
  /** The latest write of each agent shown, so an earlier write's timer leaves it be. */
  agentWrites: Map<string, number>;
  watcher: Fiber.Fiber<unknown, unknown> | null;
  closed: boolean;
}

interface Target {
  readonly cwd: string;
  readonly relativePath: string;
}

const refuse = (code: DocumentSessionError["code"], detail: string) =>
  new DocumentSessionError({ code, detail: detail.slice(0, 400) });

/** Whether a failed save was the compare-and-set check finding a newer file. */
function isConflict(cause: unknown): boolean {
  for (let depth = 0, current = cause; depth < 6 && current != null; depth += 1) {
    const message = (current as { message?: unknown }).message;
    if (typeof message === "string" && message.includes("Conflict:")) return true;
    current = (current as { cause?: unknown }).cause;
  }
  return false;
}

/**
 * One name for a file however its path is spelled, in the case the disk
 * holds it in; null when its folder is gone. A file that is not there yet is
 * named by its folder and the name asked for.
 */
const fileIdentity = (absolutePath: string): Promise<string | null> =>
  NodeFSP.realpath(absolutePath).catch(() =>
    NodeFSP.realpath(NodePath.dirname(absolutePath)).then(
      (folder) => NodePath.join(folder, NodePath.basename(absolutePath)),
      () => null,
    ),
  );

/** A file the disk would not describe right now; it is not taken for deleted. */
const UNREADABLE = "unreadable";

/** What tells one state of the file from the next; null only when the file is not there. */
const statSignature = (absolutePath: string): Promise<string | null> =>
  NodeFSP.stat(absolutePath).then(
    (stat) => `${stat.size}:${stat.mtimeMs}:${stat.ino}`,
    (error: NodeJS.ErrnoException) =>
      error.code === "ENOENT" || error.code === "ENOTDIR" ? null : UNREADABLE,
  );

/** A sheet as the text a save writes, worked out once per sheet. */
const canonicalTexts = new WeakMap<SheetDocument, string>();
function canonicalText(document: SheetDocument): string {
  let text = canonicalTexts.get(document);
  if (text === undefined) {
    text = serializeSheetDocument(document);
    canonicalTexts.set(document, text);
  }
  return text;
}

function isSheetPath(relativePath: string): boolean {
  return (
    relativePath.toLowerCase().endsWith(SHEET_ARTIFACT_SUFFIX) && !NodePath.isAbsolute(relativePath)
  );
}

/**
 * A merge that gives a tab's charts replaces the list. Charts the sheet holds
 * that the list does not name are put back in front of it: used when the
 * writer read an earlier sheet and could not have meant to remove them.
 */
function keepUnseenCharts(current: SheetDocument, merged: unknown): unknown {
  const tabs = (merged as { tabs?: unknown } | null)?.tabs;
  if (!Array.isArray(tabs)) return merged;
  return {
    ...(merged as object),
    tabs: tabs.map((tab: { name?: unknown; charts?: unknown } | null) => {
      const name = typeof tab?.name === "string" ? tab.name.trim().toLowerCase() : null;
      const held = current.tabs.find((entry) => entry.name.trim().toLowerCase() === name);
      const charts = tab?.charts;
      if (held?.charts === undefined || !Array.isArray(charts) || charts === held.charts) {
        return tab;
      }
      const named = new Set(charts.map((chart: { id?: unknown } | null) => chart?.id));
      const unseen = held.charts.filter((chart) => !named.has(chart.id));
      return unseen.length === 0 ? tab : { ...tab, charts: [...unseen, ...charts] };
    }),
  };
}

/** The cell an agent's input writes first, for where its flag shows. */
function firstWritten(input: unknown): { readonly tab: string; readonly cell: string } | null {
  const tabs = (input as { tabs?: unknown } | null)?.tabs;
  if (!Array.isArray(tabs)) return null;
  for (const tab of tabs) {
    const name = (tab as { name?: unknown } | null)?.name;
    const cells = (tab as { cells?: unknown } | null)?.cells;
    if (typeof name !== "string" || typeof cells !== "object" || cells === null) continue;
    const cell = Object.keys(cells)[0];
    if (cell !== undefined) return { tab: name, cell: cell.toUpperCase() };
  }
  return null;
}

export class DocumentSession extends Context.Service<
  DocumentSession,
  {
    /**
     * Join a sheet's session: the whole merge state first, then every merged
     * change and every change of who is here, until the subscriber leaves.
     * The caller has been authorized for `input.access`.
     */
    readonly open: (
      input: DocumentSessionOpenInput,
    ) => Stream.Stream<DocumentSessionEvent, DocumentSessionError>;
    /** Merge a window's change. Refused, and not merged, for a session that may only view. */
    readonly update: (
      input: DocumentSessionUpdateInput,
    ) => Effect.Effect<{ readonly merged: boolean }, DocumentSessionError>;
    readonly presence: (
      input: DocumentSessionPresenceInput,
    ) => Effect.Effect<void, DocumentSessionError>;
    /**
     * An agent's `sheet_write` on a sheet that is open: merged as one change
     * and saved. None when no session holds the sheet, so the caller writes
     * the file the usual way.
     */
    readonly writeSheet: (input: {
      readonly projectId: ProjectId;
      readonly workspaceRoot: string;
      readonly sheet: unknown;
      readonly name?: string | undefined;
      readonly merge?: boolean | undefined;
      readonly expectedRevision?: string | undefined;
      readonly by: { readonly id: string; readonly label?: string | undefined };
    }) => Effect.Effect<Option.Option<SavedSheet>, ProjectLibraryError>;
    /**
     * Write what an open session holds to the file now, so a read of the file
     * is current. When the file would not take it, the sheet the session holds
     * is returned for the reader to use in the file's place, under the revision
     * the file last had.
     */
    readonly settle: (input: {
      readonly workspaceRoot: string;
      readonly name: string;
    }) => Effect.Effect<Option.Option<SavedSheet>>;
    /** Write every open session to its file now. */
    readonly settleAll: Effect.Effect<void>;
    /** Look at one open sheet's file for a change made outside the session, now. */
    readonly reconcile: (input: Target) => Effect.Effect<void>;
  }
>()("specweave-studio/documents/DocumentSession") {}

const make = Effect.gen(function* () {
  const files = yield* WorkspaceFileSystem.WorkspaceFileSystem;
  const scope = yield* Effect.scope;
  const sessions = new Map<string, Session>();
  const registryLock = yield* Semaphore.make(1);
  let epochs = 0;

  // ---------------------------------------------------------------- events

  const participantsOf = (session: Session): ReadonlyArray<DocumentSessionParticipant> => [
    ...[...session.subscribers.values()].map((subscriber) => subscriber.participant),
    ...session.agents.values(),
  ];

  const send = (session: Session, event: DocumentSessionEvent, except?: EventQueue): void => {
    for (const subscriber of session.subscribers.values()) {
      if (subscriber.queue !== except) Queue.offerUnsafe(subscriber.queue, event);
    }
  };

  const sendPresence = (session: Session): void =>
    send(session, { type: "presence", participants: participantsOf(session) });

  const freeColor = (session: Session): number => {
    const used = new Set(participantsOf(session).map((participant) => participant.color));
    let color = 0;
    while (used.has(color)) color += 1;
    return color;
  };

  const record = Effect.fn("DocumentSession.record")(function* (
    session: Session,
    by: DocumentSessionActivity["by"],
    before: SheetDocument,
    after: SheetDocument,
    /** The change added to the merge state; with nothing to show for it, another change stands in its place. */
    added = false,
  ) {
    const summary = summarizeSheetChange(before, after);
    const superseded = summary.cells === 0 && !summary.layout;
    if (superseded && !added) return undefined;
    session.counter += 1;
    const entry: DocumentSessionActivity = {
      id: session.counter,
      at: DateTime.formatIso(yield* DateTime.now),
      by,
      cells: summary.cells,
      layout: summary.layout,
      ...(summary.first === undefined ? {} : { first: summary.first.slice(0, 120) }),
      ...(superseded ? { superseded: true } : {}),
    };
    session.activity = [...session.activity, entry].slice(-DOCUMENT_SESSION_ACTIVITY_LIMIT);
    return entry;
  });

  /** Read the merge document as a valid sheet; the document always holds one. */
  const readCurrent = (session: Session): SheetSnapshot => {
    const snapshot = readSheetYDoc(session.doc, session.saved);
    const checked = validateSheetDocument(snapshot.document);
    return checked.ok ? { document: checked.document, tabIds: snapshot.tabIds } : session.current;
  };

  // ---------------------------------------------------------------- the file

  const readFile = (target: Target) =>
    files.readFile({ cwd: target.cwd, relativePath: target.relativePath }).pipe(
      Effect.map((result) => (result.truncated ? null : readSheetFileText(result.contents))),
      Effect.orElseSucceed(() => null),
    );

  const endSession = Effect.fn("DocumentSession.end")(function* (session: Session, reason: string) {
    if (session.closed) return;
    session.closed = true;
    if (sessions.get(session.key) === session) sessions.delete(session.key);
    send(session, { type: "closed", reason });
    for (const subscriber of session.subscribers.values()) Queue.endUnsafe(subscriber.queue);
    session.subscribers.clear();
    if (session.watcher !== null)
      yield* Fiber.interrupt(session.watcher).pipe(Effect.forkIn(scope));
  });

  /**
   * The file is gone from its path. When a file in the same folder is the same
   * file under another name (a rename), what merged and was not saved yet is
   * written to it. A file moved to another folder is not followed. True when
   * the sidecar was moved to the new name instead, and must be left there.
   */
  const followRename = Effect.fn("DocumentSession.followRename")(function* (session: Session) {
    const inode = session.fileStat.split(":")[2];
    const next = sheetFileText(readSheetYDoc(session.doc, session.saved));
    if (!next.ok || inode === undefined || inode === "0") return false;
    const folder = NodePath.dirname(session.absolutePath);
    const name = yield* Effect.promise(async () => {
      const names = await NodeFSP.readdir(folder).catch(() => [] as string[]);
      for (const candidate of names) {
        if (!candidate.toLowerCase().endsWith(SHEET_ARTIFACT_SUFFIX)) continue;
        const stat = await NodeFSP.stat(NodePath.join(folder, candidate)).catch(() => null);
        if (stat !== null && stat.isFile() && String(stat.ino) === inode) return candidate;
      }
      return null;
    });
    if (name === null) return false;
    const written = yield* files
      .writeFile({
        cwd: session.cwd,
        relativePath: NodePath.join(NodePath.dirname(session.relativePath), name),
        contents: next.text,
        expectedRevision: session.fileRevision,
      })
      .pipe(
        Effect.as(true),
        Effect.orElseSucceed(() => false),
      );
    if (written) return false;
    // The renamed file would not take it (it changed too): the log goes with the file, and
    // the edits are merged and saved when the sheet is next opened for editing.
    return yield* Effect.promise(() =>
      moveSheetSidecar(session.sidecarPath, sheetSidecarPath(NodePath.join(folder, name))),
    );
  });

  /**
   * Put what merged into the sidecar. This runs with every change, before its
   * writer is answered: the updates below the log's last mark are what the
   * file has not got, and they are found there if the server stops before the
   * save. With the file current, the log ends in a mark of the file's revision.
   */
  const writeLog: (session: Session) => Effect.Effect<boolean> = Effect.fn(
    "DocumentSession.writeLog",
  )(function* (session: Session) {
    if (session.sidecarLines === 0 && !session.edited) {
      // Nothing merged, nothing to keep: opening a sheet leaves no trace beside it.
      session.pending = [];
      return true;
    }
    // Only a session someone may edit in writes beside the file.
    if (!session.authorized || session.closed) return true;
    const clean = !session.dirty;
    const over =
      session.sidecarLines + session.pending.length > SHEET_SIDECAR_MAX_LINES ||
      session.sidecarBytes > SHEET_SIDECAR_MAX_BYTES;
    const whole = session.sidecarLines === 0 || (clean && over);
    if (whole || (over && session.base !== null)) {
      // The whole state: with the file current, one update and its mark; with the file
      // behind, the state it has, its mark, and everything since as one update.
      const base: SheetSidecarBase | null = clean
        ? { revision: session.fileRevision, state: encodeSheetState(session.doc) }
        : whole
          ? null
          : session.base;
      const text =
        base === null
          ? compactSheetSidecar(session.epoch, session.doc)
          : clean
            ? compactSheetSidecar(session.epoch, session.doc, base.revision)
            : unsavedSheetSidecar(session.epoch, base, session.doc);
      session.counter += 1;
      const written = yield* Effect.promise(() =>
        writeSheetSidecar(session.sidecarPath, text, `.tmp-${session.epoch}-${session.counter}`),
      );
      if (written) {
        session.sidecarLines = text.split("\n").length - 1;
        session.sidecarBytes = text.length;
        session.pending = [];
        session.marked = clean ? session.fileRevision : null;
        session.base = base;
      }
      return written;
    }
    const mark = clean && (session.marked !== session.fileRevision || session.pending.length > 0);
    if (session.pending.length === 0 && !mark) return true;
    const text = `${session.pending.map(sheetSidecarLine).join("")}${
      mark ? sheetSidecarMark(session.fileRevision) : ""
    }`;
    const written = yield* Effect.promise(() => appendSheetSidecar(session.sidecarPath, text));
    if (written) {
      session.sidecarLines += session.pending.length + (mark ? 1 : 0);
      session.sidecarBytes += text.length;
      session.pending = [];
      session.marked = mark ? session.fileRevision : null;
      if (mark) {
        session.base = { revision: session.fileRevision, state: encodeSheetState(session.doc) };
      }
    }
    return written;
  });

  /** Bring a change made to the file from outside into the merge document. */
  const takeFile: (session: Session) => Effect.Effect<void> = Effect.fn("DocumentSession.takeFile")(
    function* (session: Session) {
      if (session.closed) return;
      const exists = yield* Effect.promise(() => statSignature(session.absolutePath));
      if (exists === null) {
        // Renamed with edits not yet in it: they follow the file to its new name.
        const moved = session.dirty && session.authorized ? yield* followRename(session) : false;
        // The document is gone from here, and its merge state goes with it. A session that
        // was only ever watched removes nothing.
        if (!moved && session.authorized) {
          yield* Effect.promise(() =>
            removeSheetSidecar(session.sidecarPath).catch(() => undefined),
          );
        }
        yield* endSession(session, "The sheet was deleted or moved.");
        return;
      }
      const read = yield* readFile(session);
      // A file that cannot be read as a sheet right now (half written, or broken by hand) is left alone.
      if (read === null || !read.ok) return;
      session.fileStat = exists;
      if (read.file.revision === session.fileRevision) return;
      const before = session.current;
      const updates: Uint8Array[] = [];
      const stop = onSheetUpdate(session.doc, (update) => updates.push(update));
      writeSheetChange(session.doc, session.saved, read.file.document, FILE_ORIGIN);
      stop();
      session.fileRevision = read.file.revision;
      session.saved = fileSnapshot(session.doc, read.file.document);
      session.current = readCurrent(session);
      const mine = sheetFileText(session.current);
      // Dirty only when the sheets differ: a file laid out another way is left as it was written.
      session.dirty = !mine.ok || mine.text !== canonicalText(read.file.document);
      session.pending.push(...updates);
      yield* writeLog(session);
      if (updates.length === 0) return;
      const entry = yield* record(
        session,
        { id: "file", kind: "file" },
        before.document,
        session.current.document,
      );
      updates.forEach((update, index) =>
        send(session, {
          type: "update",
          update: sheetUpdateToBase64(update),
          ...(index === updates.length - 1 && entry !== undefined ? { activity: entry } : {}),
        }),
      );
    },
  );

  /** Write the merged sheet to the file. False when it could not be written; it stays to be written. */
  const flush = Effect.fn("DocumentSession.flush")(function* (session: Session) {
    // Edits kept from before are saved once someone who may change the sheet is here.
    if (!session.authorized) return !session.dirty;
    for (
      let attempt = 0;
      attempt < WRITE_ATTEMPTS && session.dirty && !session.closed;
      attempt += 1
    ) {
      const next = sheetFileText(readSheetYDoc(session.doc, session.saved));
      if (!next.ok) return false;
      // A file that already reads as the sheet does is left as it was written.
      if (next.text !== canonicalText(session.saved.document)) {
        const written = yield* files
          .writeFile({
            cwd: session.cwd,
            relativePath: session.relativePath,
            contents: next.text,
            expectedRevision: session.fileRevision,
          })
          .pipe(
            Effect.as("written" as const),
            Effect.catch((cause) =>
              Effect.succeed(isConflict(cause) ? ("conflict" as const) : ("failed" as const)),
            ),
          );
        if (written === "failed") return false;
        if (written === "conflict") {
          // Someone wrote the file since: take that in, then write the merge of both.
          yield* takeFile(session);
          continue;
        }
        session.fileRevision = sheetContentRevision(next.text);
      }
      session.saved = { document: next.document, tabIds: readSheetYDoc(session.doc).tabIds };
      canonicalTexts.set(next.document, next.text);
      session.current = session.saved;
      session.dirty = false;
      session.fileStat =
        (yield* Effect.promise(() => statSignature(session.absolutePath))) ?? session.fileStat;
    }
    yield* writeLog(session);
    return !session.dirty;
  });

  const locked = <A, E>(session: Session, effect: Effect.Effect<A, E>) =>
    session.lock.withPermits(1)(effect);

  /**
   * Save, and say so when the file could not be written: the windows are told
   * once, the save is tried again while a window stays, and they are told when
   * it goes through.
   */
  const save: (session: Session) => Effect.Effect<boolean> = Effect.fn("DocumentSession.save")(
    function* (session: Session) {
      const saved = yield* flush(session);
      if (session.closed || !session.authorized) return saved;
      if (!saved && session.dirty) {
        if (session.unsaved === null) {
          session.unsaved = UNSAVED_DETAIL;
          send(session, { type: "save", saved: false, detail: UNSAVED_DETAIL });
        }
        yield* scheduleFlush(session, FLUSH_RETRY_MS);
      } else if (session.unsaved !== null) {
        session.unsaved = null;
        send(session, { type: "save", saved: true });
      }
      return saved;
    },
  );

  const scheduleFlush = (session: Session, delay: number = FLUSH_DELAY_MS): Effect.Effect<void> =>
    Effect.gen(function* () {
      if (session.flushScheduled || session.closed) return;
      session.flushScheduled = true;
      yield* Effect.sleep(delay).pipe(
        Effect.andThen(
          locked(
            session,
            Effect.suspend(() => {
              session.flushScheduled = false;
              return save(session);
            }),
          ),
        ),
        Effect.catchCause((cause) => Effect.logWarning("document session flush failed", { cause })),
        Effect.forkIn(scope),
      );
    });

  const watch = (session: Session) =>
    Effect.gen(function* () {
      while (!session.closed) {
        yield* Effect.sleep(WATCH_INTERVAL_MS);
        const signature = yield* Effect.promise(() => statSignature(session.absolutePath));
        if (signature === session.fileStat) continue;
        yield* locked(session, takeFile(session));
        if (session.dirty) yield* scheduleFlush(session);
      }
    }).pipe(
      Effect.catchCause((cause) => Effect.logWarning("document session watch stopped", { cause })),
    );

  // ---------------------------------------------------------------- sessions

  const find = Effect.fn("DocumentSession.find")(function* (absolutePath: string) {
    if (sessions.size === 0) return undefined;
    const key = yield* Effect.promise(() => fileIdentity(absolutePath));
    const session = key === null ? undefined : sessions.get(key);
    return session === undefined || session.closed ? undefined : session;
  });

  const findTarget = (target: Target) =>
    isSheetPath(target.relativePath)
      ? find(NodePath.resolve(target.cwd, target.relativePath))
      : Effect.succeed<Session | undefined>(undefined);

  const start = Effect.fn("DocumentSession.start")(function* (target: Target, mayWrite: boolean) {
    if (!isSheetPath(target.relativePath)) {
      return yield* refuse(
        "not_found",
        "Only a sheet in the project folder opens for live editing.",
      );
    }
    // Every caller's path goes through the project's file reader first: the same folder and
    // protected-file checks as opening the file any other way.
    const read = yield* readFile(target);
    if (read === null) return yield* refuse("not_found", "The sheet could not be read.");
    const absolutePath = NodePath.resolve(target.cwd, target.relativePath);
    const key = yield* Effect.promise(() => fileIdentity(absolutePath));
    if (key === null) return yield* refuse("not_found", "The sheet could not be read.");
    // A sheet that is already open is joined as it stands, even while its file cannot be parsed.
    const existing = sessions.get(key);
    if (existing !== undefined && !existing.closed) return existing;
    if (!read.ok) return yield* refuse("not_found", `The file is not a valid sheet: ${read.error}`);
    const sidecarPath = sheetSidecarPath(absolutePath);
    // Merge state of sheets that were deleted while closed goes before this one's is read.
    // A window that may only view removes nothing.
    if (mayWrite) {
      yield* Effect.promise(() =>
        sweepSheetSidecars(NodePath.dirname(absolutePath)).catch(() => undefined),
      );
    }
    const sidecarText = yield* Effect.promise(() => readSheetSidecar(sidecarPath));
    epochs += 1;
    const now = DateTime.toEpochMillis(yield* DateTime.now);
    const loaded = loadSheet(
      read.file.document,
      sidecarText,
      `e${now.toString(36)}-${epochs}`,
      read.file.revision,
    );
    const session: Session = {
      key,
      cwd: target.cwd,
      relativePath: target.relativePath,
      absolutePath,
      sidecarPath,
      doc: loaded.doc,
      epoch: loaded.epoch,
      lock: yield* Semaphore.make(1),
      subscribers: new Map(),
      agents: new Map(),
      saved: loaded.saved,
      current: loaded.saved,
      fileRevision: read.file.revision,
      fileStat: (yield* Effect.promise(() => statSignature(absolutePath))) ?? "",
      // Changes kept from a save that did not happen are saved once an editor is here.
      dirty: loaded.unsaved,
      pending: [...loaded.pending],
      sidecarLines: loaded.sidecarLines,
      sidecarBytes: loaded.sidecarLines > 0 ? (sidecarText?.length ?? 0) : 0,
      activity: [],
      counter: 0,
      flushScheduled: false,
      unsaved: null,
      marked: loaded.marked,
      base: loaded.base,
      edited: false,
      authorized: false,
      agentWrites: new Map(),
      watcher: null,
      closed: false,
    };
    session.current = readCurrent(session);
    sessions.set(key, session);
    session.watcher = yield* watch(session).pipe(Effect.forkIn(scope));
    return session;
  });

  const leave = (session: Session, subscriber: Subscriber) =>
    locked(
      session,
      Effect.gen(function* () {
        if (session.subscribers.get(subscriber.sessionKey) !== subscriber) return;
        session.subscribers.delete(subscriber.sessionKey);
        if (session.subscribers.size > 0) {
          sendPresence(session);
          return;
        }
        // The last window left: the file gets what merged, and the session ends.
        // What the file would not take waits in the sidecar, below its last mark, and is
        // saved when the sheet is next opened for editing.
        yield* flush(session);
        yield* endSession(session, "closed");
      }),
    ).pipe(
      Effect.catchCause((cause) => Effect.logWarning("document session leave failed", { cause })),
    );

  const open: DocumentSession["Service"]["open"] = (input) =>
    Stream.unwrap(
      Effect.gen(function* () {
        const queue = yield* Queue.unbounded<DocumentSessionEvent, Cause.Done>();
        const join = (session: Session) =>
          locked(
            session,
            Effect.gen(function* () {
              // The last window left while this one was on its way in: start over.
              if (session.closed) return null;
              const previous = session.subscribers.get(input.sessionKey);
              if (
                previous === undefined &&
                session.subscribers.size >= DOCUMENT_SESSION_MAX_PARTICIPANTS
              ) {
                return yield* refuse("failed", "Too many windows have this sheet open.");
              }
              // The same window subscribing again (a reconnect) takes its place over.
              if (previous !== undefined) {
                session.subscribers.delete(input.sessionKey);
                Queue.endUnsafe(previous.queue);
              }
              session.counter += 1;
              const access: DocumentSessionAccess = input.access === "edit" ? "edit" : "view";
              const participant: DocumentSessionParticipant = {
                id: `w${session.counter}`,
                kind: "window",
                color: previous?.participant.color ?? freeColor(session),
                access,
              };
              const subscriber: Subscriber = { sessionKey: input.sessionKey, queue, participant };
              session.subscribers.set(input.sessionKey, subscriber);
              Queue.offerUnsafe(queue, {
                type: "snapshot",
                participantId: participant.id,
                epoch: session.epoch,
                access,
                update: sheetUpdateToBase64(encodeSheetState(session.doc)),
                participants: participantsOf(session),
                activity: session.activity,
                ...(session.unsaved === null ? {} : { unsaved: session.unsaved }),
              });
              send(session, { type: "presence", participants: participantsOf(session) }, queue);
              if (access === "edit") {
                session.authorized = true;
                yield* writeLog(session);
                if (session.dirty) yield* scheduleFlush(session);
              }
              return { session, subscriber };
            }),
          );
        // Joining and the promise to leave are one step: a call cut short in between leaves nobody behind.
        yield* Effect.acquireRelease(
          registryLock.withPermits(1)(
            Effect.gen(function* () {
              for (let attempt = 0; attempt < 3; attempt += 1) {
                const entered = yield* join(yield* start(input, input.access === "edit"));
                if (entered !== null) return entered;
              }
              return yield* refuse("failed", "The sheet could not be opened. Try again.");
            }),
          ),
          (joined) => leave(joined.session, joined.subscriber),
        );
        return Stream.fromQueue(queue);
      }),
    );

  const subscriberFor = Effect.fn("DocumentSession.subscriberFor")(function* (
    input: Target & { readonly sessionKey: string },
  ) {
    const session = yield* findTarget(input);
    const subscriber = session?.subscribers.get(input.sessionKey);
    if (session === undefined || subscriber === undefined) {
      return yield* refuse(
        "not_open",
        "This window has no open session on the sheet. Open it again.",
      );
    }
    return { session, subscriber };
  });

  const update: DocumentSession["Service"]["update"] = (input) =>
    Effect.gen(function* () {
      const { session, subscriber } = yield* subscriberFor(input);
      return yield* locked(
        session,
        Effect.gen(function* () {
          // Checked here, on the machine that holds the file, whatever the caller's window believes.
          if (
            session.subscribers.get(input.sessionKey) !== subscriber ||
            subscriber.participant.access !== "edit"
          ) {
            return yield* refuse("view_only", "This window may only view the sheet.");
          }
          const bytes = sheetUpdateFromBase64(input.update);
          if (bytes === null) return yield* refuse("refused", "The change could not be read.");
          // Tried on a copy first: a change that leaves the sheet invalid never merges.
          const trial = cloneSheetYDoc(session.doc);
          if (!applySheetUpdate(trial, bytes, WINDOW_ORIGIN)) {
            return yield* refuse("refused", "The change could not be read.");
          }
          // A change that builds on one this machine never got is sent again, with what it builds on.
          if (sheetHasUnappliedUpdate(trial)) {
            return yield* refuse("failed", "The change arrived before the one it follows.");
          }
          const trialSnapshot = readSheetYDoc(trial, session.saved);
          const checked = sheetFileText(trialSnapshot);
          if (!checked.ok) return yield* refuse("refused", checked.error);
          const before = session.current;
          // New writes that change nothing on screen lost to a change made at the same time.
          const added =
            sheetUpdateToBase64(encodeSheetStateVector(trial)) !==
            sheetUpdateToBase64(encodeSheetStateVector(session.doc));
          // Nothing new and nothing changed (a change sent twice): the sheet and its file stay as they are.
          if (!added && checked.text === canonicalText(before.document)) return { merged: true };
          session.authorized = true;
          session.edited = true;
          // The log starts from the sheet as the file has it, so the change below is told apart from it.
          if (session.sidecarLines === 0) yield* writeLog(session);
          applySheetUpdate(session.doc, bytes, WINDOW_ORIGIN);
          session.current = { document: checked.document, tabIds: trialSnapshot.tabIds };
          canonicalTexts.set(checked.document, checked.text);
          session.pending.push(bytes);
          session.dirty = checked.text !== canonicalText(session.saved.document);
          // In the log before the window is answered: a server that stops now still has it.
          // Where the log cannot be written, the file is, before the answer; and where that
          // fails too, the windows are told the sheet is not saved.
          if (!(yield* writeLog(session))) yield* save(session);
          const { id, color } = subscriber.participant;
          const entry = yield* record(
            session,
            { id, kind: "window", color },
            before.document,
            checked.document,
            added,
          );
          send(session, {
            type: "update",
            update: input.update,
            ...(entry === undefined ? {} : { activity: entry }),
          });
          yield* scheduleFlush(session);
          return { merged: true };
        }),
      );
    });

  const presence: DocumentSession["Service"]["presence"] = (input) =>
    Effect.gen(function* () {
      const { session, subscriber } = yield* subscriberFor(input);
      yield* locked(
        session,
        Effect.sync(() => {
          if (session.subscribers.get(input.sessionKey) !== subscriber) return;
          const { place: _place, ...rest } = subscriber.participant;
          subscriber.participant = input.place === null ? rest : { ...rest, place: input.place };
          sendPresence(session);
        }),
      );
    });

  // ---------------------------------------------------------------- agents

  const artifactPath = (workspaceRoot: string, name: string): string | null => {
    const trimmed = name.trim().toLowerCase();
    const stem = trimmed.endsWith(SHEET_ARTIFACT_SUFFIX)
      ? trimmed.slice(0, -SHEET_ARTIFACT_SUFFIX.length)
      : trimmed;
    return SHEET_NAME_PATTERN.test(stem)
      ? NodePath.join(
          NodePath.resolve(workspaceRoot),
          ...OFFICE_ARTIFACTS_DIR.split("/"),
          `${stem}${SHEET_ARTIFACT_SUFFIX}`,
        )
      : null;
  };

  /**
   * The open session on an agent's artifact, when the artifact is a plain file
   * inside the agent's own project folder. A link at that path (to a sheet open
   * under another project, say) finds no session: the file writer, which
   * refuses links, deals with it.
   */
  const findArtifact = Effect.fn("DocumentSession.findArtifact")(function* (
    workspaceRoot: string,
    absolutePath: string,
  ) {
    if (sessions.size === 0) return undefined;
    const inside = yield* Effect.promise(async () => {
      const stat = await NodeFSP.lstat(absolutePath).catch(() => null);
      if (stat === null || !stat.isFile()) return false;
      const [root, real] = await Promise.all([
        NodeFSP.realpath(workspaceRoot).catch(() => null),
        NodeFSP.realpath(absolutePath).catch(() => null),
      ]);
      return root !== null && real !== null && real.startsWith(`${root}${NodePath.sep}`);
    });
    return inside ? yield* find(absolutePath) : undefined;
  });

  const writeSheet: DocumentSession["Service"]["writeSheet"] = (input) =>
    Effect.gen(function* () {
      if (sessions.size === 0) return Option.none();
      const title = (input.sheet as { title?: unknown } | null)?.title;
      const name =
        input.name ??
        (typeof title === "string" && title.trim().length > 0 ? sheetSlug(title) : null);
      const absolutePath = name === null ? null : artifactPath(input.workspaceRoot, name);
      if (absolutePath === null) return Option.none();
      const session = yield* findArtifact(input.workspaceRoot, absolutePath);
      if (session === undefined) return Option.none();
      const invalid = (detail: string) =>
        new ProjectLibraryError({ projectId: input.projectId, code: "invalid", detail });
      const stem = NodePath.basename(absolutePath).slice(0, -SHEET_ARTIFACT_SUFFIX.length);
      return yield* locked(
        session,
        Effect.gen(function* () {
          // The file first: a write from outside the session is part of what the agent builds on.
          yield* takeFile(session);
          if (session.closed) return Option.none<SavedSheet>();
          if (input.merge !== true && input.expectedRevision !== undefined) {
            // Replacing the whole sheet over edits the agent has not read stays a conflict.
            yield* flush(session);
            if (input.expectedRevision !== session.fileRevision) {
              return yield* invalid(
                `Conflict: sheet ${stem} changed (expected ${input.expectedRevision}, current ${session.fileRevision}). Re-read the sheet and retry.`,
              );
            }
          }
          const before = session.current;
          // The agent read an earlier sheet: a chart added since is one it never saw, and stays.
          const behind =
            input.expectedRevision !== undefined &&
            (session.dirty || input.expectedRevision !== session.fileRevision);
          const merged =
            input.merge === true ? mergeSheetInput(before.document, input.sheet) : input.sheet;
          const checked = validateSheetDocument(
            input.merge === true && behind ? keepUnseenCharts(before.document, merged) : merged,
          );
          if (!checked.ok) return yield* invalid(checked.error);
          const size = sheetFileText({ document: checked.document, tabIds: [] });
          if (!size.ok) return yield* invalid(size.error);

          const agentId = `agent:${input.by.id}`.slice(0, 64);
          session.authorized = true;
          if (session.sidecarLines === 0 && size.text !== canonicalText(before.document)) {
            // The log starts from the sheet as the file has it, as it does for a window's change.
            session.edited = true;
            yield* writeLog(session);
          }
          const updates: Uint8Array[] = [];
          const stop = onSheetUpdate(session.doc, (update) => updates.push(update));
          writeSheetChange(session.doc, before, checked.document, AGENT_ORIGIN);
          stop();
          session.current = readCurrent(session);

          // Where the agent wrote, in the sheet as it reads now: a tab it added has its id only now.
          const written = firstWritten(input.sheet);
          const tabIndex =
            written === null
              ? 0
              : Math.max(
                  0,
                  session.current.document.tabs.findIndex(
                    (tab) => tab.name.toLowerCase() === written.tab.trim().toLowerCase(),
                  ),
                );
          const tabId = session.current.tabIds[tabIndex];
          const place: DocumentSessionPlace | undefined =
            tabId === undefined
              ? undefined
              : { tab: tabId, cell: (written?.cell ?? "A1").slice(0, 16) };
          const color = session.agents.get(agentId)?.color ?? freeColor(session);
          session.agents.set(agentId, {
            id: agentId,
            kind: "agent",
            color,
            access: "edit",
            ...(input.by.label === undefined ? {} : { label: input.by.label.slice(0, 200) }),
            ...(place === undefined ? {} : { place }),
          });
          sendPresence(session);

          if (updates.length > 0) {
            session.pending.push(...updates);
            const text = sheetFileText(session.current);
            session.dirty = !text.ok || text.text !== canonicalText(session.saved.document);
            session.edited = true;
            yield* writeLog(session);
            const entry = yield* record(
              session,
              {
                id: agentId,
                kind: "agent",
                color,
                ...(input.by.label === undefined ? {} : { label: input.by.label.slice(0, 200) }),
              },
              before.document,
              session.current.document,
            );
            updates.forEach((bytes, index) =>
              send(session, {
                type: "update",
                update: sheetUpdateToBase64(bytes),
                ...(index === updates.length - 1 && entry !== undefined ? { activity: entry } : {}),
              }),
            );
          }
          const saved = yield* save(session);
          // The agent stays shown for a moment after its latest write, so a person sees where it wrote.
          session.counter += 1;
          const write = session.counter;
          session.agentWrites.set(agentId, write);
          yield* Effect.sleep(AGENT_LINGER_MS).pipe(
            Effect.andThen(
              locked(
                session,
                Effect.sync(() => {
                  if (session.agentWrites.get(agentId) !== write) return;
                  session.agentWrites.delete(agentId);
                  if (session.agents.delete(agentId) && !session.closed) sendPresence(session);
                }),
              ),
            ),
            Effect.forkIn(scope),
          );
          if (!saved) {
            return yield* new ProjectLibraryError({
              projectId: input.projectId,
              code: "operation_failed",
              detail:
                "The change is in the open sheet but the file could not be saved yet. Read the sheet again before the next write.",
            });
          }
          const relativePath = `${OFFICE_ARTIFACTS_DIR}/${stem}${SHEET_ARTIFACT_SUFFIX}`;
          return Option.some<SavedSheet>({
            name: stem,
            relativePath,
            absolutePath,
            document: session.saved.document,
            revision: session.fileRevision,
            created: false,
          });
        }),
      );
    });

  const settle: DocumentSession["Service"]["settle"] = (input) =>
    Effect.gen(function* () {
      if (sessions.size === 0) return Option.none<SavedSheet>();
      const absolutePath = artifactPath(input.workspaceRoot, input.name);
      const session =
        absolutePath === null ? undefined : yield* findArtifact(input.workspaceRoot, absolutePath);
      if (absolutePath === null || session === undefined) return Option.none<SavedSheet>();
      const stem = NodePath.basename(absolutePath).slice(0, -SHEET_ARTIFACT_SUFFIX.length);
      return yield* locked(
        session,
        Effect.gen(function* () {
          const saved = yield* save(session);
          return saved || session.closed
            ? Option.none<SavedSheet>()
            : Option.some<SavedSheet>({
                name: stem,
                relativePath: `${OFFICE_ARTIFACTS_DIR}/${stem}${SHEET_ARTIFACT_SUFFIX}`,
                absolutePath,
                document: session.current.document,
                revision: session.fileRevision,
                created: false,
              });
        }),
      );
    });

  const settleAll = Effect.suspend(() =>
    Effect.forEach([...sessions.values()], (session) => locked(session, save(session)), {
      discard: true,
    }),
  );

  const reconcile: DocumentSession["Service"]["reconcile"] = (input) =>
    Effect.gen(function* () {
      const session = yield* findTarget(input);
      if (session === undefined) return;
      yield* locked(
        session,
        Effect.gen(function* () {
          yield* takeFile(session);
          if (session.dirty) yield* save(session);
        }),
      );
    });

  // What merged reaches the file before the server stops.
  yield* Effect.addFinalizer(() => settleAll.pipe(Effect.ignoreCause));

  return DocumentSession.of({
    open,
    update,
    presence,
    writeSheet,
    settle,
    settleAll,
    reconcile,
  });
});

export const layer = Layer.effect(DocumentSession, make);
