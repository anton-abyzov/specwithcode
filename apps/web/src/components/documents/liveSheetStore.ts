/**
 * One window's side of a live sheet: its own merge document, fed by the home
 * machine's events, and the edits this window makes to it.
 *
 * An edit shows at once and is sent as a merge update; what the other windows
 * and agents write arrives the same way and merges in. Nothing here saves a
 * file, so there is no revision to conflict on.
 */
import type {
  DocumentSessionAccess,
  DocumentSessionActivity,
  DocumentSessionEvent,
  DocumentSessionParticipant,
  DocumentSessionPlace,
} from "@specweave-studio/contracts";
import { type SheetDocument, validateSheetDocument } from "@specweave-studio/shared/officeSheet";
import {
  type SheetSnapshot,
  type SheetUndo,
  type SheetYDoc,
  applySheetUpdate,
  cloneSheetYDoc,
  createSheetUndo,
  createSheetYDoc,
  encodeSheetMissing,
  onSheetUpdate,
  readSheetYDoc,
  sheetSnapshotByName,
  sheetStateVectorOf,
  sheetUpdateFromBase64,
  sheetUpdateToBase64,
  writeSheetChange,
} from "@specweave-studio/shared/sheetCollab";

const LOCAL = "local";
const REMOTE = "remote";
const ACTIVITY_SHOWN = 50;

export type LiveSheetSendResult = "merged" | "view_only" | "refused" | "not_open" | "failed";

export interface LiveSheetTransport {
  /** Send one merge update to the home machine. */
  readonly update: (update: string) => Promise<LiveSheetSendResult>;
  /** Say where this window is; null when it is nowhere on the sheet. */
  readonly presence: (place: DocumentSessionPlace | null) => void;
  /** The home machine refused a change this window already shows: start over from its state. */
  readonly restart: () => void;
}

export interface LiveSheetMessages {
  readonly viewOnly: string;
  readonly refused: string;
  /** The home machine started the sheet over from its file while an edit was on its way. */
  readonly reloaded: string;
}

export interface LiveSheetState {
  readonly status: "connecting" | "live" | "closed";
  readonly document: SheetDocument | null;
  readonly tabIds: ReadonlyArray<string>;
  readonly access: DocumentSessionAccess;
  readonly participantId: string | null;
  readonly participants: ReadonlyArray<DocumentSessionParticipant>;
  readonly activity: ReadonlyArray<DocumentSessionActivity>;
  readonly canUndo: boolean;
  readonly canRedo: boolean;
  /** Why the last edit was not taken, or why the session ended. */
  readonly problem: string | null;
  /** Why what everyone sees is not in the file yet; null when the file is current. */
  readonly unsaved: string | null;
}

const INITIAL: LiveSheetState = {
  status: "connecting",
  document: null,
  tabIds: [],
  access: "view",
  participantId: null,
  participants: [],
  activity: [],
  canUndo: false,
  canRedo: false,
  problem: null,
  unsaved: null,
};

export class LiveSheetStore {
  #state: LiveSheetState = INITIAL;
  #doc: SheetYDoc | null = null;
  #epoch: string | null = null;
  #undo: SheetUndo | null = null;
  #stop: (() => void) | null = null;
  #snapshot: SheetSnapshot | null = null;
  #place: string | null = null;
  /** Start from the next snapshot even when it continues the same log. */
  #discard = false;
  /** Edits sent and not yet answered. */
  #unsent = 0;
  /** An edit did not reach the home machine and has not been sent again yet. */
  #undelivered = false;
  /**
   * The sheet as the home machine has sent it: every snapshot and change
   * received, and none of this window's edits until they come back. What this
   * window shows beyond it is exactly what the home machine has not confirmed.
   */
  #home: SheetYDoc | null = null;
  /**
   * Changes received while the home machine said the sheet was not saved.
   * They are kept out of `#home` until it is: if the home machine starts over
   * from the file before then, they are part of what is made again.
   */
  #unsavedAtHome: Uint8Array[] = [];
  /** Each sheet this store has shown, with its tabs' ids: what an edit built on it started from. */
  #shown = new WeakMap<SheetDocument, SheetSnapshot>();
  readonly #listeners = new Set<() => void>();
  readonly #transport: LiveSheetTransport;
  readonly #messages: LiveSheetMessages;

  constructor(transport: LiveSheetTransport, messages: LiveSheetMessages) {
    this.#transport = transport;
    this.#messages = messages;
  }

  readonly getState = (): LiveSheetState => this.#state;

  readonly subscribe = (listener: () => void): (() => void) => {
    this.#listeners.add(listener);
    return () => this.#listeners.delete(listener);
  };

  #set(patch: Partial<LiveSheetState>): void {
    this.#state = { ...this.#state, ...patch };
    for (const listener of this.#listeners) listener();
  }

  /** Read the merge document; a state that is not a valid sheet keeps the last valid one shown. */
  #read(): Pick<LiveSheetState, "document" | "tabIds" | "canUndo" | "canRedo"> {
    const doc = this.#doc;
    if (doc === null) return { document: null, tabIds: [], canUndo: false, canRedo: false };
    const snapshot = readSheetYDoc(doc, this.#snapshot);
    const checked = validateSheetDocument(snapshot.document);
    if (checked.ok) {
      this.#snapshot = { document: checked.document, tabIds: snapshot.tabIds };
      this.#shown.set(checked.document, this.#snapshot);
    }
    return {
      document: this.#snapshot?.document ?? null,
      tabIds: this.#snapshot?.tabIds ?? [],
      canUndo: this.#undo?.canUndo() ?? false,
      canRedo: this.#undo?.canRedo() ?? false,
    };
  }

  #adopt(doc: SheetYDoc, epoch: string): void {
    this.#stop?.();
    this.#undo?.destroy();
    this.#doc = doc;
    this.#epoch = epoch;
    this.#snapshot = null;
    this.#shown = new WeakMap();
    this.#undo = createSheetUndo(doc, LOCAL);
    // Whatever this window writes (an edit, an undo) goes to the home machine.
    this.#stop = onSheetUpdate(doc, (update, origin) => {
      if (origin !== REMOTE) this.#send(update);
    });
  }

  #send(update: Uint8Array): void {
    const doc = this.#doc;
    this.#unsent += 1;
    void this.#transport.update(sheetUpdateToBase64(update)).then(
      (result) => {
        // An answer for a document this window has since replaced counts for nothing.
        if (doc === this.#doc) {
          this.#unsent -= 1;
          if (result === "failed" || result === "not_open") this.#undelivered = true;
        }
        if (result === "merged" || this.#state.status === "closed") return;
        if (result === "failed" || result === "not_open") {
          // Not delivered: the next snapshot brings the two together again.
          this.#transport.restart();
          return;
        }
        // Refused: this window shows a change nobody else has. Start over from the home machine.
        this.#discard = true;
        this.#set({
          problem: result === "view_only" ? this.#messages.viewOnly : this.#messages.refused,
        });
        this.#transport.restart();
      },
      () => this.#transport.restart(),
    );
  }

  /** An event from the home machine. */
  receive(event: DocumentSessionEvent): void {
    if (event.type === "closed") {
      this.#set({ status: "closed", problem: event.reason === "closed" ? null : event.reason });
      return;
    }
    if (event.type === "presence") {
      this.#set({ participants: event.participants });
      return;
    }
    if (event.type === "save") {
      if (event.saved) this.#confirmSaved();
      this.#set({ unsaved: event.saved ? null : (event.detail ?? "") });
      return;
    }
    const bytes = sheetUpdateFromBase64(event.update);
    if (event.type === "snapshot") {
      if (bytes === null) return;
      const fresh = this.#doc === null || this.#epoch !== event.epoch || this.#discard;
      // The home machine began again from the file (a restart): an edit still on its way is not in it.
      // So is one the home machine had merged and said it could not save.
      const lost =
        this.#doc !== null &&
        this.#epoch !== event.epoch &&
        (this.#unsent > 0 || this.#undelivered || this.#unsavedAtHome.length > 0);
      this.#undelivered = false;
      if (fresh) {
        const mine = this.#snapshot?.document ?? null;
        const base = this.#home === null ? null : readSheetYDoc(this.#home).document;
        const doc = createSheetYDoc();
        applySheetUpdate(doc, bytes, REMOTE);
        this.#home = createSheetYDoc();
        applySheetUpdate(this.#home, bytes, REMOTE);
        this.#unsavedAtHome = [];
        this.#adopt(doc, event.epoch);
        this.#unsent = 0;
        // What this window changed and the home machine never got is made again on the new sheet.
        if (lost && !this.#remake(doc, base, mine, event.access)) {
          this.#state = { ...this.#state, problem: this.#messages.reloaded };
        }
      } else {
        // The same log after a reconnect: merge, then send what the home machine lacks.
        applySheetUpdate(this.#doc!, bytes, REMOTE);
        this.#heardFromHome(bytes, event.unsaved !== undefined);
        const missing =
          event.access === "edit"
            ? encodeSheetMissing(this.#doc!, sheetStateVectorOf(bytes))
            : null;
        if (missing !== null) this.#send(missing);
      }
      this.#discard = false;
      this.#set({
        status: "live",
        access: event.access,
        participantId: event.participantId,
        participants: event.participants,
        activity: event.activity,
        unsaved: event.unsaved ?? null,
        ...this.#read(),
      });
      // The home machine does not know where a window that just (re)joined is.
      const place = this.#place;
      this.#place = null;
      if (place !== null) this.setPlace(JSON.parse(place) as DocumentSessionPlace);
      return;
    }
    if (bytes === null || this.#doc === null) return;
    applySheetUpdate(this.#doc, bytes, REMOTE);
    this.#heardFromHome(bytes, this.#state.unsaved !== null);
    this.#set({
      ...(event.activity === undefined
        ? {}
        : { activity: [...this.#state.activity, event.activity].slice(-ACTIVITY_SHOWN) }),
      ...this.#read(),
    });
  }

  /** A change the home machine sent: part of what it has, once it has it saved. */
  #heardFromHome(bytes: Uint8Array, unsaved: boolean): void {
    if (unsaved) this.#unsavedAtHome.push(bytes);
    else if (this.#home !== null) applySheetUpdate(this.#home, bytes, REMOTE);
  }

  /** The home machine saved the sheet: what it sent meanwhile is now part of what it has. */
  #confirmSaved(): void {
    for (const bytes of this.#unsavedAtHome) {
      if (this.#home !== null) applySheetUpdate(this.#home, bytes, REMOTE);
    }
    this.#unsavedAtHome = [];
  }

  /**
   * Make this window's unconfirmed edits again on a document the home machine
   * started over: the change from `base` (the sheet as the home machine last
   * sent it) to `mine` (what this window shows), on top of what the new
   * document holds. What others changed is in both, so it is not made again.
   * False when the edits could not be made.
   */
  #remake(
    doc: SheetYDoc,
    base: SheetDocument | null,
    mine: SheetDocument | null,
    access: DocumentSessionAccess,
  ): boolean {
    if (base === null || mine === null || access !== "edit") return false;
    if (!validateSheetDocument(base).ok) return false;
    // Tried on a copy first: an edit that no longer fits the sheet is not made at all.
    const trial = cloneSheetYDoc(doc);
    writeSheetChange(trial, sheetSnapshotByName(trial, base), mine, LOCAL);
    if (!validateSheetDocument(readSheetYDoc(trial).document).ok) return false;
    const from = sheetSnapshotByName(doc, base);
    writeSheetChange(doc, from, mine, LOCAL);
    // An edit to a tab the new document does not have (renamed or removed in the file) could
    // not be made: the rest was, and the window says that something may be missing.
    const held = new Set(readSheetYDoc(doc).tabIds);
    return base.tabs.every((tab, index) => {
      if (held.has(from.tabIds[index]!)) return true;
      const kept = mine.tabs.find((entry) => entry.name === tab.name);
      return kept !== undefined && JSON.stringify(kept) === JSON.stringify(tab);
    });
  }

  get editable(): boolean {
    return this.#state.status === "live" && this.#state.access === "edit";
  }

  /**
   * Make an edit: the sheet as it should read now. `base` is the sheet the
   * edit was worked out from, when that is not the latest one: only what
   * differs between the two is written, so what others changed in between
   * (while a column was dragged, or a paste was read) stays. False, with the
   * reason in `problem`, when this window may not edit or the sheet would be invalid.
   */
  commit(next: SheetDocument, base?: SheetDocument): boolean {
    const doc = this.#doc;
    const before = (base === undefined ? undefined : this.#shown.get(base)) ?? this.#snapshot;
    if (doc === null || before === null) return false;
    if (!this.editable) {
      this.#set({ problem: this.#messages.viewOnly });
      return false;
    }
    const checked = validateSheetDocument(next);
    if (!checked.ok) {
      this.#set({ problem: checked.error });
      return false;
    }
    writeSheetChange(doc, before, checked.document, LOCAL);
    this.#set({ problem: null, ...this.#read() });
    return true;
  }

  undo(): void {
    if (this.editable && this.#undo?.undo()) this.#set(this.#read());
  }

  redo(): void {
    if (this.editable && this.#undo?.redo()) this.#set(this.#read());
  }

  clearProblem(): void {
    if (this.#state.problem !== null) this.#set({ problem: null });
  }

  /** Tell the others where this window is. Repeats of the same place are not sent. */
  readonly setPlace = (place: DocumentSessionPlace | null): void => {
    const key = place === null ? null : JSON.stringify(place);
    if (key === this.#place) return;
    this.#place = key;
    if (this.#state.status === "live") this.#transport.presence(place);
  };

  dispose(): void {
    this.#stop?.();
    this.#undo?.destroy();
    this.#doc = null;
    this.#home = null;
    this.#listeners.clear();
  }
}
