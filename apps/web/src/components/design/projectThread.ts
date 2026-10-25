/**
 * A new thread in a project, started from a design. With a ready provider it
 * launches with its first message, as a thread started anywhere else does.
 * Without one it is created with no message and no turn, and the first
 * message waits in its composer until the person signs in to a provider and
 * presses Send.
 */
import { scopeThreadRef } from "@specweave-studio/client-runtime/environment";
import {
  DEFAULT_MODEL_BY_PROVIDER,
  type EnvironmentId,
  type ModelSelection,
  type ProjectId,
  type RuntimeMode,
  type ScopedThreadRef,
  type ServerSettings,
  type ThreadId,
} from "@specweave-studio/contracts";
import {
  resolveProjectSettings,
  type LegacyProjectSettingsFields,
} from "@specweave-studio/shared/projectSettings";

import { hydrateImagesFromPersisted, type ComposerImageAttachment } from "~/composerDraftStore";
import { randomUUID } from "~/lib/utils";
import { NO_PROVIDER_MODEL_SELECTION, type ProviderInstanceEntry } from "~/providerInstances";

import type { DesignMessage } from "./editor/backend";

export const NO_PROVIDER_MESSAGE =
  "No provider is ready on this machine. Sign in to one in Settings > Providers.";

/** Above a design's thread with no messages or runs while no provider on its machine can start a turn. */
export const WAITING_FOR_PROVIDER_NOTICE =
  "No provider is ready on this machine, so this thread cannot run yet and no turn has started. Its first message waits in the composer. Sign in to a provider in Settings > Providers, then press Send.";

/** Above a design's thread that already ran, or may have, while no provider on its machine is ready. */
export const NO_PROVIDER_THREAD_NOTICE =
  "No provider is ready on this machine, so this thread cannot run until you sign in to one in Settings > Providers.";

const usable = (selection: ModelSelection | null | undefined): selection is ModelSelection =>
  selection != null &&
  selection.model.trim() !== "" &&
  selection.instanceId !== NO_PROVIDER_MODEL_SELECTION.instanceId;

function entryModel(entry: ProviderInstanceEntry): string | null {
  const current = entry.models.filter((model) => model.isLegacy !== true);
  const slug =
    current.find((model) => model.isDefault === true)?.slug ??
    current[0]?.slug ??
    entry.models[0]?.slug ??
    DEFAULT_MODEL_BY_PROVIDER[entry.driverKind];
  return slug === undefined || slug.trim() === "" ? null : slug;
}

/**
 * The model a thread that waits for a provider records: the project's
 * default, then this machine's, then the first enabled provider's default
 * model (any provider's when none is enabled). The composer switches to
 * whichever provider is ready when the person sends, since a thread that
 * never ran is not tied to one. Null when this machine reports no provider
 * at all; never the local no-provider placeholder.
 */
export function waitingThreadModel(
  settings: ServerSettings,
  project: (LegacyProjectSettingsFields & { readonly id: ProjectId }) | null,
  entries: readonly ProviderInstanceEntry[],
): ModelSelection | null {
  if (entries.length === 0) return null;
  const known = (selection: ModelSelection | null | undefined) =>
    usable(selection) && entries.some((entry) => entry.instanceId === selection.instanceId);
  const configured = resolveProjectSettings(settings, project?.id ?? null, project).settings
    .defaultModelSelection;
  for (const selection of [configured, settings.defaultModelSelection])
    if (known(selection)) return selection;
  for (const entry of [
    ...entries.filter((candidate) => candidate.enabled),
    ...entries.filter((candidate) => !candidate.enabled),
  ]) {
    const model = entryModel(entry);
    if (model !== null) return { instanceId: entry.instanceId, model };
  }
  return null;
}

export interface ProjectThreadRequest {
  readonly environmentId: EnvironmentId;
  readonly projectId: ProjectId;
  readonly threadId: ThreadId;
  readonly title: string;
  readonly message: DesignMessage;
  readonly runtimeMode: RuntimeMode;
  /** The ready model the thread starts on; null when no provider can start a turn. */
  readonly model: ModelSelection | null;
  /** What the thread records when it waits instead (see waitingThreadModel); null refuses. */
  readonly waitingModel: ModelSelection | null;
}

/** The thread to launch or create, on `modelSelection`. */
export type ProjectThreadInput = Omit<ProjectThreadRequest, "model" | "waitingModel"> & {
  readonly modelSelection: ModelSelection;
};

export interface ProjectThreadDeps {
  /** Creates the thread and starts its first turn; resolves to an error message, or null. */
  readonly launch: (input: ProjectThreadInput) => Promise<string | null>;
  /** Creates the thread with no message and no turn; resolves to an error message, or null. */
  readonly create: (input: ProjectThreadInput) => Promise<string | null>;
  /** Puts the message in the thread's composer for the person to send. */
  readonly hold: (thread: ScopedThreadRef, message: DesignMessage) => void;
}

/** `started` is false when the thread exists but waits, its first message in the composer. */
export type ProjectThreadResult =
  | { readonly ok: true; readonly started: boolean }
  | { readonly ok: false; readonly message: string };

export async function startProjectThread(
  deps: ProjectThreadDeps,
  request: ProjectThreadRequest,
): Promise<ProjectThreadResult> {
  const { model, waitingModel, ...thread } = request;
  if (model !== null) {
    const failed = await deps.launch({ ...thread, modelSelection: model });
    return failed === null ? { ok: true, started: true } : { ok: false, message: failed };
  }
  if (waitingModel === null) return { ok: false, message: NO_PROVIDER_MESSAGE };
  const failed = await deps.create({ ...thread, modelSelection: waitingModel });
  if (failed !== null) return { ok: false, message: failed };
  deps.hold(scopeThreadRef(thread.environmentId, thread.threadId), thread.message);
  return { ok: true, started: false };
}

/** The part of the composer draft store a held message needs. */
export interface ThreadComposerStore {
  readonly getComposerDraft: (thread: ScopedThreadRef) => { readonly prompt: string } | null;
  readonly setPrompt: (thread: ScopedThreadRef, prompt: string) => void;
  readonly addImages: (thread: ScopedThreadRef, images: ComposerImageAttachment[]) => unknown;
}

/**
 * Puts a message in a thread's composer, after anything already typed there
 * with a blank line between them. The store syncs it to the host like any
 * edit, so it survives a reload.
 */
export function seedThreadComposer(
  store: ThreadComposerStore,
  thread: ScopedThreadRef,
  message: DesignMessage,
  newId: () => string = randomUUID,
): void {
  const typed = store.getComposerDraft(thread)?.prompt ?? "";
  store.setPrompt(
    thread,
    typed.trim() === "" ? message.text : `${typed.trimEnd()}\n\n${message.text}`,
  );
  if (message.images.length === 0) return;
  store.addImages(
    thread,
    hydrateImagesFromPersisted(message.images.map((image) => ({ id: newId(), ...image }))),
  );
}
