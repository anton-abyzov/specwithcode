/**
 * "Import from a repository" on an empty system's page: the existing code
 * scan, then the review. A project's system is filled in place (the proposal
 * targets it); a Playground system has no code, so the import becomes a new
 * system in the project chosen and its page opens.
 */
import { squashAtomCommandFailure } from "@specweave-studio/client-runtime/state/runtime";
import type {
  DesignOwnerInput,
  DesignSystemConfirmInput,
  DesignSystemId,
  DesignSystemProposal,
  DesignSystemProposeInput,
  EnvironmentId,
  ProjectId,
} from "@specweave-studio/contracts";
import { useRouter } from "@tanstack/react-router";
import { useState } from "react";

import { useEnvironmentQuery } from "~/state/query";
import { useAtomCommand } from "~/state/use-atom-command";
import { designSystemImport } from "~/studio/designSystemImport";

import {
  Dialog,
  DialogDescription,
  DialogHeader,
  DialogPanel,
  DialogPopup,
  DialogTitle,
} from "../../../ui/dialog";
import { toastManager } from "../../../ui/toast";
import { encodeSystemKey } from "../../designKey";
import { DesignSystemReviewDialog } from "../DesignSystemReviewDialog";
import { failureText, ownerName } from "../reviewModel";
import { ScanFromCode, type ScanOutcome } from "../ScanFromCode";
import { useOwnerProjects } from "../useOwnerProjects";

/** The propose input aimed at this system when it belongs to the project read. */
export function targetedProposal(
  input: DesignSystemProposeInput,
  owner: DesignOwnerInput,
  systemId: DesignSystemId,
): DesignSystemProposeInput {
  const sameProject =
    owner.kind === "project" &&
    input.owner.kind === "project" &&
    input.owner.projectId === owner.projectId;
  return sameProject ? { ...input, from: { ...input.from, targetSystemId: systemId } } : input;
}

export function SystemImportDialog({
  environmentId,
  owner,
  systemId,
  onImported,
  onClose,
}: {
  environmentId: EnvironmentId;
  owner: DesignOwnerInput;
  systemId: DesignSystemId;
  /** After the review is confirmed into this system. */
  onImported: () => void;
  onClose: () => void;
}) {
  const router = useRouter();
  const allProjects = useOwnerProjects(environmentId);
  const projects =
    owner.kind === "project"
      ? allProjects.filter((project) => project.id === owner.projectId)
      : allProjects;
  const scan = useAtomCommand(designSystemImport.scan, { reportFailure: false });
  const propose = useAtomCommand(designSystemImport.propose, { reportFailure: false });
  const confirm = useAtomCommand(designSystemImport.confirm, { reportFailure: false });
  const discard = useAtomCommand(designSystemImport.discard, { reportFailure: false });
  const [review, setReview] = useState<DesignSystemProposal | null>(null);
  const reviewQuery = useEnvironmentQuery(
    review === null
      ? null
      : designSystemImport.proposal({ environmentId, input: { proposalId: review.id } }),
  );
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const onScan = async (projectId: ProjectId): Promise<ScanOutcome> => {
    const result = await scan({ environmentId, input: { owner: { kind: "project", projectId } } });
    return result._tag === "Success"
      ? { ok: true, result: result.value }
      : {
          ok: false,
          message: failureText(squashAtomCommandFailure(result), "The project was not scanned."),
        };
  };

  const onPropose = async (input: DesignSystemProposeInput): Promise<string | null> => {
    const result = await propose({
      environmentId,
      input: targetedProposal(input, owner, systemId),
    });
    if (result._tag === "Failure")
      return failureText(squashAtomCommandFailure(result), "Nothing could be read from it.");
    setError(null);
    setReview(result.value);
    return null;
  };

  const proposal = reviewQuery.data ?? review;

  const onConfirm = async (input: DesignSystemConfirmInput) => {
    setBusy(true);
    setError(null);
    const result = await confirm({ environmentId, input });
    setBusy(false);
    if (result._tag === "Failure")
      return setError(
        failureText(squashAtomCommandFailure(result), "The design system was not saved."),
      );
    const saved = result.value.system;
    if (saved.id === systemId && proposal?.owner.kind === owner.kind) {
      toastManager.add({ type: "success", title: `Imported into ${saved.name}` });
      onImported();
    } else if (proposal !== null) {
      toastManager.add({
        type: "success",
        title: `Saved ${saved.name}`,
        description: `A new design system in ${ownerName(proposal.owner, allProjects)}.`,
      });
      void router.navigate({
        to: "/design/systems/$systemKey",
        params: { systemKey: encodeSystemKey(proposal.owner, saved.id) },
      });
    }
    onClose();
  };

  const onDiscard = async () => {
    if (review === null) return;
    setBusy(true);
    const result = await discard({ environmentId, input: { proposalId: review.id } });
    setBusy(false);
    if (result._tag === "Failure")
      return setError(
        failureText(squashAtomCommandFailure(result), "The proposal was not discarded."),
      );
    onClose();
  };

  if (review !== null)
    return (
      <DesignSystemReviewDialog
        proposal={proposal}
        loadError={proposal === null ? reviewQuery.error : null}
        ownerLabel={proposal === null ? "" : ownerName(proposal.owner, allProjects)}
        threadTitle={null}
        busy={busy}
        error={error}
        onConfirm={(input) => void onConfirm(input)}
        onDiscard={() => void onDiscard()}
        onClose={onClose}
      />
    );

  return (
    <Dialog open onOpenChange={(open) => !open && onClose()}>
      <DialogPopup className="sm:max-w-2xl" data-testid="system-import-dialog">
        <DialogHeader>
          <DialogTitle>Import from a repository</DialogTitle>
          <DialogDescription>
            {owner.kind === "project"
              ? "The app reads this project's token files and components, then shows a review. Only what you confirm is saved into this design system."
              : "The Playground has no code, so pick a project to read. What you confirm becomes a new design system in that project."}
          </DialogDescription>
        </DialogHeader>
        <DialogPanel>
          <ScanFromCode projects={projects} onScan={onScan} onPropose={onPropose} />
        </DialogPanel>
      </DialogPopup>
    </Dialog>
  );
}
