import type { EnvironmentProject } from "@specweave-studio/client-runtime/state/shell";
import {
  isAtomCommandInterrupted,
  squashAtomCommandFailure,
} from "@specweave-studio/client-runtime/state/runtime";
import { scopeProjectRef } from "@specweave-studio/client-runtime/environment";
import type { EnvironmentId } from "@specweave-studio/contracts";
import { useEffect, useState } from "react";
import type { EnvironmentProject as SendProject } from "@specweave-studio/client-runtime/state/shell";

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
import { useProjectMoveDialog } from "./ProjectMoveOptions";
import { SettingHelp } from "../settings/SettingHelp";
import { Radio, RadioGroup } from "../ui/radio-group";
import { displayFolder } from "~/lib/displayFolder";
import {
  existingCopyLine,
  sendChoiceLabel,
  sendPlan,
  type MachineHolding,
  type SendChoice,
} from "~/studio/sendToMachine";

/** How long a finished clone waits for its link before Add is offered again. */
const LINK_WAIT_MS = 120_000;

/** What the share screen needs from the handoff dialog around it. */
export interface HandoffShareProps {
  readonly project: EnvironmentProject;
  readonly sourceLabel: string;
  readonly machines: ReadonlyArray<MachineOption>;
  readonly machine: EnvironmentId | null;
  readonly machineLabel: string | null;
  /** What the chosen machine already holds of this project: Main, a copy, several, none. */
  readonly holding: MachineHolding<SendProject>;
  /** The machine Main is on now, for the plan sentence. */
  readonly mainLabel: string;
  /** The chosen machine's projects folder (`suggestedProjectsRoot`), where a new copy goes. */
  readonly projectsRoot: string | null;
  /** That machine brings an existing copy to this machine's commits (1326 T-03). */
  readonly updatesCommits?: boolean;
  /** That checkout is linked to this project, so the clone and link have both finished. */
  readonly joined: boolean;
  /** Uncommitted files on this machine, which Git does not carry. */
  readonly uncommittedFiles: number;
  readonly loading: boolean;
  /** Reaches the other machine and supports cloning a project. */
  readonly canClone: boolean;
  readonly onMachineChange: (machine: EnvironmentId | null) => void;
  /** Moves Main to that machine's copy (`copyKey`, else its saved one), through the Git review. */
  readonly onMove: (copyKey?: string) => void;
  /** Copy into that machine's existing copy: the sync review, Main stays put. */
  readonly onSync: (copyKey: string) => void;
  /** The folder copy review for a machine without a copy; `move` hands Main over after. */
  readonly onCopyInstead: (move: boolean) => void;
  readonly onPrepareRepositories: (move: boolean) => void;
  /** The folder there needs a person's choice: the full Add to another machine dialog. */
  readonly onNeedsFolderChoice: () => void;
  readonly onBusyChange: (busy: boolean) => void;
  readonly onClose: () => void;
}

/**
 * Send to another machine…: one screen for add, move and sync. Pick a machine (each row
 * says Has Main, Has a copy or No copy), then Copy (the default: Main stays) or Move (Main
 * goes there). A machine with a copy gets that copy updated; one without gets a clone from
 * Git, or the folder copy review. One plan sentence says exactly what the click does.
 */
export function HandoffShare({
  project,
  sourceLabel,
  machines,
  machine,
  machineLabel,
  holding,
  mainLabel,
  projectsRoot,
  updatesCommits = false,
  joined,
  uncommittedFiles,
  loading,
  canClone,
  onMachineChange,
  onMove,
  onSync,
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
  // Copy is the safe default, and every machine change starts from it again.
  const [sendChoice, setSendChoice] = useState<SendChoice>("copy");
  // With several copies there, the person picks one; nothing is guessed.
  const [picked, setPicked] = useState<string | null>(null);
  useEffect(() => {
    setSendChoice("copy");
    setPicked(null);
  }, [machine]);
  const linked = holding.kind !== "none";
  // Git carries tracked files only; these two send the rest, and both start off.
  const [copyIgnored, setCopyIgnored] = useState(false);
  const [includeSecrets, setIncludeSecrets] = useState(false);
  const [busy, setBusy] = useState(false);
  const [added, setAdded] = useState<EnvironmentId | null>(null);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => onBusyChange(busy), [busy, onBusyChange]);

  // Where a new copy goes there, inspected before the plan names it: a taken folder gets
  // the -2 suggestion, and one that is taken too needs the person's choice.
  const [folder, setFolder] = useState<
    | { readonly state: "checking" }
    | { readonly state: "ready"; readonly path: string; readonly taken: string | null }
    | { readonly state: "choose"; readonly taken: string }
  >({ state: "checking" });
  const defaultFolder = defaultDestinationFolder(project.workspaceRoot, projectsRoot);

  // Nested repositories decide which way leads, so every unlinked project checks for them.
  const scope = useCopyScope(project, !linked);
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
      // Checked again at the click: the folder may have filled since the plan was read.
      const inspected = unwrap(
        await inspectDestination({
          environmentId: machine,
          input: { path: folder.state === "ready" ? folder.path : defaultFolder, remoteUrl },
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
      setAlsoMove(sendChoice === "move");
      setAdded(machine);
      await waitForProject(scopeProjectRef(machine, projectId), 10_000).catch(() => undefined);
    } catch (cause) {
      setError(messageOf(cause, `Could not add this project to ${machineLabel}.`));
    } finally {
      setBusy(false);
    }
  };

  // Both ways stay in view. Copy leads where Git cannot carry the work: no remote to
  // clone from, or nested repositories whose local work a clone of the root leaves out.
  const cloneOff = remoteUrl === null || !canClone;
  const copyFirst = cloneOff || nested;
  const [choice, setChoice] = useState<"clone" | "copy" | null>(null);
  const way = cloneOff ? "copy" : (choice ?? (copyFirst ? "copy" : "clone"));
  const choosing = machineLabel !== null && !linked && !justAdded;
  const inspecting = choosing && remoteUrl !== null && canClone && way === "clone";
  useEffect(() => {
    if (!inspecting || !machine || remoteUrl === null) return;
    let live = true;
    setFolder({ state: "checking" });
    const look = async (path: string) =>
      unwrap(await inspectDestination({ environmentId: machine, input: { path, remoteUrl } }));
    void (async () => {
      try {
        const first = await look(defaultFolder);
        const plan = destinationPlan(first);
        if (plan.kind === "clone") {
          if (live) setFolder({ state: "ready", path: first.path, taken: null });
          return;
        }
        const second =
          plan.kind === "refuse" ? await look(plan.suggestion) : null;
        if (!live) return;
        setFolder(
          second && destinationPlan(second).kind === "clone"
            ? { state: "ready", path: second.path, taken: first.path }
            : { state: "choose", taken: first.path },
        );
      } catch {
        // Unreadable from here: name the default; the click inspects it again.
        if (live) setFolder({ state: "ready", path: defaultFolder, taken: null });
      }
    })();
    return () => {
      live = false;
    };
  }, [inspecting, machine, remoteUrl, defaultFolder]);
  // The copy this send goes to: the one there, or the one picked among several.
  const sendCopy =
    holding.kind === "main" || holding.kind === "copy"
      ? holding.copy
      : holding.kind === "several"
        ? (holding.copies.find((copy) => copy.id === picked) ?? null)
        : null;
  const sendKey = sendCopy ? `${sendCopy.environmentId}:${sendCopy.id}` : null;
  const moving = sendChoice === "move" && holding.kind !== "main";
  const plan =
    machineLabel === null || justAdded
      ? null
      : holding.kind === "several" && !sendCopy
        ? "Pick the copy to send to."
        : !linked && way === "clone" && remoteUrl !== null && folder.state === "choose"
          ? `${displayFolder(folder.taken)} on ${machineLabel} is taken. Choose a folder there first.`
          : sendPlan({
              choice: sendChoice,
              there: machineLabel,
              main: mainLabel,
              holding: holding.kind === "main" ? "main" : linked ? "copy" : "none",
              folder: sendCopy
                ? sendCopy.workspaceRoot
                : folder.state === "ready"
                  ? folder.path
                  : defaultFolder,
              way: remoteUrl === null ? "copy" : way,
              localFiles: uncommittedFiles,
              updatesCommits,
            }) +
            (!linked && way === "clone" && folder.state === "ready" && folder.taken
              ? ` ${displayFolder(folder.taken)} is taken.`
              : "");
  const repositoryCount = scope.selected.repositories.length;
  const copyLine = nested
    ? `${repositoryCount}${scope.selected.truncated ? "+" : ""} ${repositoryCount === 1 ? "repository" : "repositories"}, with local work`
    : "Everything except secrets, with local changes";
  const cloneLine = remoteUrl === null ? "No Git remote to clone from" : "Pushed work only";
  const copyChoice = (
    <ShareChoice
      key="copy"
      value="copy"
      label={nested ? "Copy the whole folder" : "Copy files"}
      line={copyLine}
      help="Uncommitted and ignored files go too. Secret files such as .env stay here unless you pick them in the review."
    />
  );
  const cloneChoice = (
    <ShareChoice
      key="clone"
      value="clone"
      disabled={remoteUrl === null || !canClone}
      label="Clone from Git"
      line={
        remoteUrl !== null && !canClone
          ? `Update ${machineLabel ?? "the machine"} first`
          : cloneLine
      }
      help="The other machine clones the repository and links it, so the goal, instructions, notes and repository list stay shared. Uncommitted, ignored and secret files stay here unless you tick them below."
    />
  );

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
      {machineLabel && (justAdded || linked) && (
        <p className="wrap-anywhere text-sm text-muted-foreground" data-slot="handoff-share-about">
          {justAdded
            ? joined
              ? `${machineLabel} has this project.`
              : alsoMove
                ? `${machineLabel} is cloning this project. Keep this open: Main moves when the clone finishes.`
                : `${machineLabel} is cloning this project. You can close this; it links when the clone finishes.`
            : existingCopyLine({ there: machineLabel, holding, updatesCommits })}
        </p>
      )}
      {machineLabel && !justAdded && holding.kind === "several" && (
        <RadioGroup
          value={picked ?? ""}
          onValueChange={(value) => setPicked(typeof value === "string" ? value : null)}
          aria-label={`The copy on ${machineLabel}`}
          data-slot="send-copy-picker"
        >
          {holding.copies.map((copy) => (
            <label key={copy.id} className="flex min-w-0 items-center gap-3 text-sm">
              <Radio value={copy.id} />
              <span className="min-w-0 truncate">{displayFolder(copy.workspaceRoot)}</span>
            </label>
          ))}
        </RadioGroup>
      )}
      {machineLabel && !justAdded && holding.kind !== "main" && (
        <fieldset className="min-w-0" data-slot="send-choice" disabled={busy}>
          <legend className="mb-2 text-xs font-medium text-muted-foreground">Then</legend>
          <RadioGroup
            value={sendChoice}
            onValueChange={(value) => setSendChoice(value as SendChoice)}
            disabled={busy}
            aria-label="Copy or move"
          >
            {(["copy", "move"] as const).map((value) => (
              <label
                key={value}
                className="flex min-w-0 cursor-pointer items-start gap-3 text-sm"
                data-send-choice={value}
              >
                <span className="flex h-5 items-center">
                  <Radio value={value} />
                </span>
                <span className="min-w-0 wrap-anywhere leading-5">
                  {sendChoiceLabel(value, machineLabel)}
                </span>
              </label>
            ))}
          </RadioGroup>
        </fieldset>
      )}
      {choosing && (
        <fieldset className="min-w-0" data-slot="handoff-share-choices" disabled={busy}>
          <legend className="mb-2 text-xs font-medium text-muted-foreground">How</legend>
          <RadioGroup
            value={way}
            onValueChange={(value) => setChoice(value as "clone" | "copy")}
            disabled={busy}
            aria-label="How the project gets there"
          >
            {copyFirst ? [copyChoice, cloneChoice] : [cloneChoice, copyChoice]}
          </RadioGroup>
        </fieldset>
      )}
      {choosing && remoteUrl === null && (nested || scope.loading || scope.notice) && (
        <HandoffShareRepositories scope={scope} machineLabel={machineLabel} />
      )}
      {choosing && uncommittedFiles > 0 && way === "clone" && (
        // Work Git does not carry: say so where it would be lost, never only in a hint.
        <p
          className="wrap-anywhere text-sm text-warning-foreground"
          data-slot="handoff-share-local"
        >
          {uncommittedFiles === 1
            ? "1 uncommitted file stays"
            : `${uncommittedFiles} uncommitted files stay`}{" "}
          on {sourceLabel}. Commit and push, or copy files.
        </p>
      )}
      {choosing && remoteUrl !== null && way === "clone" && (
        <div className="space-y-2" data-slot="handoff-share-extras">
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
      {machineLabel && cloneStopped && !joined && (
        <p
          className="wrap-anywhere text-sm text-muted-foreground"
          data-slot="handoff-share-stopped"
        >
          The clone on {machineLabel} did not finish. Retry or remove it from that project&apos;s
          chat.
        </p>
      )}
      {error && (
        <p role="alert" className="wrap-anywhere text-sm text-destructive-foreground">
          {error}
        </p>
      )}
      {plan && (
        <p
          className="wrap-anywhere rounded-lg bg-muted/60 px-3 py-2 text-sm"
          data-slot="send-plan"
          aria-live="polite"
        >
          {plan}
        </p>
      )}
      <HandoffCopyActions>
        {justAdded ? null : linked ? (
          <Button
            disabled={busy || !machineLabel || sendKey === null}
            onClick={() => {
              if (sendKey === null) return;
              if (moving) onMove(sendKey);
              else onSync(sendKey);
            }}
          >
            {`${moving ? "Move" : "Copy"} to ${machineLabel ?? "machine"}`}
          </Button>
        ) : remoteUrl === null ? (
          <Button
            disabled={busy || !machineLabel || scope.loading}
            onClick={() => onPrepareRepositories(moving)}
          >
            {`${moving ? "Move" : "Copy"} to ${machineLabel ?? "machine"}…`}
          </Button>
        ) : way === "copy" ? (
          <Button disabled={busy || !machineLabel} onClick={() => onCopyInstead(moving)}>
            {`${moving ? "Move" : "Copy"} to ${machineLabel ?? "machine"}…`}
          </Button>
        ) : (
          // Wait for the nested-repository check and the folder check: either changes the plan.
          <Button
            disabled={
              busy || !machineLabel || !canClone || scope.loading || folder.state === "checking"
            }
            onClick={() => void add()}
          >
            {busy
              ? "Starting…"
              : `${moving ? "Move" : "Copy"} to ${machineLabel ?? "machine"}${folder.state === "choose" ? "…" : ""}`}
          </Button>
        )}
        <Button variant="outline" disabled={busy} onClick={onClose}>
          {justAdded ? "Close" : "Cancel"}
        </Button>
      </HandoffCopyActions>
    </div>
  );
}

/** One way to put the project there: a short line, and the rest in a hint. */
function ShareChoice({
  value,
  label,
  line,
  help,
  disabled = false,
}: {
  readonly value: "clone" | "copy";
  readonly label: string;
  readonly line: string;
  readonly help: string;
  readonly disabled?: boolean;
}) {
  return (
    <div
      className={`flex min-w-0 items-start gap-3 text-sm ${disabled ? "opacity-60" : ""}`}
      data-share-choice={value}
    >
      <label
        className={`flex min-w-0 flex-1 items-start gap-3 ${disabled ? "cursor-not-allowed" : "cursor-pointer"}`}
      >
        <span className="flex h-5 items-center">
          <Radio value={value} disabled={disabled} />
        </span>
        <span className="min-w-0 leading-5">
          <span className="block wrap-anywhere">{label}</span>
          <span className="block wrap-anywhere text-xs text-muted-foreground">{line}</span>
        </span>
      </label>
      <SettingHelp label={label}>{help}</SettingHelp>
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
      <span className="min-w-0 wrap-anywhere leading-5">{label}</span>
      <SettingHelp label={label}>{note}</SettingHelp>
    </label>
  );
}
