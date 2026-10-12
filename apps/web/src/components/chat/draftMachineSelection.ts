import type { EnvironmentConnectionPhase } from "@specweave-studio/client-runtime/connection";
import type { EnvironmentId, ProjectId } from "@specweave-studio/contracts";
import type { ComposerThreadDraftState, DraftSessionState } from "~/composerDraftStore";

export interface DraftMachineTarget {
  readonly environmentId: EnvironmentId;
  /** null explicitly means the destination's No project folder. */
  readonly projectId: ProjectId | null;
}

export function draftMachineUnavailableReason(
  phase: EnvironmentConnectionPhase,
  canOperate: boolean,
): string | null {
  if (phase === "connecting" || phase === "reconnecting") return "Connecting…";
  if (phase !== "connected") return "Not connected";
  return canOperate ? null : "Permission to operate threads required";
}

/** References and uploads belong to their source machine, even when bytes remain locally. */
export function draftHasMachineBoundContent(draft: ComposerThreadDraftState | null): boolean {
  return Boolean(
    draft &&
    (draft.images.length ||
      draft.files.length ||
      draft.persistedAttachments.length ||
      draft.terminalContexts.length ||
      draft.previewAnnotations.length ||
      draft.reviewComments.length ||
      draft.threadContexts.length),
  );
}

export const MACHINE_ATTACHMENT_BLOCK_REASON =
  "Remove attachments and linked context before switching machines, then attach them on the selected machine. Your prompt is kept.";

export type DraftMachineSelectionResult =
  | { readonly status: "selected" | "cancelled" }
  | { readonly status: "blocked"; readonly reason: string };

/** Resolve a destination without letting an asynchronous Scratch request move a newer draft. */
export async function selectDraftMachineTarget<TProject extends DraftMachineTarget>(input: {
  readonly target: DraftMachineTarget;
  readonly readDraft: () => DraftSessionState | null;
  readonly readComposer: () => ComposerThreadDraftState | null;
  readonly isBlocked: () => boolean;
  readonly isCurrentRequest: () => boolean;
  readonly unavailableReason: () => string | null;
  readonly resolveProject: () => TProject | null | Promise<TProject | null>;
  readonly commit: (project: TProject) => void;
}): Promise<DraftMachineSelectionResult> {
  const original = input.readDraft();
  if (!original || original.promotedTo || input.isBlocked() || !input.isCurrentRequest())
    return { status: "cancelled" };
  const blockedReason = () =>
    input.unavailableReason() ??
    (original.environmentId !== input.target.environmentId &&
    draftHasMachineBoundContent(input.readComposer())
      ? MACHINE_ATTACHMENT_BLOCK_REASON
      : null);
  const before = blockedReason();
  if (before) return { status: "blocked", reason: before };
  const project = await input.resolveProject();
  // Identity also rejects an away-and-back retarget or a new branch/worktree choice.
  if (
    !input.isCurrentRequest() ||
    input.isBlocked() ||
    input.readDraft() !== original ||
    original.promotedTo
  )
    return { status: "cancelled" };
  const after = blockedReason();
  if (after) return { status: "blocked", reason: after };
  if (
    !project ||
    project.environmentId !== input.target.environmentId ||
    (input.target.projectId !== null && project.projectId !== input.target.projectId)
  )
    return {
      status: "blocked",
      reason: "The destination project is unavailable. Choose it again.",
    };
  input.commit(project);
  return { status: "selected" };
}
