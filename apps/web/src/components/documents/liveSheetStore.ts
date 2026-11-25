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
  createSheetUndo,
  createSheetYDoc,
  encodeSheetMissing,
  onSheetUpdate,
  readSheetYDoc,
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
  readonly #listeners = new Set<() => void>();
  readonly #transport: LiveSheetTransport;
  readonly #messages: { readonly viewOnly: string; readonly refused: string };

  constructor(
    transport: LiveSheetTransport,
    messages: { readonly viewOnly: string; readonly refused: string },
  ) {
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
    if (checked.ok) this.#snapshot = { document: checked.document, tabIds: snapshot.tabIds };
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
    this.#undo = createSheetUndo(doc, LOCAL);
    // Whatever this window writes (an edit, an undo) goes to the home machine.
    this.#stop = onSheetUpdate(doc, (update, origin) => {
      if (origin !== REMOTE) this.#send(update);
    });
  }

  #send(update: Uint8Array): void {
    void this.#transport.update(sheetUpdateToBase64(update)).then(
      (result) => {
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
    const bytes = sheetUpdateFromBase64(event.update);
    if (event.type === "snapshot") {
      if (bytes === null) return;
      const fresh = this.#doc === null || this.#epoch !== event.epoch || this.#discard;
      if (fresh) {
        const doc = createSheetYDoc();
        applySheetUpdate(doc, bytes, REMOTE);
        this.#adopt(doc, event.epoch);
      } else {
        // The same log after a reconnect: merge, then send what the home machine lacks.
        applySheetUpdate(this.#doc!, bytes, REMOTE);
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
    this.#set({
      ...(event.activity === undefined
        ? {}
        : { activity: [...this.#state.activity, event.activity].slice(-ACTIVITY_SHOWN) }),
      ...this.#read(),
    });
  }

  get editable(): boolean {
    return this.#state.status === "live" && this.#state.access === "edit";
  }

  /**
   * Make an edit: the sheet as it should read now. False, with the reason in
   * `problem`, when this window may not edit or the sheet would be invalid.
   */
  commit(next: SheetDocument): boolean {
    const doc = this.#doc;
    const before = this.#snapshot;
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
    this.#listeners.clear();
  }
}
