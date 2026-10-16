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
} from "@specweave-studio/contracts";

export interface DurableDraftAttachment {
  readonly id: string;
  readonly type: "image" | "file";
  readonly name: string;
  readonly mimeType: string;
  readonly sizeBytes: number;
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
  JSON.stringify([snapshot.prompt, snapshot.attachments.map((attachment) => attachment.id)]);

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
}

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
  /** Applies a host copy without saving it straight back. */
  readonly applying: <T>(key: ComposerDraftKey, run: () => T) => T;
  readonly isApplying: (key: string) => boolean;
}

export function createDurableDraftSync(options: {
  readonly transport: DurableDraftTransport;
  readonly edits: DurableDraftEditLog;
  readonly debounceMs?: number;
  readonly holdTimeoutMs?: number;
  readonly now?: () => number;
  readonly onError?: (error: unknown) => void;
}): DurableDraftSync {
  const debounceMs = options.debounceMs ?? 300;
  const holdTimeoutMs = options.holdTimeoutMs ?? 120_000;
  const now = options.now ?? Date.now;
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
      };
      keys.set(key, state);
    }
    state.environmentId = environmentId;
    return state;
  };

  const send = async (key: ComposerDraftKey, state: KeyState, snapshot: DurableDraftSnapshot) => {
    const signature = signatureOf(snapshot);
    if (signature === state.sent) return;
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
      .catch((error: unknown) => {
        // A failed save stays waiting; the next edit or flush tries again.
        state.pending ??= snapshot;
        options.onError?.(error);
      });
    return state.chain;
  };

  const schedule: DurableDraftSync["schedule"] = (target, snapshot) => {
    const state = stateFor(target.key, target.environmentId);
    if (state.applying) return;
    const next = keepable(snapshot);
    const signature = signatureOf(next);
    if (state.pending === null && signature === state.sent) return;
    if (state.pending !== null && signatureOf(state.pending) === signature) return;
    // A send's clearing is not an edit: should the window die before the send
    // is confirmed, the host copy must still come back.
    if (state.holds === 0) {
      options.edits.write(target.key, { at: now(), empty: durableDraftIsEmpty(next) });
    }
    state.pending = next;
    if (state.timer !== null) clearTimeout(state.timer);
    state.timer = setTimeout(() => void drain(target.key, state), debounceMs);
  };

  const flush = async () => {
    await Promise.all([...keys].map(([key, state]) => drain(key as ComposerDraftKey, state)));
  };

  const hold: DurableDraftSync["hold"] = (key) => {
    const state = stateFor(key, keys.get(key)?.environmentId ?? "");
    state.holds += 1;
    let released = false;
    const release = () => {
      if (released) return;
      released = true;
      clearTimeout(expiry);
      state.holds -= 1;
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

  const restore: DurableDraftSync["restore"] = async ({ target, local, apply }) => {
    const record = await options.transport.get(target.environmentId, target.key);
    if (record === null) return "none";
    const state = stateFor(target.key, target.environmentId);
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
    state.applying = true;
    try {
      apply(snapshot);
    } finally {
      state.applying = false;
    }
    return "restored";
  };

  return {
    schedule,
    flush,
    hold,
    restore,
    applying,
    isApplying: (key) => keys.get(key)?.applying === true,
  };
}
