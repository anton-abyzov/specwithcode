/**
 * Keeps every composer's unsent text and attachments on its host, so a draft
 * survives a crash, a force quit or an update restart and follows the user
 * between the desktop app and the web. Each change is saved shortly after it
 * happens and at once when the window loses focus, hides or closes. The host
 * copy is cleared only once a send is confirmed (see `hold`).
 *
 * This module is the transport-neutral core; `durableComposerDraftBindings`
 * connects it to the composer stores and the host.
 */
import {
  COMPOSER_DRAFT_MAX_ATTACHMENT_BYTES,
  COMPOSER_DRAFT_MAX_ATTACHMENTS,
  type ComposerDraftKey,
  type ComposerDraftPutInput,
  type ComposerDraftPutResult,
  type ComposerDraftRecord,
  type SnapShotSource,
} from "@specweave-studio/contracts";

export interface DurableDraftAttachment {
  readonly id: string;
  readonly type: "image" | "file";
  readonly name: string;
  readonly mimeType: string;
  readonly sizeBytes: number;
  readonly source?: SnapShotSource;
  readonly file: Blob;
}

export interface DurableDraftSnapshot {
  readonly prompt: string;
  readonly attachments: ReadonlyArray<DurableDraftAttachment>;
}

export interface DurableDraftTarget {
  readonly environmentId: string;
  readonly key: ComposerDraftKey;
}

export interface DurableDraftTransport {
  readonly put: (
    environmentId: string,
    input: ComposerDraftPutInput,
  ) => Promise<ComposerDraftPutResult>;
  readonly get: (
    environmentId: string,
    key: ComposerDraftKey,
  ) => Promise<ComposerDraftRecord | null>;
  /**
   * What the host holds, attachment bytes optional (an empty `dataBase64`
   * means left out). Unlike `get` it throws when the host cannot be read, so
   * "no draft" is never mistaken for "could not look". Falls back to `get`.
   */
  readonly peek?: (environmentId: string, key: ComposerDraftKey) => Promise<ComposerDraftRecord | null>;
}

/**
 * When each draft was last edited in this window, and whether that edit left
 * it empty. It survives reloads beside the drafts themselves.
 */
export interface DurableDraftEdit {
  readonly at: number;
  readonly empty: boolean;
}
export interface DurableDraftEditLog {
  readonly read: (key: string) => DurableDraftEdit | undefined;
  readonly write: (key: string, edit: DurableDraftEdit) => void;
}

/**
 * This window's own durable copy of every draft, written on each change
 * before the host has it. It covers the time the host cannot be reached: an
 * update stops the host before the window closes, and a remote host can be
 * offline. An entry is unsynced until the host confirms that exact draft.
 */
export interface DurableDraftJournalEntry {
  readonly key: ComposerDraftKey;
  readonly environmentId: string;
  readonly snapshot: DurableDraftSnapshot;
  readonly editedAt: number;
  readonly synced: boolean;
}
export interface DurableDraftJournal {
  readonly write: (entry: DurableDraftJournalEntry) => Promise<void>;
  readonly read: (key: ComposerDraftKey) => Promise<DurableDraftJournalEntry | undefined>;
  readonly remove: (key: ComposerDraftKey) => Promise<void>;
}

export const EMPTY_DURABLE_DRAFT: DurableDraftSnapshot = { prompt: "", attachments: [] };

export function durableDraftIsEmpty(snapshot: DurableDraftSnapshot): boolean {
  return snapshot.prompt.trim().length === 0 && snapshot.attachments.length === 0;
}

/** The attachments a host keeps: bytes in hand and within the size limit. */
function keepable(snapshot: DurableDraftSnapshot): DurableDraftSnapshot {
  const attachments = snapshot.attachments
    .filter((attachment) => attachment.file.size <= COMPOSER_DRAFT_MAX_ATTACHMENT_BYTES)
    .slice(0, COMPOSER_DRAFT_MAX_ATTACHMENTS);
  return attachments.length === snapshot.attachments.length
    ? snapshot
    : { prompt: snapshot.prompt, attachments };
}

const signatureOf = (snapshot: DurableDraftSnapshot) =>
  JSON.stringify([
    snapshot.prompt,
    snapshot.attachments.map(({ file: _file, ...metadata }) => metadata),
  ]);

async function base64Of(blob: Blob): Promise<string> {
  const bytes = new Uint8Array(await blob.arrayBuffer());
  let binary = "";
  const chunk = 0x8000;
  for (let index = 0; index < bytes.length; index += chunk) {
    binary += String.fromCharCode(...bytes.subarray(index, index + chunk));
  }
  return btoa(binary);
}

function blobFromBase64(dataBase64: string, mimeType: string): Blob {
  const binary = atob(dataBase64);
  const bytes = new Uint8Array(binary.length);
  for (let index = 0; index < binary.length; index += 1) bytes[index] = binary.charCodeAt(index);
  return new Blob([bytes], { type: mimeType });
}

/** A record's text and attachment metadata, for comparing without the bytes. */
function metadataSnapshot(record: ComposerDraftRecord): DurableDraftSnapshot {
  return {
    prompt: record.prompt,
    attachments: record.attachments.map(({ dataBase64: _data, ...attachment }) => ({
      ...attachment,
      file: new Blob([]),
    })),
  };
}

/** The record carries every attachment's bytes (a metadata-only answer leaves them empty). */
function hasBytes(record: ComposerDraftRecord): boolean {
  return record.attachments.every(
    (attachment) => attachment.dataBase64.length > 0 || attachment.sizeBytes === 0,
  );
}

export function snapshotFromRecord(record: ComposerDraftRecord): DurableDraftSnapshot {
  return {
    prompt: record.prompt,
    attachments: record.attachments.map((attachment) => {
      const blob = blobFromBase64(attachment.dataBase64, attachment.mimeType);
      const file =
        typeof File === "function"
          ? new File([blob], attachment.name, { type: attachment.mimeType })
          : blob;
      return {
        id: attachment.id,
        type: attachment.type,
        name: attachment.name,
        mimeType: attachment.mimeType,
        sizeBytes: attachment.sizeBytes,
        ...(attachment.source ? { source: attachment.source } : {}),
        file,
      };
    }),
  };
}

interface KeyState {
  environmentId: string;
  pending: DurableDraftSnapshot | null;
  timer: ReturnType<typeof setTimeout> | null;
  holds: number;
  /** Attachment ids the host holds bytes for. */
  stored: Set<string>;
  /** What the host last confirmed, to skip saves that change nothing. */
  sent: string | null;
  chain: Promise<void>;
  /** Set while a host copy is being applied, so it is not saved straight back. */
  applying: boolean;
  /** The newest snapshot this window journaled, and when it was edited. */
  journaled: { snapshot: DurableDraftSnapshot; editedAt: number } | null;
  journalWrite: Promise<void>;
  retry: ReturnType<typeof setTimeout> | null;
  failures: number;
  /** `pending` came from the journal at launch and still awaits the host's answer. */
  fromJournal: boolean;
  /** The composer shows a journaled copy the host had confirmed; the host may have cleared it since. */
  showsSyncedJournal: boolean;
  /** Counts edits and sends, so a host check that an edit overtook is dropped. */
  generation: number;
  /** A check against the host that is still running. */
  refreshing: Promise<DurableDraftRefresh> | null;
}

/**
 * What a check against the host found: the draft is gone there (sent or
 * cleared in another window), another window changed it, or this window's
 * copy still stands.
 */
export type DurableDraftRefresh = "cleared" | "replaced" | "kept";

export interface DurableDraftSync {
  /** Records an edit and saves it after the debounce. */
  readonly schedule: (target: DurableDraftTarget, snapshot: DurableDraftSnapshot) => void;
  /** Saves every waiting edit now, except drafts held by a send. */
  readonly flush: () => Promise<void>;
  /**
   * Keeps the host copy while a send is in flight: the composer clears at
   * once, but the host forgets the text only after the release, by which
   * point the composer is empty on success or restored on failure.
   */
  readonly hold: (key: ComposerDraftKey) => () => void;
  /**
   * Brings back the host copy when it is newer than this window's (or this
   * window has nothing). `apply` writes it into the composer.
   */
  readonly restore: (input: {
    readonly target: DurableDraftTarget;
    readonly local: () => DurableDraftSnapshot;
    readonly apply: (snapshot: DurableDraftSnapshot) => void;
  }) => Promise<"restored" | "kept" | "none">;
  /**
   * Puts back what this window journaled and the host never confirmed, right
   * away and without the host. `restore` reconciles with the host afterwards.
   */
  readonly restoreLocal: (input: {
    readonly target: DurableDraftTarget;
    readonly local: () => DurableDraftSnapshot;
    readonly apply: (snapshot: DurableDraftSnapshot) => void;
  }) => Promise<"restored" | "kept" | "none">;
  /** Resolves when every journal write so far is on disk. */
  readonly journalSettled: () => Promise<void>;
  /** Applies a host copy without saving it straight back. */
  readonly applying: <T>(key: ComposerDraftKey, run: () => T) => T;
  readonly isApplying: (key: string) => boolean;
  /**
   * Checks a composer that shows the host's copy against the host again:
   * when another window sent or cleared it the composer empties, and when
   * another window changed it the composer takes the new copy. A composer
   * with an unsaved edit of its own is left alone.
   */
  readonly refresh: (input: {
    readonly target: DurableDraftTarget;
    readonly local: () => DurableDraftSnapshot;
    readonly apply: (snapshot: DurableDraftSnapshot) => void;
  }) => Promise<DurableDraftRefresh>;
  /**
   * Run before a send: true when the composer held a copy that another
   * window already sent or changed, so this send must not go out. A host
   * that cannot be reached does not stop the send.
   */
  readonly sentElsewhere: (input: {
    readonly target: DurableDraftTarget;
    readonly local: () => DurableDraftSnapshot;
    readonly apply: (snapshot: DurableDraftSnapshot) => void;
  }) => Promise<boolean>;
}

export function createDurableDraftSync(options: {
  readonly transport: DurableDraftTransport;
  readonly edits: DurableDraftEditLog;
  readonly debounceMs?: number;
  readonly holdTimeoutMs?: number;
  readonly journal?: DurableDraftJournal | undefined;
  /** Waits between retries of a save the host refused or never answered. */
  readonly retryDelaysMs?: ReadonlyArray<number>;
  readonly now?: () => number;
  readonly onError?: (error: unknown) => void;
}): DurableDraftSync {
  const debounceMs = options.debounceMs ?? 300;
  // Outlasts a send retried across an update restart (up to 3 minutes).
  const holdTimeoutMs = options.holdTimeoutMs ?? 10 * 60_000;
  const now = options.now ?? Date.now;
  const retryDelays = options.retryDelaysMs ?? [1_000, 2_000, 5_000, 10_000, 30_000];
  const journal = options.journal;
  const keys = new Map<string, KeyState>();

  const stateFor = (key: string, environmentId: string): KeyState => {
    let state = keys.get(key);
    if (!state) {
      state = {
        environmentId,
        pending: null,
        timer: null,
        holds: 0,
        stored: new Set(),
        sent: null,
        chain: Promise.resolve(),
        applying: false,
        journaled: null,
        journalWrite: Promise.resolve(),
        retry: null,
        failures: 0,
        fromJournal: false,
        showsSyncedJournal: false,
        generation: 0,
        refreshing: null,
      };
      keys.set(key, state);
    }
    state.environmentId = environmentId;
    return state;
  };

  /** Journals the snapshot; writes run in order, so the newest one lands last. */
  const journalWrite = (
    key: ComposerDraftKey,
    state: KeyState,
    snapshot: DurableDraftSnapshot,
    editedAt: number,
    synced: boolean,
  ) => {
    if (!journal) return;
    state.journaled = { snapshot, editedAt };
    const entry: DurableDraftJournalEntry = {
      key,
      environmentId: state.environmentId,
      snapshot,
      editedAt,
      synced,
    };
    state.journalWrite = state.journalWrite
      .then(() =>
        synced && durableDraftIsEmpty(snapshot) ? journal.remove(key) : journal.write(entry),
      )
      .catch((error: unknown) => options.onError?.(error));
  };

  /** Marks the journal synced once the host holds exactly what it journaled. */
  const confirmJournal = (key: ComposerDraftKey, state: KeyState, signature: string) => {
    const journaled = state.journaled;
    if (!journaled || signatureOf(journaled.snapshot) !== signature) return;
    journalWrite(key, state, journaled.snapshot, journaled.editedAt, true);
  };

  const scheduleRetry = (key: ComposerDraftKey, state: KeyState) => {
    if (state.retry !== null) return;
    const delay = retryDelays[Math.min(state.failures - 1, retryDelays.length - 1)] ?? 30_000;
    state.retry = setTimeout(() => {
      state.retry = null;
      void drain(key, state);
    }, delay);
  };

  const send = async (key: ComposerDraftKey, state: KeyState, snapshot: DurableDraftSnapshot) => {
    const signature = signatureOf(snapshot);
    if (signature === state.sent) {
      confirmJournal(key, state, signature);
      return;
    }
    const editedAt = options.edits.read(key)?.at ?? now();
    const build = async (resend: ReadonlySet<string>): Promise<ComposerDraftPutInput> => ({
      key,
      prompt: snapshot.prompt,
      editedAt,
      attachments: await Promise.all(
        snapshot.attachments.map(async (attachment) => ({
          id: attachment.id,
          type: attachment.type,
          name: attachment.name,
          mimeType: attachment.mimeType,
          sizeBytes: attachment.sizeBytes,
          ...(attachment.source ? { source: attachment.source } : {}),
          ...(state.stored.has(attachment.id) && !resend.has(attachment.id)
            ? {}
            : { dataBase64: await base64Of(attachment.file) }),
        })),
      ),
    });
    let result = await options.transport.put(state.environmentId, await build(new Set()));
    if (result.missingAttachmentIds.length > 0) {
      result = await options.transport.put(
        state.environmentId,
        await build(new Set(result.missingAttachmentIds)),
      );
    }
    state.stored = new Set(snapshot.attachments.map((attachment) => attachment.id));
    for (const id of result.missingAttachmentIds) state.stored.delete(id);
    state.sent = signature;
    if (result.missingAttachmentIds.length === 0) confirmJournal(key, state, signature);
  };

  const drain = (key: ComposerDraftKey, state: KeyState) => {
    if (state.timer !== null) {
      clearTimeout(state.timer);
      state.timer = null;
    }
    if (state.holds > 0 || state.pending === null) return state.chain;
    const snapshot = state.pending;
    state.pending = null;
    state.chain = state.chain
      .then(() => send(key, state, snapshot))
      .then(() => {
        state.failures = 0;
      })
      .catch((error: unknown) => {
        // A failed save stays waiting (the journal still has it) and is tried
        // again on the next edit, flush or retry: the host may be restarting.
        state.pending ??= snapshot;
        state.failures += 1;
        if (state.failures === 1) options.onError?.(error);
        scheduleRetry(key, state);
      });
    return state.chain;
  };

  const schedule: DurableDraftSync["schedule"] = (target, snapshot) => {
    const state = stateFor(target.key, target.environmentId);
    if (state.applying) return;
    state.generation += 1;
    const next = keepable(snapshot);
    const signature = signatureOf(next);
    if (state.pending === null && signature === state.sent) return;
    if (state.pending !== null && signatureOf(state.pending) === signature) return;
    // A send's clearing is not an edit: should the window die before the send
    // is confirmed, the host copy must still come back.
    if (state.holds === 0) {
      const at = now();
      options.edits.write(target.key, { at, empty: durableDraftIsEmpty(next) });
      // Every change reaches this window's disk at once, host or not.
      journalWrite(target.key, state, next, at, false);
      state.showsSyncedJournal = false;
    }
    state.pending = next;
    // A fresh edit outranks whatever another window saved meanwhile.
    state.fromJournal = false;
    if (state.timer !== null) clearTimeout(state.timer);
    state.timer = setTimeout(() => void drain(target.key, state), debounceMs);
  };

  const flush = async () => {
    await Promise.all([...keys].map(([key, state]) => drain(key as ComposerDraftKey, state)));
  };

  const hold: DurableDraftSync["hold"] = (key) => {
    const state = stateFor(key, keys.get(key)?.environmentId ?? "");
    state.holds += 1;
    state.generation += 1;
    let released = false;
    const release = () => {
      if (released) return;
      released = true;
      clearTimeout(expiry);
      state.holds -= 1;
      if (state.holds === 0 && state.pending !== null) {
        // The send settled: what the composer holds now (empty, or the
        // restored text after a failure) becomes the draft.
        const at = now();
        options.edits.write(key, { at, empty: durableDraftIsEmpty(state.pending) });
        journalWrite(key, state, state.pending, at, false);
      }
      if (state.environmentId) void drain(key, state);
    };
    // A send that never settles must not stop this draft from saving.
    const expiry = setTimeout(release, holdTimeoutMs);
    return release;
  };

  const applying: DurableDraftSync["applying"] = (key, run) => {
    const state = keys.get(key);
    if (!state) return run();
    const was = state.applying;
    state.applying = true;
    try {
      return run();
    } finally {
      state.applying = was;
    }
  };

  const applySnapshot = (
    key: ComposerDraftKey,
    state: KeyState,
    snapshot: DurableDraftSnapshot,
    apply: (snapshot: DurableDraftSnapshot) => void,
  ) => {
    state.applying = true;
    try {
      apply(snapshot);
    } finally {
      state.applying = false;
    }
  };

  const restoreLocal: DurableDraftSync["restoreLocal"] = async ({ target, local, apply }) => {
    if (!journal) return "none";
    const entry = await journal.read(target.key);
    if (!entry) return "none";
    const state = stateFor(target.key, target.environmentId);
    state.journaled ??= { snapshot: entry.snapshot, editedAt: entry.editedAt };
    if (state.pending !== null || state.holds > 0) return "kept";
    const edit = options.edits.read(target.key);
    if (edit !== undefined && edit.at > entry.editedAt) return "kept";
    const current = local();
    const same = signatureOf(keepable(current)) === signatureOf(entry.snapshot);
    if (!durableDraftIsEmpty(entry.snapshot)) {
      if (!same) applySnapshot(target.key, state, entry.snapshot, apply);
      // A copy the host had confirmed may have been sent elsewhere since.
      state.showsSyncedJournal = entry.synced;
    }
    options.edits.write(target.key, {
      at: entry.editedAt,
      empty: durableDraftIsEmpty(entry.snapshot),
    });
    if (!entry.synced) {
      // The host never confirmed it; `restore` sends it unless the host has
      // a newer edit from another window.
      state.pending = entry.snapshot;
      state.fromJournal = true;
    }
    return same || durableDraftIsEmpty(entry.snapshot) ? "kept" : "restored";
  };

  const restore: DurableDraftSync["restore"] = async ({ target, local, apply }) => {
    const record = await options.transport.get(target.environmentId, target.key);
    const state = stateFor(target.key, target.environmentId);
    if (state.fromJournal) {
      state.fromJournal = false;
      const journaledAt = state.journaled?.editedAt ?? 0;
      if (record !== null && record.editedAt > journaledAt && state.pending !== null) {
        // Another window edited this draft after this one last saved.
        state.pending = null;
      } else {
        void drain(target.key, state);
        return record === null ? "none" : "kept";
      }
    }
    const showedHostCopy = showsHostCopy(state, local());
    state.showsSyncedJournal = false;
    if (record === null) {
      // Sent or cleared in another window after this one last saw it.
      if (showedHostCopy) clearToHost(target.key, state, apply);
      return "none";
    }
    // An edit made while the host answered wins over what the host had.
    if (state.pending !== null || state.holds > 0) return "kept";
    const current = local();
    const edit = options.edits.read(target.key);
    // An empty composer brings the host copy back unless this window emptied
    // it on purpose after the host saved. A composer that lost its text in a
    // crash has a non-empty last edit, so it restores.
    const localIsNewer = edit !== undefined && edit.at > record.editedAt;
    const keepLocal = durableDraftIsEmpty(current)
      ? localIsNewer && edit?.empty === true
      : localIsNewer;
    if (keepLocal) {
      const mine = keepable(current);
      if (signatureOf(mine) !== signatureOf(snapshotFromRecord(record))) {
        // This window has the newer edit; make sure the host gets it.
        state.stored = new Set(record.attachments.map((attachment) => attachment.id));
        state.pending = mine;
        void drain(target.key, state);
      }
      return "kept";
    }
    const snapshot = snapshotFromRecord(record);
    state.stored = new Set(record.attachments.map((attachment) => attachment.id));
    state.sent = signatureOf(snapshot);
    options.edits.write(target.key, { at: record.editedAt, empty: durableDraftIsEmpty(snapshot) });
    journalWrite(target.key, state, snapshot, record.editedAt, true);
    applySnapshot(target.key, state, snapshot, apply);
    return "restored";
  };

  /**
   * The composer shows exactly what the host last held for it, with no edit
   * of its own waiting: the host's state decides what it should show.
   */
  function showsHostCopy(state: KeyState, current: DurableDraftSnapshot): boolean {
    if (state.pending !== null || state.holds > 0 || durableDraftIsEmpty(current)) return false;
    if (state.showsSyncedJournal) return true;
    return state.sent !== null && signatureOf(keepable(current)) === state.sent;
  }

  function clearToHost(
    key: ComposerDraftKey,
    state: KeyState,
    apply: (snapshot: DurableDraftSnapshot) => void,
  ) {
    state.sent = signatureOf(EMPTY_DURABLE_DRAFT);
    state.stored = new Set();
    state.showsSyncedJournal = false;
    journalWrite(key, state, EMPTY_DURABLE_DRAFT, now(), true);
    applySnapshot(key, state, EMPTY_DURABLE_DRAFT, apply);
  }

  const check = async (
    key: ComposerDraftKey,
    state: KeyState,
    input: Parameters<DurableDraftSync["refresh"]>[0],
  ): Promise<DurableDraftRefresh> => {
    const environmentId = input.target.environmentId;
    const generation = state.generation;
    // An edit or send that started while the host answered wins, saved or not.
    const overtaken = () =>
      state.generation !== generation || !showsHostCopy(state, input.local());
    const peek = options.transport.peek ?? options.transport.get;
    let record = await peek(environmentId, key);
    if (overtaken()) return "kept";
    if (record === null) {
      clearToHost(key, state, input.apply);
      return "cleared";
    }
    const metadata = metadataSnapshot(record);
    if (signatureOf(metadata) === signatureOf(keepable(input.local()))) return "kept";
    const edit = options.edits.read(key);
    if (edit !== undefined && edit.at > record.editedAt) return "kept";
    if (!hasBytes(record)) {
      // Another window changed it: now fetch the bytes.
      record = await options.transport.get(environmentId, key);
      if (overtaken()) return "kept";
      if (record === null) {
        clearToHost(key, state, input.apply);
        return "cleared";
      }
    }
    const snapshot = snapshotFromRecord(record);
    state.stored = new Set(record.attachments.map((attachment) => attachment.id));
    state.sent = signatureOf(snapshot);
    state.showsSyncedJournal = false;
    options.edits.write(key, { at: record.editedAt, empty: durableDraftIsEmpty(snapshot) });
    journalWrite(key, state, snapshot, record.editedAt, true);
    applySnapshot(key, state, snapshot, input.apply);
    return "replaced";
  };

  const refresh: DurableDraftSync["refresh"] = (input) => {
    const key = input.target.key;
    const state = keys.get(key);
    if (!state || !showsHostCopy(state, input.local())) return Promise.resolve("kept");
    if (state.refreshing) return state.refreshing;
    const running = check(key, state, input).finally(() => {
      if (state.refreshing === running) state.refreshing = null;
    });
    state.refreshing = running;
    return running;
  };

  const sentElsewhere: DurableDraftSync["sentElsewhere"] = async (input) => {
    try {
      // Any draft the host has confirmed, typed here or not, may have been
      // sent from another window since: ask the host (without the bytes).
      return (await refresh(input)) !== "kept";
    } catch (error) {
      options.onError?.(error);
      return false;
    }
  };

  return {
    schedule,
    flush,
    hold,
    restore,
    restoreLocal,
    journalSettled: async () => {
      await Promise.all([...keys.values()].map((state) => state.journalWrite));
    },
    applying,
    isApplying: (key) => keys.get(key)?.applying === true,
    refresh,
    sentElsewhere,
  };
}
