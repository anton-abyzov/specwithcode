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
  onSheetUpdate,
  readSheetYDoc,
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
  readSheetFileText,
  readSheetSidecar,
  removeSheetSidecar,
  sheetFileText,
  sheetSidecarLine,
  sheetSidecarPath,
  writeSheetSidecar,
} from "./sheetYDoc.ts";

/** How long merged changes wait before the file is written. */
const FLUSH_DELAY_MS = 350;
/** How often an open session looks for a change made to the file from outside. */
const WATCH_INTERVAL_MS = 1_500;
/** How long an agent stays shown on the sheet after its write. */
const AGENT_LINGER_MS = 4_000;
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

/** One name for a file however its path is spelled; null when its folder is gone. */
const fileIdentity = (absolutePath: string): Promise<string | null> =>
  NodeFSP.realpath(NodePath.dirname(absolutePath)).then(
    (folder) => NodePath.join(folder, NodePath.basename(absolutePath)).toLowerCase(),
    () => null,
  );

const statSignature = (absolutePath: string): Promise<string | null> =>
  NodeFSP.stat(absolutePath).then(
    (stat) => `${stat.size}:${stat.mtimeMs}:${stat.ino}`,
    () => null,
  );

function isSheetPath(relativePath: string): boolean {
  return (
    relativePath.toLowerCase().endsWith(SHEET_ARTIFACT_SUFFIX) && !NodePath.isAbsolute(relativePath)
  );
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
    /** Write what an open session holds to the file now, so a read of the file is current. */
    readonly settle: (input: {
      readonly workspaceRoot: string;
      readonly name: string;
    }) => Effect.Effect<void>;
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
  ) {
    const summary = summarizeSheetChange(before, after);
    if (summary.cells === 0 && !summary.layout) return undefined;
    session.counter += 1;
    const entry: DocumentSessionActivity = {
      id: session.counter,
      at: DateTime.formatIso(yield* DateTime.now),
      by,
      cells: summary.cells,
      layout: summary.layout,
      ...(summary.first === undefined ? {} : { first: summary.first.slice(0, 120) }),
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

  /** Bring a change made to the file from outside into the merge document. */
  const takeFile = Effect.fn("DocumentSession.takeFile")(function* (session: Session) {
    if (session.closed) return;
    const exists = yield* Effect.promise(() => statSignature(session.absolutePath));
    if (exists === null) {
      // The document is gone, and its merge state goes with it.
      yield* Effect.promise(() => removeSheetSidecar(session.sidecarPath).catch(() => undefined));
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
    session.dirty = !mine.ok || sheetContentRevision(mine.text) !== session.fileRevision;
    if (updates.length === 0) return;
    session.pending.push(...updates);
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
  });

  const saveSidecar = Effect.fn("DocumentSession.saveSidecar")(function* (session: Session) {
    // Nothing merged, nothing to keep: opening a sheet leaves no trace beside it.
    if (session.pending.length === 0) return;
    const compact =
      session.sidecarLines === 0 ||
      session.sidecarLines + session.pending.length > SHEET_SIDECAR_MAX_LINES ||
      session.sidecarBytes > SHEET_SIDECAR_MAX_BYTES;
    if (compact) {
      const text = compactSheetSidecar(session.epoch, session.doc);
      session.counter += 1;
      const written = yield* Effect.promise(() =>
        writeSheetSidecar(session.sidecarPath, text, `.tmp-${session.epoch}-${session.counter}`),
      );
      if (written) {
        session.sidecarLines = 2;
        session.sidecarBytes = text.length;
        session.pending = [];
      }
      return;
    }
    const text = session.pending.map(sheetSidecarLine).join("");
    if (yield* Effect.promise(() => appendSheetSidecar(session.sidecarPath, text))) {
      session.sidecarLines += session.pending.length;
      session.sidecarBytes += text.length;
      session.pending = [];
    }
  });

  /** Write the merged sheet to the file. False when it could not be written; it stays to be written. */
  const flush = Effect.fn("DocumentSession.flush")(function* (session: Session) {
    for (
      let attempt = 0;
      attempt < WRITE_ATTEMPTS && session.dirty && !session.closed;
      attempt += 1
    ) {
      const next = sheetFileText(readSheetYDoc(session.doc, session.saved));
      if (!next.ok) return false;
      const revision = sheetContentRevision(next.text);
      if (revision !== session.fileRevision) {
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
      }
      session.fileRevision = revision;
      session.saved = { document: next.document, tabIds: readSheetYDoc(session.doc).tabIds };
      session.current = session.saved;
      session.dirty = false;
      session.fileStat =
        (yield* Effect.promise(() => statSignature(session.absolutePath))) ?? session.fileStat;
    }
    if (!session.dirty && !session.closed) yield* saveSidecar(session);
    return !session.dirty;
  });

  const locked = <A, E>(session: Session, effect: Effect.Effect<A, E>) =>
    session.lock.withPermits(1)(effect);

  const scheduleFlush = (session: Session) =>
    Effect.gen(function* () {
      if (session.flushScheduled || session.closed) return;
      session.flushScheduled = true;
      yield* Effect.sleep(FLUSH_DELAY_MS).pipe(
        Effect.andThen(
          locked(
            session,
            Effect.suspend(() => {
              session.flushScheduled = false;
              return flush(session);
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

  const start = Effect.fn("DocumentSession.start")(function* (target: Target) {
    if (!isSheetPath(target.relativePath)) {
      return yield* refuse(
        "not_found",
        "Only a sheet in the project folder opens for live editing.",
      );
    }
    const read = yield* readFile(target);
    if (read === null) return yield* refuse("not_found", "The sheet could not be read.");
    if (!read.ok) return yield* refuse("not_found", `The file is not a valid sheet: ${read.error}`);
    const absolutePath = NodePath.resolve(target.cwd, target.relativePath);
    const key = yield* Effect.promise(() => fileIdentity(absolutePath));
    if (key === null) return yield* refuse("not_found", "The sheet could not be read.");
    const existing = sessions.get(key);
    if (existing !== undefined && !existing.closed) return existing;
    const sidecarPath = sheetSidecarPath(absolutePath);
    const sidecarText = yield* Effect.promise(() => readSheetSidecar(sidecarPath));
    epochs += 1;
    const now = DateTime.toEpochMillis(yield* DateTime.now);
    const loaded = loadSheet(read.file.document, sidecarText, `e${now.toString(36)}-${epochs}`);
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
      dirty: false,
      // A restored log is rewritten once something merges, so it holds the reconciled state.
      pending: [],
      sidecarLines: loaded.restored ? loaded.sidecarLines : 0,
      sidecarBytes: loaded.restored ? (sidecarText?.length ?? 0) : 0,
      activity: [],
      counter: 0,
      flushScheduled: false,
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
              });
              send(session, { type: "presence", participants: participantsOf(session) }, queue);
              return { session, subscriber };
            }),
          );
        const joined = yield* registryLock.withPermits(1)(
          Effect.gen(function* () {
            for (let attempt = 0; attempt < 3; attempt += 1) {
              const entered = yield* join(yield* start(input));
              if (entered !== null) return entered;
            }
            return yield* refuse("failed", "The sheet could not be opened. Try again.");
          }),
        );
        return Stream.fromQueue(queue).pipe(
          Stream.ensuring(leave(joined.session, joined.subscriber)),
        );
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
          const trialSnapshot = readSheetYDoc(trial, session.saved);
          const checked = sheetFileText(trialSnapshot);
          if (!checked.ok) return yield* refuse("refused", checked.error);
          const before = session.current;
          applySheetUpdate(session.doc, bytes, WINDOW_ORIGIN);
          session.current = { document: checked.document, tabIds: trialSnapshot.tabIds };
          session.pending.push(bytes);
          session.dirty = true;
          const { id, color } = subscriber.participant;
          const entry = yield* record(
            session,
            { id, kind: "window", color },
            before.document,
            checked.document,
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

  const writeSheet: DocumentSession["Service"]["writeSheet"] = (input) =>
    Effect.gen(function* () {
      if (sessions.size === 0) return Option.none();
      const title = (input.sheet as { title?: unknown } | null)?.title;
      const name =
        input.name ??
        (typeof title === "string" && title.trim().length > 0 ? sheetSlug(title) : null);
      const absolutePath = name === null ? null : artifactPath(input.workspaceRoot, name);
      if (absolutePath === null) return Option.none();
      const session = yield* find(absolutePath);
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
          const checked = validateSheetDocument(
            input.merge === true ? mergeSheetInput(before.document, input.sheet) : input.sheet,
          );
          if (!checked.ok) return yield* invalid(checked.error);
          const size = sheetFileText({ document: checked.document, tabIds: [] });
          if (!size.ok) return yield* invalid(size.error);

          const agentId = `agent:${input.by.id}`.slice(0, 64);
          const written = firstWritten(input.sheet);
          const tabIndex =
            written === null
              ? 0
              : Math.max(
                  0,
                  before.document.tabs.findIndex(
                    (tab) => tab.name.toLowerCase() === written.tab.trim().toLowerCase(),
                  ),
                );
          const place: DocumentSessionPlace | undefined =
            before.tabIds[tabIndex] === undefined
              ? undefined
              : { tab: before.tabIds[tabIndex], cell: (written?.cell ?? "A1").slice(0, 16) };
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

          const updates: Uint8Array[] = [];
          const stop = onSheetUpdate(session.doc, (update) => updates.push(update));
          writeSheetChange(session.doc, before, checked.document, AGENT_ORIGIN);
          stop();
          session.current = readCurrent(session);
          if (updates.length > 0) {
            session.pending.push(...updates);
            session.dirty = true;
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
          const saved = yield* flush(session);
          // The agent stays shown for a moment, so a person sees where it wrote.
          yield* Effect.sleep(AGENT_LINGER_MS).pipe(
            Effect.andThen(
              locked(
                session,
                Effect.sync(() => {
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
      if (sessions.size === 0) return;
      const absolutePath = artifactPath(input.workspaceRoot, input.name);
      const session = absolutePath === null ? undefined : yield* find(absolutePath);
      if (session !== undefined) yield* locked(session, flush(session));
    });

  const settleAll = Effect.suspend(() =>
    Effect.forEach([...sessions.values()], (session) => locked(session, flush(session)), {
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
          if (session.dirty) yield* flush(session);
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
