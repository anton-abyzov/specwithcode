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
import {
  SHEET_LIMITS,
  type SheetDocument,
  type SheetTab,
  validateSheetDocument,
} from "@specweave-studio/shared/officeSheet";
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
  /** The same, where the edits were to a tab the file no longer has and are kept in a new tab. */
  readonly recovered: string;
  /** The word a tab kept that way carries after its name, as in "Plan (recovered)". */
  readonly recoveredTab: string;
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
  /**
   * The sheet as this window had it, when the home machine started over and
   * some of this window's edits could not be made again: kept so they can
   * still be saved somewhere.
   */
  readonly draft: SheetDocument | null;
}

const sameTab = (left: SheetTab, right: SheetTab): boolean =>
  JSON.stringify(left) === JSON.stringify(right);

/**
 * Make a window's unconfirmed edits again on a document the home machine
 * started over: the change from `base` (the sheet as the home machine last
 * sent it) to `mine` (what the window shows), on top of what `doc` holds.
 * What others changed is in both, so it is not made again.
 *
 * Edits to a tab `doc` does not have (renamed or removed in the file) cannot
 * be made there. With `recover` the tab as the window shows it is added as a
 * tab of this window's own, under its name and that word ("Plan (recovered)");
 * without, those edits are left out and "missing" says so.
 */
function remakeSheetEdits(
  doc: SheetYDoc,
  base: SheetSnapshot,
  mine: SheetSnapshot,
  recover: string | null,
): "made" | "recovered" | "missing" {
  const from = sheetSnapshotByName(doc, base.document);
  writeSheetChange(doc, from, mine.document, LOCAL);
  const now = readSheetYDoc(doc);
  const held = new Set(now.tabIds);
  const gone: SheetTab[] = [];
  base.document.tabs.forEach((tab, index) => {
    if (held.has(from.tabIds[index]!)) return;
    // The same tab in the window, by the id both had before; removed there, nothing is kept.
    const shown = mine.document.tabs[mine.tabIds.indexOf(base.tabIds[index]!)];
    if (shown !== undefined && !sameTab(shown, tab)) gone.push(shown);
  });
  if (gone.length === 0) return "made";
  if (recover === null) return "missing";
  const tabs = [...now.document.tabs];
  const names = new Set(tabs.map((tab) => tab.name.trim().toLowerCase()));
  for (const tab of gone) {
    let name = "";
    for (let count = 1; name === "" || names.has(name.trim().toLowerCase()); count += 1) {
      const suffix = count === 1 ? ` (${recover})` : ` (${recover} ${count})`;
      name = `${tab.name.slice(0, Math.max(1, SHEET_LIMITS.tabNameChars - suffix.length))}${suffix}`;
    }
    names.add(name.trim().toLowerCase());
    tabs.push({ ...tab, name });
  }
  writeSheetChange(doc, now, { ...now.document, tabs }, LOCAL);
  return "recovered";
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
  draft: null,
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
   * A change the home machine sends is one it has kept, in its log or the file.
   */
  #home: SheetYDoc | null = null;
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
      this.#set({ unsaved: event.saved ? null : (event.detail ?? "") });
      return;
    }
    const bytes = sheetUpdateFromBase64(event.update);
    if (event.type === "snapshot") {
      if (bytes === null) return;
      const fresh = this.#doc === null || this.#epoch !== event.epoch || this.#discard;
      // The home machine began again from the file (a restart): an edit still on its way is not in it.
      const lost =
        this.#doc !== null &&
        this.#epoch !== event.epoch &&
        (this.#unsent > 0 || this.#undelivered);
      this.#undelivered = false;
      if (fresh) {
        const mine = this.#snapshot;
        const base = this.#home === null ? null : readSheetYDoc(this.#home);
        const doc = createSheetYDoc();
        applySheetUpdate(doc, bytes, REMOTE);
        this.#home = createSheetYDoc();
        applySheetUpdate(this.#home, bytes, REMOTE);
        this.#adopt(doc, event.epoch);
        this.#unsent = 0;
        // What this window changed and the home machine never got is made again on the new sheet.
        const remade = lost ? this.#remake(doc, base, mine, event.access) : "made";
        if (remade !== "made") {
          this.#state = {
            ...this.#state,
            problem: remade === "recovered" ? this.#messages.recovered : this.#messages.reloaded,
            // Not made again: the window's own sheet is kept, to be saved as a file of its own.
            ...(remade === "missing" && mine !== null ? { draft: mine.document } : {}),
          };
        }
      } else {
        // The same log after a reconnect: merge, then send what the home machine lacks.
        applySheetUpdate(this.#doc!, bytes, REMOTE);
        if (this.#home !== null) applySheetUpdate(this.#home, bytes, REMOTE);
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
    if (this.#home !== null) applySheetUpdate(this.#home, bytes, REMOTE);
    this.#set({
      ...(event.activity === undefined
        ? {}
        : { activity: [...this.#state.activity, event.activity].slice(-ACTIVITY_SHOWN) }),
      ...this.#read(),
    });
  }

  /**
   * Make this window's unconfirmed edits again on a document the home machine
   * started over. Tried on a copy first: edits that no longer fit the sheet
   * are not made at all, and a tab that cannot be kept beside the others is
   * left out.
   */
  #remake(
    doc: SheetYDoc,
    base: SheetSnapshot | null,
    mine: SheetSnapshot | null,
    access: DocumentSessionAccess,
  ): "made" | "recovered" | "missing" {
    if (base === null || mine === null || access !== "edit") return "missing";
    if (!validateSheetDocument(base.document).ok) return "missing";
    for (const recover of [this.#messages.recoveredTab, null]) {
      const trial = cloneSheetYDoc(doc);
      remakeSheetEdits(trial, base, mine, recover);
      if (validateSheetDocument(readSheetYDoc(trial).document).ok) {
        return remakeSheetEdits(doc, base, mine, recover);
      }
    }
    return "missing";
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

  /** The kept sheet was saved somewhere, or is not wanted. */
  dropDraft(): void {
    if (this.#state.draft !== null) this.#set({ draft: null });
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
