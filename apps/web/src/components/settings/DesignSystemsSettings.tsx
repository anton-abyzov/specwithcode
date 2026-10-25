/**
 * Settings > Design systems: wires this machine's design-system RPCs into
 * the list, the proposals waiting for review, the new-system flows and the
 * review dialog. Only a confirmed review writes a system.
 */
import { squashAtomCommandFailure } from "@specweave-studio/client-runtime/state/runtime";
import {
  AuthFilesystemReadScope,
  AuthFilesystemWriteScope,
  type DesignOwnerInput,
  type DesignSystemConfirmInput,
  type DesignSystemCreateInput,
  type DesignSystemId,
  type DesignSystemProposal,
  type DesignSystemProposeInput,
  type DesignSystemSummary,
  type EnvironmentId,
  type ProjectId,
  type ThreadId,
} from "@specweave-studio/contracts";
import { useRouter, useSearch } from "@tanstack/react-router";
import { useCallback, useEffect, useMemo, useState } from "react";

import { useClientSettings } from "~/hooks/useSettings";
import {
  deriveLogicalProjectKeyFromSettings,
  selectProjectGroupingSettings,
} from "~/logicalProject";
import { useEnvironment, usePrimaryEnvironmentId } from "~/state/environments";
import { useProjects, useThreadShells } from "~/state/entities";
import { useEnvironmentQuery } from "~/state/query";
import { useEnvironmentScope } from "~/state/session";
import { useAtomCommand } from "~/state/use-atom-command";
import { design } from "~/studio/design";
import { designSystemImport } from "~/studio/designSystemImport";

import { DESIGN_FEATURES } from "../design/designFeatures";
import {
  missingFolderOf,
  missingFolderProjects,
  missingFolderText,
  problemIsAbout,
  withMissingFolders,
} from "../design/gallery/boardOwner";
import { encodeSystemKey } from "../design/designKey";
import { DeleteSystemDialog, RenameSystemDialog } from "../design/systems/ManageSystemDialogs";
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
import {
  failureText,
  offeredProjects,
  ownerName,
  ownerOfSummary,
  systemKey,
} from "../design/systems/reviewModel";
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

/** The project `?project=` names, as a string; JSON-looking ids arrive parsed. */
export function requestedProjectOf(search: Record<string, unknown>): string | null {
  const value = search.project;
  return typeof value === "string" || typeof value === "number" ? String(value) : null;
}

interface ReviewTarget {
  readonly id: string;
  readonly initial: DesignSystemProposal | null;
}

/** A failed rename or delete in plain words; a stale revision says the list moved on. */
function manageFailure(cause: unknown, fallback: string): string {
  const code =
    typeof cause === "object" && cause !== null && "code" in cause
      ? (cause as { code: unknown }).code
      : null;
  if (code === "conflict")
    return "This design system changed since the list loaded. The list is up to date now; try again.";
  return failureText(cause, fallback);
}

function ConnectedDesignSystems({ environmentId }: { environmentId: EnvironmentId }) {
  const now = useNow(30_000);
  const router = useRouter();
  const canWrite = useEnvironmentScope(environmentId, AuthFilesystemWriteScope);
  const environment = useEnvironment(environmentId);
  const canEditSystems =
    environment?.serverConfig?.environment.capabilities.designSystemEditing === true;
  const ownerProjects = useOwnerProjects(environmentId);
  const allProjects = useProjects();
  const grouping = useClientSettings(selectProjectGroupingSettings);
  // `?project=<id>` comes from a project's design board: new systems default to that project.
  const requestedProject = useSearch({
    strict: false,
    select: (search) => requestedProjectOf(search as Record<string, unknown>),
  });
  const systemList = useEnvironmentQuery(
    design.systemList({ environmentId, input: { filter: { kind: "all" } } }),
  );
  // A project whose folder is gone is named with its path and a way to it, and no picker offers it.
  const machineProjects = useMemo(
    () => allProjects.filter((project) => project.environmentId === environmentId),
    [allProjects, environmentId],
  );
  const listProblems = systemList.data?.problems;
  const missingFolders = useMemo(
    () => missingFolderProjects(listProblems ?? [], machineProjects),
    [listProblems, machineProjects],
  );
  const projects = useMemo(
    () => withMissingFolders(ownerProjects, missingFolders),
    [missingFolders, ownerProjects],
  );
  const lostFolders = [...missingFolders].flatMap(([projectId, path]) => {
    const project = machineProjects.find((candidate) => candidate.id === projectId);
    return project === undefined
      ? []
      : [
          {
            id: project.id,
            title: project.title,
            path,
            projectKey: deriveLogicalProjectKeyFromSettings(project, grouping),
          },
        ];
  });
  const otherProblems = (listProblems ?? []).filter(
    (problem) =>
      missingFolderOf(problem.detail) === null ||
      !lostFolders.some((lost) => problemIsAbout(problem, lost)),
  );
  const defaultProjectId =
    offeredProjects(projects).find((project) => project.id === requestedProject)?.id ?? null;
  const threads = useThreadShells();
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
  const createSystem = useAtomCommand(design.systemCreate, { reportFailure: false });
  const renameSystem = useAtomCommand(design.systemRename, { reportFailure: false });
  const deleteSystem = useAtomCommand(design.systemDelete, { reportFailure: false });
  const [renaming, setRenaming] = useState<DesignSystemSummary | null>(null);
  const [deleting, setDeleting] = useState<DesignSystemSummary | null>(null);
  const usageQuery = useEnvironmentQuery(
    deleting === null
      ? null
      : design.systemUsage({
          environmentId,
          input: { owner: ownerOfSummary(deleting), systemId: deleting.ref.systemId },
        }),
  );

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

  const systemLocation = (owner: DesignOwnerInput, systemId: DesignSystemId) =>
    ({
      to: "/design/systems/$systemKey",
      params: { systemKey: encodeSystemKey(owner, systemId) },
    }) as const;
  const systemHref = (system: DesignSystemSummary) =>
    router.history.createHref(
      router.buildLocation(systemLocation(ownerOfSummary(system), system.ref.systemId)).href,
    );
  const openSystem = (system: DesignSystemSummary) =>
    void router.navigate(systemLocation(ownerOfSummary(system), system.ref.systemId));

  const onCreate = async (input: DesignSystemCreateInput): Promise<string | null> => {
    const result = await createSystem({ environmentId, input });
    if (result._tag === "Failure")
      return failureText(squashAtomCommandFailure(result), "The design system was not created.");
    setMode(null);
    refreshSystems();
    void router.navigate(systemLocation(input.owner, result.value.system.id));
    return null;
  };

  const onRename = async (system: DesignSystemSummary, name: string): Promise<string | null> => {
    const result = await renameSystem({
      environmentId,
      input: {
        owner: ownerOfSummary(system),
        systemId: system.ref.systemId,
        name,
        expectedRevision: system.revision,
      },
    });
    refreshSystems();
    if (result._tag === "Failure")
      return manageFailure(squashAtomCommandFailure(result), "The design system was not renamed.");
    return null;
  };

  const onDelete = async (system: DesignSystemSummary): Promise<string | null> => {
    const result = await deleteSystem({
      environmentId,
      input: {
        owner: ownerOfSummary(system),
        systemId: system.ref.systemId,
        expectedRevision: system.revision,
      },
    });
    refreshSystems();
    if (result._tag === "Failure")
      return manageFailure(squashAtomCommandFailure(result), "The design system was not deleted.");
    refreshProposals();
    toastManager.add({ type: "success", title: `Deleted ${system.name}` });
    return null;
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
      description: `In ${reviewOwner}.`,
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
      {lostFolders.length > 0 ? (
        <ul
          className="mb-3 flex flex-col gap-1 text-xs text-muted-foreground"
          role="status"
          data-testid="design-systems-missing-folders"
        >
          {lostFolders.map((lost) => (
            <li key={lost.projectKey}>
              <span className="font-medium text-foreground/80">{lost.title}</span>:{" "}
              {missingFolderText(lost.path)}{" "}
              <button
                type="button"
                className="rounded-sm font-medium text-foreground underline underline-offset-2 outline-none hover:text-foreground/80 focus-visible:ring-2 focus-visible:ring-ring"
                onClick={() =>
                  void router.navigate({
                    to: "/projects/$projectKey",
                    params: { projectKey: lost.projectKey },
                  })
                }
              >
                Open {lost.title}
              </button>
            </li>
          ))}
        </ul>
      ) : null}
      <DesignSystemsSettingsView
        systems={systemList.data?.systems ?? (systemList.error ? [] : null)}
        systemsError={systemList.error}
        problems={otherProblems}
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
        canStartFromScratch={canEditSystems}
        systemHref={systemHref}
        onOpenSystem={openSystem}
        onRenameSystem={setRenaming}
        onDeleteSystem={setDeleting}
      />
      {renaming !== null ? (
        <RenameSystemDialog
          name={renaming.name}
          onRename={(name) => onRename(renaming, name)}
          onClose={() => setRenaming(null)}
        />
      ) : null}
      {deleting !== null ? (
        <DeleteSystemDialog
          name={deleting.name}
          ownerLabel={deleting.ownerLabel}
          designs={usageQuery.data?.designs ?? null}
          usageError={usageQuery.error}
          onDelete={() => onDelete(deleting)}
          onClose={() => setDeleting(null)}
        />
      ) : null}
      {mode !== null ? (
        <NewDesignSystemDialog
          mode={mode}
          onModeChange={setMode}
          onOpenChange={(open) => !open && setMode(null)}
          projects={projects}
          defaultProjectId={defaultProjectId}
          figma={figma}
          onScan={onScan}
          onPropose={onPropose}
          {...(canEditSystems ? { onCreate } : {})}
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
