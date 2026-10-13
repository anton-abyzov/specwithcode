import { useSyncExternalStore } from "react";
import type { ComposerFileAttachment, ComposerImageAttachment } from "../composerDraftStore";

export type CoordinatorComposerAttachment = ComposerImageAttachment | ComposerFileAttachment;
export interface CoordinatorPreparingImage {
  readonly id: string;
  readonly name: string;
}
interface CoordinatorComposerState {
  readonly prompt: string;
  readonly promptRevision: number;
  readonly attachments: ReadonlyArray<CoordinatorComposerAttachment>;
  readonly preparing: ReadonlyArray<CoordinatorPreparingImage>;
  readonly problem: string | null;
  readonly submitting: boolean;
}
type Update<T> = T | ((current: T) => T);

function createComposer() {
  let state: CoordinatorComposerState = {
    prompt: "",
    promptRevision: 0,
    attachments: [],
    preparing: [],
    problem: null,
    submitting: false,
  };
  const listeners = new Set<() => void>();
  const update = <K extends keyof CoordinatorComposerState>(
    key: K,
    value: Update<CoordinatorComposerState[K]>,
  ) => {
    const next = typeof value === "function" ? value(state[key]) : value;
    if (Object.is(state[key], next)) return;
    state = {
      ...state,
      [key]: next,
      ...(key === "prompt" ? { promptRevision: state.promptRevision + 1 } : {}),
    };
    for (const listener of listeners) listener();
  };
  return {
    getSnapshot: () => state,
    subscribe: (listener: () => void) => {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
    setPrompt: (value: Update<string>) => update("prompt", value),
    setAttachments: (value: Update<CoordinatorComposerState["attachments"]>) =>
      update("attachments", value),
    setPreparing: (value: Update<CoordinatorComposerState["preparing"]>) =>
      update("preparing", value),
    setProblem: (value: Update<string | null>) => update("problem", value),
    setSubmitting: (value: boolean) => update("submitting", value),
    clearSentPrompt: (revision: number) => {
      if (state.promptRevision === revision) update("prompt", "");
    },
    /** Uploads already offered to the host cannot be withdrawn while its answer is pending. */
    outgoing: new Set<string>(),
  };
}

export type ProjectCoordinatorComposer = ReturnType<typeof createComposer>;
const drafts = new Map<string, ProjectCoordinatorComposer>();

/** A route change retains File objects, previews and uploads within this window. */
export function getProjectCoordinatorComposer(environmentId: string, projectId: string) {
  const key = JSON.stringify([environmentId, projectId]);
  let draft = drafts.get(key);
  if (!draft) {
    draft = createComposer();
    drafts.set(key, draft);
  }
  return draft;
}

export function useProjectCoordinatorComposer(environmentId: string, projectId: string) {
  const store = getProjectCoordinatorComposer(environmentId, projectId);
  const state = useSyncExternalStore(store.subscribe, store.getSnapshot, store.getSnapshot);
  return { ...state, store, setPrompt: store.setPrompt };
}
