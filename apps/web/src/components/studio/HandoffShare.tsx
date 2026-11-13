import type { EnvironmentProject } from "@specweave-studio/client-runtime/state/shell";
import {
  isAtomCommandInterrupted,
  squashAtomCommandFailure,
} from "@specweave-studio/client-runtime/state/runtime";
import { scopeProjectRef } from "@specweave-studio/client-runtime/environment";
import type { EnvironmentId } from "@specweave-studio/contracts";
import { useEffect, useState } from "react";

import { newProjectId } from "~/lib/utils";
import { waitForProject } from "~/state/entities";
import { useProjectClone } from "~/state/projectClones";
import { sourceControlEnvironment } from "~/state/sourceControl";
import { useAtomCommand } from "~/state/use-atom-command";
import {
  cloneUrlFor,
  cloneUrlsFor,
  defaultDestinationFolder,
  destinationPlan,
  IGNORED_FILES_NOTE,
  listAddToMachineJobs,
  writeAddToMachineJob,
} from "~/studio/addToMachine";
import {
  ADD_TO_MACHINE_JOBS_EVENT,
  messageOf,
  notifyAddToMachineJobs,
  unwrap,
} from "~/studio/addToMachineCopy";
import { MachineOptionRows, type MachineOption } from "../handoff/MachineOptionRows";
import { Button } from "../ui/button";
import { Checkbox } from "../ui/checkbox";
import { HandoffCopyActions } from "./HandoffCopyActions";
import { useCopyScope } from "./HandoffCopyScope";
import { HandoffShareRepositories } from "./HandoffShareRepositories";
import { MoreOptions, useProjectMoveDialog } from "./ProjectMoveOptions";

/** How long a finished clone waits for its link before Add is offered again. */
const LINK_WAIT_MS = 120_000;

/** What the share screen needs from the handoff dialog around it. */
export interface HandoffShareProps {
  readonly project: EnvironmentProject;
  readonly sourceLabel: string;
  readonly machines: ReadonlyArray<MachineOption>;
  readonly machine: EnvironmentId | null;
  readonly machineLabel: string | null;
  /** The chosen machine has a checkout of this repository, ready to take the coordinator. */
  readonly linked: boolean;
  /** That checkout is linked to this project, so the clone and link have both finished. */
  readonly joined: boolean;
  /** Uncommitted files on this machine, which Git does not carry. */
  readonly uncommittedFiles: number;
  readonly loading: boolean;
  /** Reaches the other machine and supports cloning a project. */
  readonly canClone: boolean;
  readonly onMachineChange: (machine: EnvironmentId | null) => void;
  /** Hands the coordinator to the chosen machine's copy, through the Git review. */
  readonly onMove: () => void;
  readonly onCopyInstead: () => void;
  readonly onPrepareRepositories: () => void;
  /** The folder there needs a person's choice: the full Add to another machine dialog. */
  readonly onNeedsFolderChoice: () => void;
  readonly onBusyChange: (busy: boolean) => void;
  readonly onClose: () => void;
}

/**
 * The default handoff: one project on many machines. The other machine clones the
 * project's repository from Git and links it, which shares the goal, instructions, notes
 * and repository list; other repositories clone when a task needs them. Files move only
 * through Git, so there is nothing to review.
 */
export function HandoffShare({
  project,
  sourceLabel,
  machines,
  machine,
  machineLabel,
  linked,
  joined,
  uncommittedFiles,
  loading,
  canClone,
  onMachineChange,
  onMove,
  onCopyInstead,
  onPrepareRepositories,
  onNeedsFolderChoice,
  onBusyChange,
  onClose,
}: HandoffShareProps) {
  const checkRemoteAccess = useAtomCommand(sourceControlEnvironment.checkRemoteAccess, {
    reportFailure: false,
  });
  const inspectDestination = useAtomCommand(sourceControlEnvironment.inspectDestination, {
    reportFailure: false,
  });
  const startProjectClone = useAtomCommand(sourceControlEnvironment.startProjectClone, {
    reportFailure: false,
  });
  const moveDialog = useProjectMoveDialog();
  const [alsoMove, setAlsoMove] = useState(false);
  // Git carries tracked files only; these two send the rest, and both start off.
  const [copyIgnored, setCopyIgnored] = useState(false);
  const [includeSecrets, setIncludeSecrets] = useState(false);
  const [busy, setBusy] = useState(false);
  const [added, setAdded] = useState<EnvironmentId | null>(null);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => onBusyChange(busy), [busy, onBusyChange]);

  const scope = useCopyScope(project, !project.repositoryIdentity && !linked);
  const nested = scope.selected.repositories.length > 0;
  const urls = project.repositoryIdentity ? cloneUrlsFor(project.repositoryIdentity) : null;
  const remoteUrl = urls ? cloneUrlFor(urls, urls.preferred) : null;
  // A clone started earlier, from this dialog or a closed one, is still this machine's add.
  const [jobs, setJobs] = useState(listAddToMachineJobs);
  useEffect(() => {
    const refresh = () => setJobs(listAddToMachineJobs());
    window.addEventListener(ADD_TO_MACHINE_JOBS_EVENT, refresh);
    return () => window.removeEventListener(ADD_TO_MACHINE_JOBS_EVENT, refresh);
  }, []);
  // The newest: Add again after a failed clone leaves the failed job beside the new one.
  const job = jobs
    .filter(
      (item) =>
        item.source.environmentId === project.environmentId &&
        item.source.projectId === project.id &&
        item.destination.environmentId === machine,
    )
    .toSorted((a, b) => Date.parse(b.createdAt) - Date.parse(a.createdAt))[0];
  const clone = useProjectClone(
    job ? scopeProjectRef(job.destination.environmentId, job.destination.projectId) : null,
  );
  const cloneStopped = clone?.phase === "failed" || clone?.phase === "cancelled";
  const cloning = job !== undefined && !cloneStopped && !joined;
  // A finished clone clears its job before the link shows here, so the add waits for it.
  const justAdded = cloning || (added !== null && added === machine && !cloneStopped);
  const jobEnded = job === undefined;
  useEffect(() => {
    if (added === null || added !== machine || !jobEnded || joined) return;
    const giveUp = window.setTimeout(() => setAdded(null), LINK_WAIT_MS);
    return () => window.clearTimeout(giveUp);
  }, [added, machine, jobEnded, joined]);

  // The link lands after the clone, in the background; the move waits for it.
  useEffect(() => {
    if (added !== null && added === machine && alsoMove && joined) onMove();
  }, [added, machine, alsoMove, joined, onMove]);

  const add = async () => {
    if (!machine || !machineLabel || remoteUrl === null) return;
    // Secret files are picked one by one, in the full Add to another machine review.
    if (includeSecrets) {
      onNeedsFolderChoice();
      return;
    }
    setBusy(true);
    setError(null);
    try {
      const access = unwrap(
        await checkRemoteAccess({ environmentId: machine, input: { remoteUrl } }),
      );
      if (access.status !== "ok") {
        setError(
          `${machineLabel} can't read this repository. Sign in to GitHub on ${machineLabel} (gh auth login or an SSH key), then try again.`,
        );
        return;
      }
      const inspected = unwrap(
        await inspectDestination({
          environmentId: machine,
          input: { path: defaultDestinationFolder(project.workspaceRoot), remoteUrl },
        }),
      );
      if (destinationPlan(inspected).kind !== "clone") {
        onNeedsFolderChoice();
        return;
      }
      const projectId = newProjectId();
      const started = await startProjectClone({
        environmentId: machine,
        input: {
          projectId,
          title: project.title,
          createdAt: new Date().toISOString(),
          remoteUrl,
          destinationPath: inspected.path,
        },
      });
      if (started._tag === "Failure") {
        if (!isAtomCommandInterrupted(started))
          setError(messageOf(squashAtomCommandFailure(started), "The clone could not start."));
        return;
      }
      writeAddToMachineJob({
        version: 1,
        source: {
          environmentId: project.environmentId,
          projectId: project.id,
          workspaceRoot: project.workspaceRoot,
        },
        destination: { environmentId: machine, projectId, workspaceRoot: inspected.path },
        copyIgnored,
        secrets: [],
        createdAt: new Date().toISOString(),
      });
      notifyAddToMachineJobs();
      setJobs(listAddToMachineJobs());
      setAdded(machine);
      await waitForProject(scopeProjectRef(machine, projectId), 10_000).catch(() => undefined);
    } catch (cause) {
      setError(messageOf(cause, `Could not add this project to ${machineLabel}.`));
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="space-y-4" data-slot="handoff-share">
      <fieldset className="min-w-0 space-y-2">
        <legend className="text-xs font-medium text-muted-foreground">Machine</legend>
        {!loading && machines.length === 0 ? (
          <p className="text-sm text-muted-foreground">
            No other machine is connected. Pair one in Settings › Machines.
          </p>
        ) : (
          <MachineOptionRows
            aria-label="Machine"
            options={machines}
            value={machine}
            disabled={busy}
            loading={loading}
            onChange={(value) => onMachineChange(value as EnvironmentId | null)}
          />
        )}
        {moveDialog?.machinesExtra}
      </fieldset>
      {machineLabel && (
        <p className="wrap-anywhere text-sm text-muted-foreground" data-slot="handoff-share-about">
          {justAdded
            ? joined
              ? `${machineLabel} has this project. It shares the goal, instructions, notes and repository list.`
              : alsoMove
                ? `${machineLabel} is cloning this project. Keep this open: the coordinator moves when the clone finishes.`
                : `${machineLabel} is cloning this project. You can close this; it links when the clone finishes.`
            : linked
              ? `${machineLabel} already has this project. Its goal, instructions, notes and repository list stay in sync.`
              : remoteUrl === null
                ? `This project folder has no Git remote of its own.`
                : `${machineLabel} clones this project from Git and shares its goal, instructions, notes and repository list. Other repositories clone when a task needs them.`}
        </p>
      )}
      {machineLabel && !linked && !justAdded && remoteUrl === null && (
        <HandoffShareRepositories scope={scope} machineLabel={machineLabel} />
      )}
      {machineLabel && !linked && !justAdded && uncommittedFiles > 0 && (
        <p className="wrap-anywhere text-sm text-muted-foreground" data-slot="handoff-share-local">
          {uncommittedFiles === 1
            ? remoteUrl === null
              ? "1 local change"
              : "1 uncommitted file stays"
            : remoteUrl === null
              ? `${uncommittedFiles} local changes`
              : `${uncommittedFiles} uncommitted files stay`}{" "}
          on {sourceLabel}
          {remoteUrl === null
            ? ". The transfer review lets you copy local changes and files outside Git. Secret files need a separate selection."
            : ". Commit and push to share them, or choose Copy files instead."}
        </p>
      )}
      {machineLabel && !linked && remoteUrl !== null && !justAdded && (
        <div className="space-y-2" data-slot="handoff-share-extras">
          <p className="wrap-anywhere text-sm text-muted-foreground">
            Files Git ignores and secret files, such as .env, stay on {sourceLabel} unless you send
            them.
          </p>
          <ShareTick
            checked={copyIgnored}
            disabled={busy}
            onChange={setCopyIgnored}
            label="Copy ignored files"
            note={IGNORED_FILES_NOTE}
          />
          <ShareTick
            checked={includeSecrets}
            disabled={busy}
            onChange={setIncludeSecrets}
            label="Include secrets"
            note="Add opens the full review, where you pick the secret files and ignored files to send."
          />
        </div>
      )}
      {machineLabel && !linked && remoteUrl !== null && !justAdded && (
        <label className="flex items-start gap-2 text-sm" data-slot="handoff-share-move">
          <span className="flex h-5 shrink-0 items-center">
            <Checkbox
              checked={alsoMove}
              disabled={busy}
              onCheckedChange={(checked) => setAlsoMove(checked === true)}
            />
          </span>
          <span className="min-w-0 wrap-anywhere leading-5">Also move the coordinator there</span>
        </label>
      )}
      {machineLabel && cloneStopped && !joined && (
        <p
          className="wrap-anywhere text-sm text-muted-foreground"
          data-slot="handoff-share-stopped"
        >
          The clone on {machineLabel} did not finish. Retry or remove it from that project&apos;s
          chat.
        </p>
      )}
      {machineLabel && !linked && !justAdded && remoteUrl !== null && !canClone && (
        <p className="wrap-anywhere text-sm text-muted-foreground">
          Update {machineLabel} to add this project to it.
        </p>
      )}
      {error && (
        <p role="alert" className="wrap-anywhere text-sm text-destructive-foreground">
          {error}
        </p>
      )}
      <MoreOptions disabled={busy}>
        <div>
          <Button size="sm" variant="outline" disabled={busy} onClick={onCopyInstead}>
            Copy files instead
          </Button>
          <p className="mt-1 text-xs text-muted-foreground">
            For a project with no remote, or local files you want to send.
          </p>
        </div>
      </MoreOptions>
      <HandoffCopyActions>
        {justAdded ? null : linked ? (
          <Button disabled={busy || !machineLabel} onClick={onMove}>
            {`Hand off to ${machineLabel ?? "machine"}`}
          </Button>
        ) : remoteUrl === null ? (
          <Button disabled={busy || !machineLabel || scope.loading} onClick={onPrepareRepositories}>
            {nested ? "Review repositories and local files" : "Review files to transfer"}
          </Button>
        ) : (
          <Button disabled={busy || !machineLabel || !canClone} onClick={() => void add()}>
            {busy ? "Adding…" : machineLabel ? `Add ${machineLabel}` : "Add"}
          </Button>
        )}
        <Button variant="outline" disabled={busy} onClick={onClose}>
          {justAdded ? "Close" : "Cancel"}
        </Button>
      </HandoffCopyActions>
    </div>
  );
}

function ShareTick({
  checked,
  disabled,
  onChange,
  label,
  note,
}: {
  readonly checked: boolean;
  readonly disabled: boolean;
  readonly onChange: (checked: boolean) => void;
  readonly label: string;
  readonly note: string;
}) {
  return (
    <label className="flex items-start gap-2 text-sm">
      <span className="flex h-5 shrink-0 items-center">
        <Checkbox
          checked={checked}
          disabled={disabled}
          onCheckedChange={(value) => onChange(value === true)}
        />
      </span>
      <span className="min-w-0 wrap-anywhere leading-5">
        {label}
        <span className="block text-xs text-muted-foreground">{note}</span>
      </span>
    </label>
  );
}
