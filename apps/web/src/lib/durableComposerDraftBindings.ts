/**
 * Connects the durable draft core to this app: the thread and new-chat
 * composers (the composer draft store), the project coordinator's composer,
 * and the host's `composerDrafts.*` methods.
 */
import {
  AuthOrchestrationOperateScope,
  AuthOrchestrationReadScope,
  COMPOSER_DRAFT_KEY_PATTERN,
  WS_METHODS,
  type ComposerDraftKey,
  type EnvironmentId,
} from "@specweave-studio/contracts";
import { parseScopedThreadKey } from "@specweave-studio/client-runtime/environment";
import {
  createEnvironmentRpcCommand,
  runAtomCommand,
  squashAtomCommandFailure,
} from "@specweave-studio/client-runtime/state/runtime";
import * as Option from "effect/Option";
import { AsyncResult } from "effect/reactivity";
import { useEffect } from "react";

import {
  composerTargetKey,
  useComposerDraftStore,
  type ComposerFileAttachment,
  type ComposerImageAttachment,
  type ComposerThreadDraftState,
  type ComposerThreadTarget,
} from "../composerDraftStore";
import { connectionAtomRuntime } from "../connection/runtime";
import { appAtomRegistry } from "../rpc/atomRegistry";
import { environmentCatalog } from "../connection/catalog";
import { environmentSession, readEnvironmentScope } from "../state/session";
import type { ProjectCoordinatorComposer } from "../studio/projectCoordinatorComposer";
import { releaseDraftAttachment, startAttachmentUpload } from "./attachmentUploadQueue";
import { createIndexedDbDraftJournal } from "./durableComposerDraftJournal";
import {
  createDurableDraftSync,
  type DurableDraftAttachment,
  type DurableDraftEdit,
  type DurableDraftSnapshot,
} from "./durableComposerDrafts";

const EDIT_LOG_STORAGE_KEY = "studio:composer-draft-edits:v1";
const EDIT_LOG_MAX_AGE_MS = 60 * 24 * 60 * 60 * 1000;

const commands = {
  get: createEnvironmentRpcCommand(connectionAtomRuntime, {
    label: "composer-drafts:get",
    tag: WS_METHODS.composerDraftsGet,
  }),
  put: createEnvironmentRpcCommand(connectionAtomRuntime, {
    label: "composer-drafts:put",
    tag: WS_METHODS.composerDraftsPut,
  }),
};

type CommandResult<A> = Awaited<ReturnType<typeof runAtomCommand<unknown, A, unknown>>>;

function unwrap<A>(result: CommandResult<A>): A {
  if (result._tag === "Success") return result.value;
  throw squashAtomCommandFailure(result);
}

const quiet = { reportFailure: false, reportDefect: false } as const;

function readEditLog(): Record<string, DurableDraftEdit> {
  try {
    const raw =
      typeof localStorage === "undefined" ? null : localStorage.getItem(EDIT_LOG_STORAGE_KEY);
    const parsed: unknown = raw ? JSON.parse(raw) : {};
    return parsed && typeof parsed === "object" ? (parsed as Record<string, DurableDraftEdit>) : {};
  } catch {
    return {};
  }
}

let editLog: Record<string, DurableDraftEdit> | null = null;

export const durableComposerDrafts = createDurableDraftSync({
  transport: {
    get: async (environmentId, key) => {
      if (!readEnvironmentScope(environmentId as EnvironmentId, AuthOrchestrationReadScope)) {
        return null;
      }
      const result = await runAtomCommand(
        appAtomRegistry,
        commands.get,
        { environmentId: environmentId as EnvironmentId, input: { key } },
        quiet,
      );
      return unwrap(result).draft;
    },
    put: async (environmentId, input) => {
      if (!readEnvironmentScope(environmentId as EnvironmentId, AuthOrchestrationOperateScope)) {
        throw new Error("This window may not save drafts to the host.");
      }
      const result = await runAtomCommand(
        appAtomRegistry,
        commands.put,
        { environmentId: environmentId as EnvironmentId, input },
        quiet,
      );
      return unwrap(result);
    },
  },
  edits: {
    read: (key) => (editLog ??= readEditLog())[key],
    write: (key, edit) => {
      const log = (editLog ??= readEditLog());
      log[key] = edit;
      const oldest = edit.at - EDIT_LOG_MAX_AGE_MS;
      for (const [other, entry] of Object.entries(log)) {
        if (typeof entry?.at !== "number" || entry.at < oldest) delete log[other];
      }
      try {
        localStorage.setItem(EDIT_LOG_STORAGE_KEY, JSON.stringify(log));
      } catch {
        // Storage full or unavailable: the host copy still wins ties.
      }
    },
  },
  journal: createIndexedDbDraftJournal(),
  onError: (error) => console.warn("Could not save the draft to the host.", error),
});

/**
 * Resolves once this window is connected to the host with read access, so a
 * restore right after launch does not run before the session exists.
 */
export function whenHostReady(
  environmentId: string,
  signal: { cancelled: boolean },
): Promise<boolean> {
  const id = environmentId as EnvironmentId;
  const connectionAtom = environmentCatalog.stateAtom(id);
  const sessionAtom = environmentSession.sessionStateAtom(id);
  const ready = () =>
    readEnvironmentScope(id, AuthOrchestrationReadScope) &&
    Option.exists(
      AsyncResult.value(appAtomRegistry.get(connectionAtom)),
      (state) => state.phase === "connected",
    );
  if (ready()) return Promise.resolve(true);
  return new Promise((resolve) => {
    const stops: Array<() => void> = [];
    const finish = (value: boolean) => {
      for (const stop of stops) stop();
      clearTimeout(timer);
      resolve(value);
    };
    const check = () => {
      if (signal.cancelled) finish(false);
      else if (ready()) finish(true);
    };
    const timer = setTimeout(() => finish(false), 120_000);
    stops.push(appAtomRegistry.subscribe(connectionAtom, check));
    stops.push(appAtomRegistry.subscribe(sessionAtom, check));
  });
}

type RestoreInput = Parameters<typeof durableComposerDrafts.restore>[0];

/**
 * Puts back this window's journaled draft at once, then reconciles with the
 * host when it is reachable (a newer edit from another window wins there).
 */
async function restoreLocalThenHost(
  environmentId: string,
  signal: { cancelled: boolean },
  input: RestoreInput,
): Promise<void> {
  try {
    await durableComposerDrafts.restoreLocal(input);
    if (signal.cancelled || !(await whenHostReady(environmentId, signal))) return;
    await durableComposerDrafts.restore(input);
  } catch (error) {
    console.warn("Could not restore the saved draft.", error);
  }
}

// ── Thread and new-chat composers ────────────────────────────────────────

interface ThreadDraftTarget {
  readonly environmentId: string;
  readonly key: ComposerDraftKey;
}

function asDraftKey(key: string): ComposerDraftKey | null {
  return COMPOSER_DRAFT_KEY_PATTERN.test(key) ? (key as ComposerDraftKey) : null;
}

/** The host key of a composer draft store entry, or null for drafts kept only here. */
export function durableTargetForStoreKey(
  storeKey: string,
  environmentOfDraft: (storeKey: string) => string | undefined,
): ThreadDraftTarget | null {
  const threadRef = parseScopedThreadKey(storeKey);
  if (threadRef) {
    const key = asDraftKey(`thread:${threadRef.threadId}`);
    return key ? { environmentId: threadRef.environmentId, key } : null;
  }
  // New-chat drafts have a session naming their host; queued edits and
  // question answers do not and stay local.
  const environmentId = environmentOfDraft(storeKey);
  const key = environmentId ? asDraftKey(`draft:${storeKey}`) : null;
  return key && environmentId ? { environmentId, key } : null;
}

const toDurable = (
  attachment: ComposerImageAttachment | ComposerFileAttachment,
): DurableDraftAttachment | null =>
  attachment.file
    ? {
        id: attachment.id,
        type: attachment.type,
        name: attachment.name,
        mimeType: attachment.mimeType,
        sizeBytes: attachment.sizeBytes,
        file: attachment.file,
      }
    : null;

export function snapshotOfThreadDraft(
  draft: ComposerThreadDraftState | undefined,
): DurableDraftSnapshot {
  if (!draft) return { prompt: "", attachments: [] };
  return {
    prompt: draft.prompt,
    attachments: [...draft.images, ...draft.files].flatMap((attachment) => {
      const durable = toDurable(attachment);
      return durable ? [durable] : [];
    }),
  };
}

let threadSyncStarted = false;

function startThreadDraftSync(): void {
  if (threadSyncStarted) return;
  threadSyncStarted = true;
  let previous = useComposerDraftStore.getState();
  useComposerDraftStore.subscribe((state) => {
    const before = previous;
    previous = state;
    if (state.draftsByThreadKey === before.draftsByThreadKey) return;
    const environmentOf = (storeKey: string) =>
      (state.draftThreadsByThreadKey[storeKey] ?? before.draftThreadsByThreadKey[storeKey])
        ?.environmentId;
    const changed = new Set([
      ...Object.keys(state.draftsByThreadKey),
      ...Object.keys(before.draftsByThreadKey),
    ]);
    for (const storeKey of changed) {
      const next = state.draftsByThreadKey[storeKey];
      if (next === before.draftsByThreadKey[storeKey]) continue;
      const target = durableTargetForStoreKey(storeKey, environmentOf);
      if (!target) continue;
      durableComposerDrafts.schedule(target, snapshotOfThreadDraft(next));
    }
  });
}

function addRestoredAttachments(
  target: ComposerThreadTarget,
  attachments: ReadonlyArray<DurableDraftAttachment>,
): void {
  const store = useComposerDraftStore.getState();
  const images: ComposerImageAttachment[] = [];
  const files: ComposerFileAttachment[] = [];
  for (const attachment of attachments) {
    const file =
      attachment.file instanceof File
        ? attachment.file
        : new File([attachment.file], attachment.name, { type: attachment.mimeType });
    if (attachment.type === "image") {
      images.push({
        type: "image",
        id: attachment.id,
        name: attachment.name,
        mimeType: attachment.mimeType,
        sizeBytes: attachment.sizeBytes,
        previewUrl: URL.createObjectURL(file),
        file,
      });
    } else {
      files.push({
        type: "file",
        id: attachment.id,
        name: attachment.name,
        mimeType: attachment.mimeType,
        sizeBytes: attachment.sizeBytes,
        file,
      });
    }
  }
  if (images.length > 0) store.addImages(target, images);
  if (files.length > 0) store.addFiles(target, files);
}

/** Brings a thread's or new chat's host copy back into its composer when it opens. */
export function useDurableThreadDraftRestore(target: ComposerThreadTarget): void {
  const storeKey = composerTargetKey(target);
  useEffect(() => {
    startThreadDraftSync();
    const state = useComposerDraftStore.getState();
    const durable = durableTargetForStoreKey(
      storeKey,
      (key) => state.draftThreadsByThreadKey[key]?.environmentId,
    );
    if (!durable) return;
    const signal = { cancelled: false };
    const input = {
      target: durable,
      local: () =>
        snapshotOfThreadDraft(useComposerDraftStore.getState().draftsByThreadKey[storeKey]),
      apply: (snapshot: DurableDraftSnapshot) => {
        if (signal.cancelled) return;
        const store = useComposerDraftStore.getState();
        const current = store.draftsByThreadKey[storeKey];
        const incoming = new Set(snapshot.attachments.map((attachment) => attachment.id));
        for (const image of current?.images ?? []) {
          if (!incoming.has(image.id)) store.removeImage(target, image.id);
        }
        for (const file of current?.files ?? []) {
          if (!incoming.has(file.id)) store.removeFile(target, file.id);
        }
        const present = new Set(
          [...(current?.images ?? []), ...(current?.files ?? [])].map((item) => item.id),
        );
        store.setPrompt(target, snapshot.prompt);
        addRestoredAttachments(
          target,
          snapshot.attachments.filter((attachment) => !present.has(attachment.id)),
        );
      },
    };
    void restoreLocalThenHost(durable.environmentId, signal, input);
    return () => {
      signal.cancelled = true;
    };
    // The target object changes identity on every render; its key does not.
  }, [storeKey]);
}

/**
 * Wraps a thread send: the composer clears at once, but the host keeps the
 * draft until the send is confirmed or fails (and the composer is restored).
 */
export function holdDurableThreadDraft(target: ComposerThreadTarget): () => void {
  const state = useComposerDraftStore.getState();
  const durable = durableTargetForStoreKey(
    composerTargetKey(target),
    (key) => state.draftThreadsByThreadKey[key]?.environmentId,
  );
  return durable ? durableComposerDrafts.hold(durable.key) : () => {};
}

// ── Project coordinator composer ─────────────────────────────────────────

const coordinatorKey = (projectId: string) => asDraftKey(`coordinator:${projectId}`);

function snapshotOfCoordinator(composer: ProjectCoordinatorComposer): DurableDraftSnapshot {
  const { prompt, attachments } = composer.getSnapshot();
  return {
    prompt,
    attachments: attachments.flatMap((attachment) => {
      const durable = toDurable(attachment);
      return durable ? [durable] : [];
    }),
  };
}

/** Saves the coordinator's composer on every change and restores it when the project opens. */
export function useDurableCoordinatorDraft(
  environmentId: EnvironmentId,
  projectId: string,
  composer: ProjectCoordinatorComposer,
): void {
  useEffect(() => {
    const key = coordinatorKey(projectId);
    if (!key) return;
    const target = { environmentId, key };
    let last = composer.getSnapshot();
    const unsubscribe = composer.subscribe(() => {
      const next = composer.getSnapshot();
      if (next.prompt === last.prompt && next.attachments === last.attachments) return;
      last = next;
      durableComposerDrafts.schedule(target, snapshotOfCoordinator(composer));
    });
    const signal = { cancelled: false };
    void restoreLocalThenHost(environmentId, signal, {
      target,
      local: () => snapshotOfCoordinator(composer),
      apply: (snapshot) => {
        if (signal.cancelled) return;
        const restored = snapshot.attachments.map((attachment) => {
          const file =
            attachment.file instanceof File
              ? attachment.file
              : new File([attachment.file], attachment.name, { type: attachment.mimeType });
          return attachment.type === "image"
            ? ({
                type: "image",
                id: attachment.id,
                name: attachment.name,
                mimeType: attachment.mimeType,
                sizeBytes: attachment.sizeBytes,
                previewUrl: URL.createObjectURL(file),
                file,
              } satisfies ComposerImageAttachment)
            : ({
                type: "file",
                id: attachment.id,
                name: attachment.name,
                mimeType: attachment.mimeType,
                sizeBytes: attachment.sizeBytes,
                file,
              } satisfies ComposerFileAttachment);
        });
        const incoming = new Set(restored.map((attachment) => attachment.id));
        for (const replaced of composer.getSnapshot().attachments) {
          if (!incoming.has(replaced.id)) releaseDraftAttachment(replaced);
        }
        composer.setPrompt(snapshot.prompt);
        composer.setAttachments(restored);
        last = composer.getSnapshot();
        for (const image of restored) startAttachmentUpload({ environmentId, image });
      },
    });
    return () => {
      signal.cancelled = true;
      unsubscribe();
    };
  }, [environmentId, projectId, composer]);
}

// ── Save at once when the window may be about to go away ─────────────────

if (typeof window !== "undefined" && typeof window.addEventListener === "function") {
  const flush = () => void durableComposerDrafts.flush();
  window.addEventListener("blur", flush);
  window.addEventListener("pagehide", flush);
  window.addEventListener("beforeunload", flush);
  // A composer losing focus is the natural end of an edit.
  window.addEventListener("focusout", flush);
  document.addEventListener("visibilitychange", () => {
    if (document.visibilityState === "hidden") flush();
  });
}
