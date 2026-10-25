/**
 * The scan, propose, rescan and review steps Settings > Design systems runs,
 * for pages outside Settings: the design system page (Rescan) and a project's
 * board (New design system). Only a confirmed review writes a system.
 */
import { squashAtomCommandFailure } from "@specweave-studio/client-runtime/state/runtime";
import type {
  DesignOwnerInput,
  DesignSystem,
  DesignSystemConfirmInput,
  DesignSystemId,
  DesignSystemProposal,
  DesignSystemProposeInput,
  EnvironmentId,
  ProjectId,
  ThreadId,
} from "@specweave-studio/contracts";
import { useCallback, useState, type ReactNode } from "react";

import { useThreadShells } from "~/state/entities";
import { useEnvironmentQuery } from "~/state/query";
import { useAtomCommand } from "~/state/use-atom-command";
import { designSystemImport } from "~/studio/designSystemImport";

import { toastManager } from "../../ui/toast";
import { DesignSystemReviewDialog } from "./DesignSystemReviewDialog";
import type { RescanState } from "./DesignSystemsSettingsView";
import type { FigmaStatusView } from "./NewDesignSystemDialog";
import { failureText, ownerName, type OwnerProject } from "./reviewModel";
import type { ScanOutcome } from "./ScanFromCode";

interface ReviewTarget {
  readonly id: string;
  readonly initial: DesignSystemProposal | null;
}

export interface SystemReviewFlow {
  readonly onScan: (projectId: ProjectId) => Promise<ScanOutcome>;
  /** Resolves to a message when nothing could be proposed; opens the review otherwise. */
  readonly onPropose: (input: DesignSystemProposeInput) => Promise<string | null>;
  /** Reads the system's files again; a change opens the review, the rest returns a state. */
  readonly rescan: (
    owner: DesignOwnerInput,
    systemId: DesignSystemId,
  ) => Promise<RescanState | null>;
  /** Figma's desktop server, checked only while `figmaWanted`. */
  readonly figma: FigmaStatusView;
  /** The review dialog while a proposal is open. */
  readonly dialog: ReactNode;
}

export function useSystemReviewFlow(input: {
  readonly environmentId: EnvironmentId;
  readonly projects: readonly OwnerProject[];
  readonly figmaWanted: boolean;
  /** A confirmed review saved this system. */
  readonly onSaved: (system: DesignSystem) => void;
}): SystemReviewFlow {
  const { environmentId, projects, onSaved } = input;
  const threads = useThreadShells();
  const figmaQuery = useEnvironmentQuery(
    input.figmaWanted ? designSystemImport.figmaStatus({ environmentId, input: {} }) : null,
  );
  const [review, setReview] = useState<ReviewTarget | null>(null);
  const reviewQuery = useEnvironmentQuery(
    review === null
      ? null
      : designSystemImport.proposal({ environmentId, input: { proposalId: review.id } }),
  );
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const scan = useAtomCommand(designSystemImport.scan, { reportFailure: false });
  const propose = useAtomCommand(designSystemImport.propose, { reportFailure: false });
  const confirm = useAtomCommand(designSystemImport.confirm, { reportFailure: false });
  const discard = useAtomCommand(designSystemImport.discard, { reportFailure: false });
  const rescanCommand = useAtomCommand(designSystemImport.rescan, { reportFailure: false });

  const openReview = useCallback((target: ReviewTarget) => {
    setError(null);
    setBusy(false);
    setReview(target);
  }, []);

  const onScan = async (projectId: ProjectId): Promise<ScanOutcome> => {
    const result = await scan({ environmentId, input: { owner: { kind: "project", projectId } } });
    return result._tag === "Success"
      ? { ok: true, result: result.value }
      : {
          ok: false,
          message: failureText(squashAtomCommandFailure(result), "The project was not scanned."),
        };
  };

  const onPropose = async (proposeInput: DesignSystemProposeInput): Promise<string | null> => {
    const result = await propose({ environmentId, input: proposeInput });
    if (result._tag === "Failure")
      return failureText(squashAtomCommandFailure(result), "Nothing could be read from it.");
    openReview({ id: result.value.id, initial: result.value });
    return null;
  };

  const rescan = async (
    owner: DesignOwnerInput,
    systemId: DesignSystemId,
  ): Promise<RescanState | null> => {
    const result = await rescanCommand({ environmentId, input: { owner, systemId } });
    if (result._tag === "Failure")
      return {
        status: "error",
        message: failureText(squashAtomCommandFailure(result), "The files were not checked."),
      };
    if (result.value.status === "changed") {
      openReview({ id: result.value.proposal.id, initial: result.value.proposal });
      return null;
    }
    if (result.value.status === "unchanged") return { status: "unchanged" };
    return { status: "not-rescannable", detail: result.value.detail };
  };

  const proposal = reviewQuery.data ?? review?.initial ?? null;
  const reviewOwner = proposal === null ? "" : ownerName(proposal.owner, projects);
  const threadTitleFor = (threadId: ThreadId) =>
    threads.find((thread) => thread.environmentId === environmentId && thread.id === threadId)
      ?.title ?? null;

  const onConfirm = async (confirmInput: DesignSystemConfirmInput) => {
    setBusy(true);
    setError(null);
    const result = await confirm({ environmentId, input: confirmInput });
    setBusy(false);
    if (result._tag === "Failure") {
      setError(failureText(squashAtomCommandFailure(result), "The design system was not saved."));
      return;
    }
    setReview(null);
    toastManager.add({
      type: "success",
      title: `Saved ${result.value.system.name}`,
      description: `In ${reviewOwner}.`,
    });
    onSaved(result.value.system);
  };

  const onDiscard = async () => {
    if (review === null) return;
    setBusy(true);
    setError(null);
    const result = await discard({ environmentId, input: { proposalId: review.id } });
    setBusy(false);
    if (result._tag === "Failure") {
      setError(failureText(squashAtomCommandFailure(result), "The proposal was not discarded."));
      return;
    }
    setReview(null);
  };

  return {
    onScan,
    onPropose,
    rescan,
    figma: {
      status: figmaQuery.data,
      error: figmaQuery.error,
      checking: figmaQuery.isPending,
      onCheck: figmaQuery.refresh,
    },
    dialog:
      review === null ? null : (
        <DesignSystemReviewDialog
          proposal={proposal}
          loadError={proposal === null ? reviewQuery.error : null}
          ownerLabel={reviewOwner}
          threadTitle={
            proposal?.createdBy.kind === "agent"
              ? threadTitleFor(proposal.createdBy.threadId)
              : null
          }
          busy={busy}
          error={error}
          onConfirm={(confirmInput) => void onConfirm(confirmInput)}
          onDiscard={() => void onDiscard()}
          onClose={() => setReview(null)}
        />
      ),
  };
}
