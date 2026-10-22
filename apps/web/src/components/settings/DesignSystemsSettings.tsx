/**
 * Settings > Design systems: wires this machine's design-system RPCs into
 * the list, the proposals waiting for review, the new-system flows and the
 * review dialog. Only a confirmed review writes a system.
 */
import { squashAtomCommandFailure } from "@specweave-studio/client-runtime/state/runtime";
import {
  AuthFilesystemReadScope,
  AuthFilesystemWriteScope,
  type DesignSystemConfirmInput,
  type DesignSystemProposal,
  type DesignSystemProposeInput,
  type DesignSystemSummary,
  type EnvironmentId,
  type ProjectId,
  type ThreadId,
} from "@specweave-studio/contracts";
import { useCallback, useEffect, useState } from "react";

import { usePrimaryEnvironmentId } from "~/state/environments";
import { useThreadShells } from "~/state/entities";
import { useEnvironmentQuery } from "~/state/query";
import { useEnvironmentScope } from "~/state/session";
import { useAtomCommand } from "~/state/use-atom-command";
import { design } from "~/studio/design";
import { designSystemImport } from "~/studio/designSystemImport";

import { DESIGN_FEATURES } from "../design/designFeatures";
import { DesignSystemReviewDialog } from "../design/systems/DesignSystemReviewDialog";
import {
  DesignSystemsSettingsView,
  type RescanState,
} from "../design/systems/DesignSystemsSettingsView";
import {
  type FigmaStatusView,
  NewDesignSystemDialog,
  type NewSystemMode,
} from "../design/systems/NewDesignSystemDialog";
import { failureText, ownerName, ownerOfSummary, systemKey } from "../design/systems/reviewModel";
import type { ScanOutcome } from "../design/systems/ScanFromCode";
import { useOwnerProjects } from "../design/systems/useOwnerProjects";
import { toastManager } from "../ui/toast";
import { SettingsPageContainer, SettingsSearchTarget } from "./settingsLayout";
import { searchableSetting } from "./settingsSearch";

function useNow(intervalMs: number) {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const timer = window.setInterval(() => setNow(Date.now()), intervalMs);
    return () => window.clearInterval(timer);
  }, [intervalMs]);
  return now;
}

// Settings search lists this page only while the feature flag is on, but the
// page itself opens by URL either way, so it cannot rely on that entry.
const searchTarget = () =>
  DESIGN_FEATURES.designSystems
    ? searchableSetting("design-systems")
    : { id: "design-systems", title: "Design systems" };

export function DesignSystemsSettings() {
  const environmentId = usePrimaryEnvironmentId();
  const canRead = useEnvironmentScope(environmentId, AuthFilesystemReadScope);
  return (
    <SettingsPageContainer>
      {environmentId === null ? (
        <p className="text-sm text-muted-foreground">Connect to this Mac to see design systems.</p>
      ) : !canRead ? (
        <p className="text-sm text-muted-foreground">This window may not read design systems.</p>
      ) : (
        <SettingsSearchTarget {...searchTarget()}>
          <ConnectedDesignSystems environmentId={environmentId} />
        </SettingsSearchTarget>
      )}
    </SettingsPageContainer>
  );
}

interface ReviewTarget {
  readonly id: string;
  readonly initial: DesignSystemProposal | null;
}

function ConnectedDesignSystems({ environmentId }: { environmentId: EnvironmentId }) {
  const now = useNow(30_000);
  const canWrite = useEnvironmentScope(environmentId, AuthFilesystemWriteScope);
  const projects = useOwnerProjects(environmentId);
  const threads = useThreadShells();
  const systemList = useEnvironmentQuery(
    design.systemList({ environmentId, input: { filter: { kind: "all" } } }),
  );
  const proposalList = useEnvironmentQuery(
    designSystemImport.proposals({ environmentId, input: { filter: { kind: "all" } } }),
  );
  const [mode, setMode] = useState<NewSystemMode | null>(null);
  // One check for the page: the Figma desktop row and the Figma dialog share it.
  const figmaQuery = useEnvironmentQuery(
    designSystemImport.figmaStatus({ environmentId, input: {} }),
  );
  const [review, setReview] = useState<ReviewTarget | null>(null);
  const reviewQuery = useEnvironmentQuery(
    review === null
      ? null
      : designSystemImport.proposal({ environmentId, input: { proposalId: review.id } }),
  );
  const [reviewBusy, setReviewBusy] = useState(false);
  const [reviewError, setReviewError] = useState<string | null>(null);
  const [rescans, setRescans] = useState<Record<string, RescanState>>({});

  const scan = useAtomCommand(designSystemImport.scan, { reportFailure: false });
  const propose = useAtomCommand(designSystemImport.propose, { reportFailure: false });
  const confirm = useAtomCommand(designSystemImport.confirm, { reportFailure: false });
  const discard = useAtomCommand(designSystemImport.discard, { reportFailure: false });
  const rescan = useAtomCommand(designSystemImport.rescan, { reportFailure: false });

  const refreshSystems = systemList.refresh;
  const refreshProposals = proposalList.refresh;

  const threadTitleFor = useCallback(
    (threadId: ThreadId) =>
      threads.find((thread) => thread.environmentId === environmentId && thread.id === threadId)
        ?.title ?? null,
    [environmentId, threads],
  );

  const openReview = (target: ReviewTarget) => {
    setReviewError(null);
    setReviewBusy(false);
    setReview(target);
  };

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
    const result = await propose({ environmentId, input });
    if (result._tag === "Failure")
      return failureText(squashAtomCommandFailure(result), "Nothing could be read from it.");
    setMode(null);
    refreshProposals();
    openReview({ id: result.value.id, initial: result.value });
    return null;
  };

  const onRescan = async (system: DesignSystemSummary) => {
    const key = systemKey(system);
    setRescans((current) => ({ ...current, [key]: { status: "busy" } }));
    const result = await rescan({
      environmentId,
      input: { owner: ownerOfSummary(system), systemId: system.ref.systemId },
    });
    let next: RescanState | null;
    if (result._tag === "Failure") {
      next = {
        status: "error",
        message: failureText(squashAtomCommandFailure(result), "The files were not checked."),
      };
    } else if (result.value.status === "changed") {
      next = null;
      refreshProposals();
      openReview({ id: result.value.proposal.id, initial: result.value.proposal });
    } else if (result.value.status === "unchanged") {
      next = { status: "unchanged" };
    } else {
      next = { status: "not-rescannable", detail: result.value.detail };
    }
    setRescans((current) => {
      const { [key]: _done, ...rest } = current;
      return next === null ? rest : { ...rest, [key]: next };
    });
  };

  const figma: FigmaStatusView = {
    status: figmaQuery.data,
    error: figmaQuery.error,
    checking: figmaQuery.isPending,
    onCheck: figmaQuery.refresh,
  };

  const proposal = reviewQuery.data ?? review?.initial ?? null;
  const reviewOwner = proposal === null ? "" : ownerName(proposal.owner, projects);

  const onConfirm = async (input: DesignSystemConfirmInput) => {
    setReviewBusy(true);
    setReviewError(null);
    const result = await confirm({ environmentId, input });
    setReviewBusy(false);
    if (result._tag === "Failure") {
      setReviewError(
        failureText(squashAtomCommandFailure(result), "The design system was not saved."),
      );
      return;
    }
    setReview(null);
    refreshSystems();
    refreshProposals();
    setRescans({});
    toastManager.add({
      type: "success",
      title: `Saved ${result.value.system.name}`,
      description: `In ${reviewOwner}, revision ${result.value.system.revision}.`,
    });
  };

  const onDiscard = async () => {
    if (review === null) return;
    setReviewBusy(true);
    setReviewError(null);
    const result = await discard({ environmentId, input: { proposalId: review.id } });
    setReviewBusy(false);
    if (result._tag === "Failure") {
      setReviewError(
        failureText(squashAtomCommandFailure(result), "The proposal was not discarded."),
      );
      return;
    }
    setReview(null);
    refreshProposals();
  };

  return (
    <>
      <DesignSystemsSettingsView
        systems={systemList.data?.systems ?? (systemList.error ? [] : null)}
        systemsError={systemList.error}
        problems={systemList.data?.problems ?? []}
        proposals={proposalList.data?.proposals ?? (proposalList.error ? [] : null)}
        projects={projects}
        now={now}
        canWrite={canWrite}
        rescans={rescans}
        threadTitleFor={threadTitleFor}
        onRescan={(system) => void onRescan(system)}
        onOpenProposal={(summary) => openReview({ id: summary.id, initial: null })}
        onNew={setMode}
        figma={figma}
      />
      {mode !== null ? (
        <NewDesignSystemDialog
          mode={mode}
          onModeChange={setMode}
          onOpenChange={(open) => !open && setMode(null)}
          projects={projects}
          figma={figma}
          onScan={onScan}
          onPropose={onPropose}
        />
      ) : null}
      {review !== null ? (
        <DesignSystemReviewDialog
          proposal={proposal}
          loadError={proposal === null ? reviewQuery.error : null}
          ownerLabel={reviewOwner}
          threadTitle={
            proposal?.createdBy.kind === "agent"
              ? threadTitleFor(proposal.createdBy.threadId)
              : null
          }
          busy={reviewBusy}
          error={reviewError}
          onConfirm={(input) => void onConfirm(input)}
          onDiscard={() => void onDiscard()}
          onClose={() => setReview(null)}
        />
      ) : null}
    </>
  );
}
