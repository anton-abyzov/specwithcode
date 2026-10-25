import type { DesignDocument, DesignOperation, DesignReuse } from "@specweave-studio/contracts";
import {
  applyDesignOperations,
  designOperationWrites,
  designWritesOverlap,
} from "@specweave-studio/shared/designOps";
import { designDiff, sameValue } from "./designDiff";

/**
 * One open design: the confirmed server document, the user's pending
 * operations on top of it, undo and redo, and autosave.
 *
 * Every local change is applied optimistically through the shared reducer and
 * saved within `autosaveMs` of the last change. When a newer revision arrives
 * (the agent, another window), pending operations rebase onto it; only a write
 * to the same field of the same node is a conflict, which waits for the user
 * to keep theirs or take the other side's.
 */

export type DesignApplyResponse =
  | { readonly ok: true; readonly document: DesignDocument }
  | { readonly ok: false; readonly reason: "conflict"; readonly currentRevision?: number }
  | {
      readonly ok: false;
      readonly reason: "error";
      readonly detail: string;
      /** The server's error code (`forbidden`, `invalid`), when it sent one. */
      readonly code?: string;
    };

export interface DesignTransport {
  readonly apply: (
    expectedRevision: number,
    operations: readonly DesignOperation[],
  ) => Promise<DesignApplyResponse>;
  readonly get: () => Promise<DesignDocument>;
}

export type DesignChangeSource = "user" | "agent";

interface UndoEntry {
  readonly source: DesignChangeSource;
  undo: readonly DesignOperation[];
  redo: readonly DesignOperation[];
  /**
   * The design system this change switched, when the user picked it here. Undo puts
   * `before` back only while the design still uses `after`, and redo the reverse, so
   * Cmd+Z never overwrites a system someone else chose since.
   */
  system?: DesignSystemSwitch;
  /** Order of creation; entries above `savedSeq` hold edits not yet on the server. */
  readonly seq: number;
}

interface DesignSystemSwitch {
  readonly before: DesignDocument["designSystem"];
  readonly after: DesignDocument["designSystem"];
  /** The reuse record the same pick changed (None clears it), restored under the same rule. */
  readonly reuse?: { readonly before: DesignReuse | null; readonly after: DesignReuse | null };
}

/**
 * Undo covers node and page edits, plus the design system the user picks in this
 * window, in one step with the edits committed with it (setting None bakes token
 * layers to literals, and undo restores both). Comments, sharing, the bound thread,
 * the title and a system set elsewhere are never undone: they may come from another
 * device or person, and Cmd+Z must not reach them.
 */
const UNDOABLE_OPS: ReadonlySet<DesignOperation["op"]> = new Set([
  "add_node",
  "update_node",
  "delete_node",
  "move_node",
  "add_page",
  "update_page",
  "delete_page",
  "move_page",
]);

export function undoableOperations(operations: readonly DesignOperation[]): DesignOperation[] {
  return operations.filter((operation) => UNDOABLE_OPS.has(operation.op));
}

export type DesignCloseOutcome =
  | { readonly kind: "saved" }
  /** Opened again before the final save finished (React StrictMode, a quick return). */
  | { readonly kind: "reopened" }
  | { readonly kind: "conflict"; readonly conflict: DesignConflict }
  | { readonly kind: "error"; readonly detail: string };

export interface DesignConflict {
  /** The newer document from the server. */
  readonly theirs: DesignDocument;
  /** Field keys both sides wrote (`node:<id>:fill`). */
  readonly keys: readonly string[];
}

export type DesignSaveState = "saved" | "pending" | "saving" | "conflict" | "error";

export interface DesignSessionSnapshot {
  /** What the canvas shows: the server document plus pending and preview operations. */
  readonly document: DesignDocument;
  readonly base: DesignDocument;
  readonly saveState: DesignSaveState;
  readonly error: string | null;
  readonly conflict: DesignConflict | null;
  readonly canUndo: boolean;
  readonly canRedo: boolean;
  /** Source of the change the next undo reverts. */
  readonly undoSource: DesignChangeSource | null;
}

export type DesignCommitResult =
  | { readonly ok: true }
  | { readonly ok: false; readonly detail: string; readonly code?: string };

const UNDO_LIMIT = 200;
/** Conflicts `applyAlone` retries against a fresh read before giving up. */
const ALONE_CONFLICT_RETRIES = 3;
/** Conflict retries whose fresh read is no newer than our base, before the session gives up. */
const STALE_CONFLICT_RETRIES = 5;
const CLOSE_STEPS = 20;

function staleConflictDelay(attempt: number) {
  return Math.min(250 * 2 ** attempt, 4000);
}

export class DesignSession {
  private base: DesignDocument;
  private pending: DesignOperation[] = [];
  private inflight: readonly DesignOperation[] | null = null;
  /** A newer server document that arrived while a save was in flight. */
  private deferredRemote: DesignDocument | null = null;
  private preview: readonly DesignOperation[] | null = null;
  private view: DesignDocument;
  private previewView: DesignDocument | null = null;
  private undoStack: UndoEntry[] = [];
  private redoStack: UndoEntry[] = [];
  private conflict: DesignConflict | null = null;
  private error: string | null = null;
  private timer: ReturnType<typeof setTimeout> | null = null;
  private listeners = new Set<() => void>();
  private snapshot: DesignSessionSnapshot;
  /** Closed while no editor shows it; it still finishes saving. */
  private closed = false;
  private inflightDone: Promise<void> | null = null;
  private seq = 0;
  private savedSeq = 0;
  private staleConflicts = 0;

  constructor(
    document: DesignDocument,
    private readonly transport: DesignTransport,
    private readonly autosaveMs = 400,
  ) {
    this.base = document;
    this.view = document;
    this.snapshot = this.makeSnapshot();
  }

  subscribe = (listener: () => void) => {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  };

  getSnapshot = () => this.snapshot;

  get document() {
    return this.snapshot.document;
  }

  /** An editor shows the session again; unsaved edits resume autosave. */
  open() {
    this.closed = false;
    if (this.pending.length > 0 && this.conflict === null && this.inflight === null)
      this.schedule();
  }

  /**
   * The editor went away. Finishes the save in flight, then saves what is
   * left, independent of any component. Resolves once nothing is pending, the
   * session is opened again, or the save cannot finish on its own (a conflict
   * or an error), which the caller must surface.
   */
  async close(): Promise<DesignCloseOutcome> {
    this.closed = true;
    if (this.timer !== null) {
      clearTimeout(this.timer);
      this.timer = null;
    }
    for (let step = 0; step < CLOSE_STEPS; step += 1) {
      if (this.inflightDone !== null) {
        await this.inflightDone;
        continue;
      }
      if (!this.closed) return { kind: "reopened" };
      if (this.conflict !== null) return { kind: "conflict", conflict: this.conflict };
      if (this.pending.length === 0) return { kind: "saved" };
      if (this.error !== null && step > 0) return { kind: "error", detail: this.error };
      if (this.staleConflicts > 0)
        await new Promise((resolve) =>
          setTimeout(resolve, staleConflictDelay(this.staleConflicts)),
        );
      await this.flush(true);
    }
    return { kind: "error", detail: this.error ?? "The design did not finish saving." };
  }

  /** Applies operations now, records one undo step and schedules a save. */
  commit(operations: readonly DesignOperation[]): DesignCommitResult {
    if (operations.length === 0) return { ok: true };
    this.preview = null;
    this.previewView = null;
    const before = this.view;
    const outcome = applyDesignOperations(before, operations);
    if (!outcome.ok) {
      this.emit();
      return { ok: false, detail: outcome.error.detail };
    }
    this.view = outcome.document;
    this.pending.push(...operations);
    const undo = undoableOperations(designDiff(outcome.document, before));
    const reuse = { before: before.reuse ?? null, after: outcome.document.reuse ?? null };
    const system: DesignSystemSwitch | undefined =
      before.designSystem === outcome.document.designSystem
        ? undefined
        : {
            before: before.designSystem,
            after: outcome.document.designSystem,
            ...(sameValue(reuse.before, reuse.after) ? {} : { reuse }),
          };
    if (undo.length > 0 || system !== undefined) {
      this.pushUndo({
        source: "user",
        undo,
        redo: undoableOperations(designDiff(before, outcome.document)),
        ...(system === undefined ? {} : { system }),
      });
      this.redoStack = [];
    }
    this.schedule();
    this.emit();
    return { ok: true };
  }

  /**
   * Saves operations in a write of their own, outside the autosave batch, and
   * reports the server's answer. A refusal (a thread binding this window may
   * not change) stays with the caller and never holds back canvas edits. Waits
   * for a save in flight; unsaved edits rebase onto the result like any newer
   * revision. Not undoable.
   */
  async applyAlone(operations: readonly DesignOperation[]): Promise<DesignCommitResult> {
    if (operations.length === 0) return { ok: true };
    let expected = this.base.revision;
    for (let attempt = 0; ; attempt += 1) {
      while (this.inflightDone !== null) await this.inflightDone;
      expected = Math.max(expected, this.base.revision);
      if (this.timer !== null) {
        clearTimeout(this.timer);
        this.timer = null;
      }
      let finish!: () => void;
      this.inflightDone = new Promise((resolve) => (finish = resolve));
      this.inflight = operations;
      this.emit();
      let response: DesignApplyResponse;
      try {
        response = await this.transport.apply(expected, operations);
      } catch (cause) {
        response = { ok: false, reason: "error", detail: String(cause) };
      }
      this.inflight = null;
      this.inflightDone = null;
      finish();
      if (response.ok) {
        const deferred = this.deferredRemote;
        this.deferredRemote = null;
        this.rebaseOnto(response.document);
        if (deferred !== null) this.rebaseOnto(deferred);
        this.resume();
        return { ok: true };
      }
      if (response.reason === "conflict" && attempt < ALONE_CONFLICT_RETRIES) {
        const latest = response.currentRevision ?? (await this.latestRevision());
        if (latest !== null && latest > expected) {
          expected = latest;
          continue;
        }
      }
      // A remote revision that arrived during the refused write still lands.
      const deferred = this.deferredRemote;
      this.deferredRemote = null;
      if (deferred !== null) this.rebaseOnto(deferred);
      this.resume();
      return response.reason === "conflict"
        ? { ok: false, detail: "The design kept changing. Try again." }
        : {
            ok: false,
            detail: response.detail,
            ...(response.code === undefined ? {} : { code: response.code }),
          };
    }
  }

  private async latestRevision(): Promise<number | null> {
    try {
      return (await this.transport.get()).revision;
    } catch {
      return null;
    }
  }

  /** After a write of its own: unsaved edits go back to autosave. */
  private resume() {
    if (this.pending.length > 0 && this.conflict === null) this.schedule();
    this.emit();
  }

  /** Shows operations without recording or saving them (drag in progress). */
  setPreview(operations: readonly DesignOperation[] | null) {
    this.preview = operations;
    if (operations === null || operations.length === 0) this.previewView = null;
    else {
      const outcome = applyDesignOperations(this.view, operations);
      this.previewView = outcome.ok ? outcome.document : null;
    }
    this.emit();
  }

  undo(): DesignCommitResult {
    return this.step(this.undoStack, this.redoStack, "undo");
  }

  redo(): DesignCommitResult {
    return this.step(this.redoStack, this.undoStack, "redo");
  }

  private step(from: UndoEntry[], to: UndoEntry[], direction: "undo" | "redo"): DesignCommitResult {
    const entry = from.pop();
    if (entry === undefined) return { ok: true };
    const operations = [...(direction === "undo" ? entry.undo : entry.redo)];
    if (entry.system !== undefined) {
      const { before, after, reuse } = entry.system;
      const [expected, next] = direction === "undo" ? [after, before] : [before, after];
      if (this.view.designSystem === expected) {
        operations.push({ op: "set_design_system", systemId: next });
        if (reuse !== undefined) {
          const [had, put] =
            direction === "undo" ? [reuse.after, reuse.before] : [reuse.before, reuse.after];
          if (sameValue(this.view.reuse ?? null, had))
            operations.push({ op: "set_reuse", reuse: put });
        }
      }
    }
    const outcome = applyDesignOperations(this.view, operations);
    if (!outcome.ok) {
      this.emit();
      return { ok: false, detail: `Can't ${direction}: ${outcome.error.detail}` };
    }
    this.view = outcome.document;
    this.pending.push(...operations);
    to.push(entry);
    this.schedule();
    this.emit();
    return { ok: true };
  }

  /** A document from `design.watch` or `design.get`. */
  receive(remote: DesignDocument) {
    if (remote.id !== this.base.id || remote.revision <= this.base.revision) return;
    if (this.inflight !== null) {
      if (this.deferredRemote === null || remote.revision > this.deferredRemote.revision)
        this.deferredRemote = remote;
      return;
    }
    this.rebaseOnto(remote);
  }

  /**
   * Resolves a conflict. Keep mine re-applies every pending edit over theirs;
   * take theirs drops only the pending writes that collide with theirs and
   * re-applies the rest, so unrelated unsaved edits still land.
   */
  resolveConflict(choice: "mine" | "theirs") {
    const conflict = this.conflict;
    if (conflict === null) return;
    this.conflict = null;
    const theirs = conflict.theirs;
    let pending = this.pending;
    if (choice === "theirs") {
      const theirWrites = new Set(designDiff(this.base, theirs).flatMap(designOperationWrites));
      pending = withoutWrites(pending, theirWrites);
      for (const entry of this.undoStack) {
        if (entry.source !== "user" || entry.seq <= this.savedSeq) continue;
        entry.undo = withoutWrites(entry.undo, theirWrites);
        entry.redo = withoutWrites(entry.redo, theirWrites);
      }
      this.recordRemote(this.base, theirs);
    } else {
      this.keepMineUndo(this.base, theirs, conflict.keys);
    }
    this.base = theirs;
    let current = theirs;
    const kept: DesignOperation[] = [];
    for (const operation of pending) {
      const outcome = applyDesignOperations(current, [operation]);
      if (outcome.ok) {
        current = outcome.document;
        kept.push(operation);
      }
    }
    this.pending = kept;
    this.view = current;
    if (kept.length > 0) this.schedule(0);
    this.emit();
  }

  /**
   * Waits for the save in flight, then saves what is pending, so the caller can
   * replace the document (a version restore) on the latest revision. Resolves
   * false while a conflict or a failed save still holds edits back.
   */
  async settle(): Promise<boolean> {
    for (let step = 0; step < CLOSE_STEPS; step += 1) {
      if (this.inflightDone !== null) {
        await this.inflightDone;
        continue;
      }
      if (this.conflict !== null) return false;
      if (this.pending.length === 0) return true;
      await this.flush();
      if (this.error !== null && this.pending.length > 0) return false;
    }
    return false;
  }

  /** Saves pending operations now. */
  async flush(force = false): Promise<void> {
    if (this.timer !== null) {
      clearTimeout(this.timer);
      this.timer = null;
    }
    if (this.inflight !== null || this.conflict !== null) return;
    if (this.pending.length === 0) return;
    if (this.closed && !force) return;
    let finish!: () => void;
    this.inflightDone = new Promise((resolve) => (finish = resolve));
    try {
      await this.save();
    } finally {
      this.inflightDone = null;
      finish();
    }
  }

  private async save(): Promise<void> {
    const batch = this.pending;
    const batchSeq = this.seq;
    this.pending = [];
    this.inflight = batch;
    this.emit();
    let response: DesignApplyResponse;
    try {
      response = await this.transport.apply(this.base.revision, batch);
    } catch (cause) {
      response = { ok: false, reason: "error", detail: String(cause) };
    }
    this.inflight = null;
    if (response.ok) {
      this.error = null;
      this.staleConflicts = 0;
      this.savedSeq = Math.max(this.savedSeq, batchSeq);
      this.base = response.document;
      this.view = this.replay(response.document);
      const deferred = this.deferredRemote;
      this.deferredRemote = null;
      if (deferred !== null && deferred.revision > this.base.revision) this.rebaseOnto(deferred);
      else this.emit();
      if (this.pending.length > 0) this.schedule();
      return;
    }
    // Not saved: put the batch back in front of anything added meanwhile.
    this.pending = [...batch, ...this.pending];
    if (response.reason === "conflict") {
      const deferred = this.deferredRemote;
      this.deferredRemote = null;
      let latest = deferred;
      if (latest === null || latest.revision <= this.base.revision) {
        try {
          latest = await this.transport.get();
        } catch (cause) {
          this.error = String(cause);
          this.emit();
          return;
        }
      }
      if (latest.revision <= this.base.revision) {
        // The server refused our revision but has nothing newer to rebase onto.
        this.staleConflicts += 1;
        if (this.staleConflicts >= STALE_CONFLICT_RETRIES) {
          this.error = `The server keeps refusing changes to revision ${this.base.revision}. Reload the design to keep editing.`;
          this.emit();
          return;
        }
        this.emit();
        this.schedule(staleConflictDelay(this.staleConflicts));
        return;
      }
      this.staleConflicts = 0;
      this.rebaseOnto(latest);
      if (this.conflict === null) this.schedule(0);
      return;
    }
    this.error = response.detail;
    this.emit();
  }

  private replay(document: DesignDocument): DesignDocument {
    if (this.pending.length === 0) return document;
    const outcome = applyDesignOperations(document, this.pending);
    return outcome.ok ? outcome.document : document;
  }

  private rebaseOnto(remote: DesignDocument) {
    if (remote.revision <= this.base.revision) return;
    if (this.pending.length === 0) {
      this.recordRemote(this.base, remote);
      this.base = remote;
      this.view = remote;
      this.emit();
      return;
    }
    const theirWrites = new Set(designDiff(this.base, remote).flatMap(designOperationWrites));
    const overlapping = new Set<string>();
    for (const operation of this.pending) {
      const writes = designOperationWrites(operation);
      if (designWritesOverlap(writes, theirWrites)) for (const key of writes) overlapping.add(key);
    }
    const replayed = applyDesignOperations(remote, this.pending);
    if (overlapping.size > 0 || !replayed.ok) {
      this.conflict = {
        theirs: remote,
        keys: overlapping.size > 0 ? [...overlapping] : ["document"],
      };
      this.emit();
      return;
    }
    this.recordRemote(this.base, remote);
    this.base = remote;
    this.view = replayed.document;
    this.emit();
  }

  /** Agent edits made in this session are undoable like the user's own (node and page edits only). */
  private recordRemote(before: DesignDocument, after: DesignDocument) {
    const undo = undoableOperations(designDiff(after, before));
    if (undo.length === 0) return;
    this.pushUndo({ source: "agent", undo, redo: undoableOperations(designDiff(before, after)) });
  }

  /**
   * After "Keep mine" the agent's change counts as having happened before this
   * session's unsaved edits: its entry goes under them, and those edits now
   * undo to the agent's value instead of the old base. The next Cmd+Z then
   * reverts the user's kept edit to the agent's value, never to a value
   * neither side has.
   */
  private keepMineUndo(before: DesignDocument, theirs: DesignDocument, keys: readonly string[]) {
    const undo = undoableOperations(designDiff(theirs, before));
    const at = this.undoStack.findIndex(
      (entry) => entry.source === "user" && entry.seq > this.savedSeq,
    );
    const insertAt = at === -1 ? this.undoStack.length : at;
    const conflicting = new Set(keys);
    const theirNodes = new Map(
      theirs.pages.flatMap((page) => page.nodes.map((node) => [node.id, node] as const)),
    );
    for (const entry of this.undoStack.slice(insertAt)) {
      if (entry.source !== "user") continue;
      if (entry.system !== undefined && conflicting.has("designSystem"))
        entry.system = { before: theirs.designSystem, after: entry.system.after };
      entry.undo = entry.undo.map((operation) => {
        if (operation.op !== "update_node") return operation;
        const node = theirNodes.get(operation.id) as Record<string, unknown> | undefined;
        if (node === undefined) return operation;
        const patch: Record<string, unknown> = { ...operation.patch };
        for (const key of Object.keys(patch))
          if (conflicting.has(`node:${operation.id}:${key}`)) patch[key] = node[key] ?? null;
        return { ...operation, patch } as DesignOperation;
      });
    }
    if (undo.length === 0) return;
    this.seq += 1;
    this.undoStack.splice(insertAt, 0, {
      source: "agent",
      undo,
      redo: undoableOperations(designDiff(before, theirs)),
      seq: this.savedSeq,
    });
    if (this.undoStack.length > UNDO_LIMIT) this.undoStack.shift();
  }

  private pushUndo(entry: Omit<UndoEntry, "seq">) {
    this.seq += 1;
    this.undoStack.push({ ...entry, seq: this.seq });
    if (this.undoStack.length > UNDO_LIMIT) this.undoStack.shift();
  }

  private schedule(delay = this.autosaveMs) {
    // A closed session saves from close(), never from a timer.
    if (this.closed) return;
    if (this.timer !== null) clearTimeout(this.timer);
    this.timer = setTimeout(() => {
      this.timer = null;
      void this.flush();
    }, delay);
  }

  private saveState(): DesignSaveState {
    if (this.conflict !== null) return "conflict";
    if (this.inflight !== null) return "saving";
    if (this.error !== null) return "error";
    return this.pending.length > 0 ? "pending" : "saved";
  }

  private makeSnapshot(): DesignSessionSnapshot {
    return {
      document: this.previewView ?? this.view,
      base: this.base,
      saveState: this.saveState(),
      error: this.error,
      conflict: this.conflict,
      canUndo: this.undoStack.length > 0,
      canRedo: this.redoStack.length > 0,
      undoSource: this.undoStack.at(-1)?.source ?? null,
    };
  }

  private emit() {
    this.snapshot = this.makeSnapshot();
    for (const listener of this.listeners) listener();
  }
}

/** Operations minus every write that touches `writes`; a field patch keeps its other fields. */
function withoutWrites(
  operations: readonly DesignOperation[],
  writes: ReadonlySet<string>,
): DesignOperation[] {
  const result: DesignOperation[] = [];
  for (const operation of operations) {
    if (operation.op === "update_node" && !writes.has(`node:${operation.id}`)) {
      const patch = Object.fromEntries(
        Object.entries(operation.patch).filter(
          ([key]) => !designWritesOverlap([`node:${operation.id}:${key}`], writes),
        ),
      );
      if (Object.keys(patch).length > 0) result.push({ ...operation, patch } as DesignOperation);
    } else if (!designWritesOverlap(designOperationWrites(operation), writes)) {
      result.push(operation);
    }
  }
  return result;
}
