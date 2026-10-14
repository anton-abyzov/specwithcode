import { useId, useMemo, useState } from "react";
import type { EnvironmentProject } from "@specweave-studio/client-runtime/state/shell";
import type {
  ModelSelection,
  ProjectWorkspaceReadResult,
  ThreadId,
} from "@specweave-studio/contracts";
import {
  PERSONAL_ASSISTANT_LABEL,
  PROJECT_GOAL_MAX_LENGTH,
  PROJECT_INSTRUCTIONS_MAX_LENGTH,
  logicalProjectTitle,
} from "@specweave-studio/contracts";
import { squashAtomCommandFailure } from "@specweave-studio/client-runtime/state/runtime";
import { resolveCoordinatorModelSelection } from "@specweave-studio/shared/coordinatorDefault";
import { resolveProjectSettings } from "@specweave-studio/shared/projectSettings";
import { useEnvironment } from "../../state/environments";
import { projectEnvironment } from "../../state/projects";
import { useAtomCommand } from "../../state/use-atom-command";
import { Dialog, DialogPopup, DialogTitle, DialogDescription } from "../ui/dialog";
import { COORDINATOR_RECOMMENDED_TRAITS } from "../../studio/shellModel";
import { useStudioFleet } from "../../studio/fleet";
import { workerMachineChoices } from "../../studio/fleetWorkers";
import { ProjectModels } from "./ProjectModels";
import { ProjectMemory } from "./ProjectMemory";
import { ProjectUsage } from "./ProjectUsage";
import { ProjectRoutines } from "./ProjectRoutines";
import {
  FolderIcon,
  Settings2Icon,
  NotebookPenIcon,
  ChartNoAxesCombinedIcon,
  Clock3Icon,
} from "lucide-react";
import { ProjectLocation } from "./ProjectLocation";
import { ProjectEnvironment } from "./ProjectEnvironment";
import { ProjectConnections } from "./ProjectConnections";
import { useProjectIconEditor } from "./ProjectIconEditor";
import { ProjectFavicon } from "../ProjectFavicon";
import { CharacterCount } from "../ui/character-count";
import { ProviderLimitSettings } from "../settings/ProviderLimitSettings";
import { SettingsScopeProvider } from "../settings/SettingsScopeContext";
import { SettingsSection } from "../settings/settingsLayout";

export type ProjectSettingsTab = "general" | "memory" | "environment" | "usage" | "routines";
const tabs = ["general", "memory", "environment", "usage", "routines"] as const;
const tabIcons = {
  general: Settings2Icon,
  memory: NotebookPenIcon,
  environment: FolderIcon,
  usage: ChartNoAxesCombinedIcon,
  routines: Clock3Icon,
};
// The usage limit rows edit this project's overrides only; there is no scope picker here.
const keepProjectScope = () => {};
export function ProjectWorkspaceSettings({
  project,
  coordinatorThreadModel = null,
  iconCheckouts,
  projectKey,
  snapshot,
  initialTab,
  onClose,
  onSaved,
  onDeleted,
  onOpenThread,
  canOperate,
}: {
  project: EnvironmentProject;
  /** The model the project's coordinator thread runs on, once it has one. */
  coordinatorThreadModel?: ModelSelection | null;
  /** Every checkout of this project; an icon change applies to all of them. */
  iconCheckouts?: readonly EnvironmentProject[];
  projectKey: string;
  snapshot: ProjectWorkspaceReadResult;
  initialTab: ProjectSettingsTab;
  onClose: () => void;
  onSaved: () => void;
  onDeleted: () => void;
  onOpenThread: (id: ThreadId) => void;
  canOperate: boolean;
}) {
  const countId = useId();
  const [tab, setTab] = useState(initialTab);
  const limitScope = useMemo(() => ({ project: projectKey }), [projectKey]);
  const projectTitle = logicalProjectTitle(project);
  const [title, setTitle] = useState(projectTitle);
  const [titleEdited, setTitleEdited] = useState(false);
  const ownsName =
    !project.workspaceSettings?.logicalProject ||
    project.workspaceSettings.coordinatorBinding?.state === "active";
  const [goal, setGoal] = useState(snapshot.settings.goal);
  const [instructions, setInstructions] = useState(snapshot.settings.instructions);
  const [coordinator, setCoordinator] = useState<ModelSelection | null>(
    snapshot.settings.coordinatorModelSelection,
  );
  const [worker, setWorker] = useState<ModelSelection | null>(project.defaultModelSelection);
  const [environment, setEnvironment] = useState(
    snapshot.settings.environment ?? { additionalFolders: [], repositories: [] },
  );
  const [autoResume, setAutoResume] = useState(snapshot.settings.autoResume);
  const [workerMachine, setWorkerMachine] = useState(snapshot.settings.workerMachine ?? null);
  const fleet = useStudioFleet(project.environmentId);
  const machineChoices = workerMachineChoices(fleet.snapshot, project.environmentId, workerMachine);
  const [baseRevision, setBaseRevision] = useState(snapshot.settings.revision);
  const [dirty, setDirty] = useState(false);
  const [environmentDraftDirty, setEnvironmentDraftDirty] = useState(false);
  const [connectionDirty, setConnectionDirty] = useState(false);
  const [environmentBusy, setEnvironmentBusy] = useState(false);
  const [memoryDirty, setMemoryDirty] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [confirmation, setConfirmation] = useState("");
  const [closeWarning, setCloseWarning] = useState(false);
  const hostConfig = useEnvironment(project.environmentId)?.serverConfig;
  // What the coordinator runs on while no override is saved, in the same order as the
  // project view, so both name the same model; shown so the picker is never blank.
  const inheritedCoordinator = resolveCoordinatorModelSelection({
    coordinatorThreadModel,
    projectDefault: worker,
    scopedDefault: hostConfig?.settings
      ? resolveProjectSettings(hostConfig.settings, project.id, project).settings
          .defaultModelSelection
      : null,
    providers: hostConfig?.providers,
  });
  const update = useAtomCommand(projectEnvironment.update);
  const remove = useAtomCommand(projectEnvironment.delete);
  const disabled = !canOperate || busy || environmentBusy;
  const icon = useProjectIconEditor({
    project,
    ...(iconCheckouts ? { checkouts: iconCheckouts } : {}),
    disabled: !canOperate,
  });
  const change = <T,>(set: (v: T) => void, v: T) => {
    set(v);
    setDirty(true);
  };
  function failure(result: Parameters<typeof squashAtomCommandFailure>[0]) {
    const e = squashAtomCommandFailure(result);
    setError(
      e instanceof Error
        ? e.message
        : "Change rejected. Reload the project and try again; your draft is preserved.",
    );
  }
  async function save() {
    if (disabled) return;
    if (titleEdited && title.trim() !== projectTitle && !ownsName) {
      setError(
        "Open the active coordinator to rename this project. This checkout does not own its name.",
      );
      return;
    }
    setBusy(true);
    setError(null);
    const result = await update({
      environmentId: project.environmentId,
      input: {
        projectId: project.id,
        ...(titleEdited && ownsName ? { title: title.trim() } : {}),
        defaultModelSelection: worker,
        workspaceSettings: {
          expectedRevision: baseRevision,
          goal,
          instructions,
          coordinatorModelSelection: coordinator,
          autoResume,
          environment,
          workerMachine,
        },
      },
    });
    setBusy(false);
    if (result._tag === "Failure") {
      failure(result);
      return;
    }
    setDirty(false);
    setTitleEdited(false);
    setBaseRevision(baseRevision + 1);
    onSaved();
  }
  async function lifecycle(kind: "paused" | "archived") {
    if (disabled) return;
    setBusy(true);
    setError(null);
    const result = await update({
      environmentId: project.environmentId,
      input: {
        projectId: project.id,
        workspaceSettings: {
          expectedRevision: snapshot.settings.revision,
          [kind]: !snapshot.settings[kind],
        },
      },
    });
    setBusy(false);
    if (result._tag === "Failure") {
      failure(result);
      return;
    }
    setBaseRevision(snapshot.settings.revision + 1);
    onSaved();
  }
  async function deleteProject() {
    if (disabled || confirmation !== project.title) return;
    setBusy(true);
    setError(null);
    const result = await remove({
      environmentId: project.environmentId,
      input: { projectId: project.id, force: true, confirmationTitle: confirmation },
    });
    setBusy(false);
    if (result._tag === "Failure") {
      failure(result);
      return;
    }
    onDeleted();
  }
  return (
    <Dialog
      open
      onOpenChange={(open) => {
        if (!open && !environmentBusy) {
          if (dirty || memoryDirty || environmentDraftDirty || connectionDirty)
            setCloseWarning(true);
          else onClose();
        }
      }}
    >
      <DialogPopup
        className="h-[min(800px,90dvh)] w-[min(1000px,calc(100vw-32px))] max-w-none overflow-hidden max-[760px]:h-[94dvh]"
        bottomStickOnMobile={false}
      >
        <div className="project-surface project-settings-dialog">
          <header className="project-settings-heading">
            <DialogTitle className="text-lg font-semibold tracking-tight">
              Project settings
            </DialogTitle>
            <DialogDescription className="project-settings-identity" title={projectTitle}>
              {projectTitle}
            </DialogDescription>
            {snapshot.settings.kind === "personal" ? (
              <p className="project-muted text-xs">{PERSONAL_ASSISTANT_LABEL}</p>
            ) : (
              <ProjectLocation path={project.workspaceRoot} />
            )}
          </header>
          <div className="project-settings-layout">
            <nav aria-label="Project settings sections">
              {tabs.map((t) => {
                const Icon = tabIcons[t];
                return (
                  <button
                    className="project-control"
                    key={t}
                    aria-current={tab === t ? "page" : undefined}
                    onClick={() => setTab(t)}
                  >
                    <Icon size={16} aria-hidden="true" />
                    <span>
                      {t[0]?.toUpperCase()}
                      {t.slice(1)}
                    </span>
                  </button>
                );
              })}
            </nav>
            <div className="project-settings-body">
              {!canOperate && (
                <p className="project-notice">
                  Read-only connection. Reconnect with permission to edit this project.
                </p>
              )}
              {error && (
                <p className="project-notice" role="alert">
                  {error}
                </p>
              )}
              {tab === "general" && (
                <section className="project-settings-section">
                  <h2>General</h2>
                  <div className="project-name-field">
                    <label htmlFor="project-settings-name">Name and icon</label>
                    <div className="project-name-control">
                      {icon.iconPicker(
                        <button
                          type="button"
                          className="project-name-icon"
                          aria-label={`Change the icon for ${projectTitle}`}
                          disabled={icon.blocked !== null || !canOperate}
                        >
                          <ProjectFavicon project={project} className="size-5" />
                        </button>,
                        "Change icon",
                      )}
                      <input
                        id="project-settings-name"
                        value={title}
                        disabled={disabled}
                        onChange={(e) => {
                          setTitleEdited(true);
                          change(setTitle, e.target.value);
                        }}
                      />
                    </div>
                    {icon.blocked ? <p className="project-muted">{icon.blocked}</p> : null}
                  </div>
                  <label>
                    Goal
                    <textarea
                      rows={4}
                      maxLength={PROJECT_GOAL_MAX_LENGTH}
                      aria-describedby={`${countId}-goal`}
                      value={goal}
                      disabled={disabled}
                      onChange={(e) => change(setGoal, e.target.value)}
                      placeholder="The outcome this project is working toward."
                    />
                    <CharacterCount
                      id={`${countId}-goal`}
                      value={goal}
                      max={PROJECT_GOAL_MAX_LENGTH}
                    />
                  </label>
                  <ProjectModels
                    environmentId={project.environmentId}
                    label="Coordinator model and effort"
                    recommendedTraits={COORDINATOR_RECOMMENDED_TRAITS}
                    value={coordinator ?? inheritedCoordinator}
                    onChange={(v) => change(setCoordinator, v)}
                    disabled={disabled}
                  />
                  <p className="project-muted">
                    {coordinator
                      ? "The coordinator runs on this model."
                      : "No override saved: an existing coordinator keeps its thread model, and a new one starts on the default worker model, then the Settings > Defaults model or, without either, this host's default (Opus 5.5 on a Claude subscription when it is signed in). Pick a model to pin it."}
                  </p>
                  <ProjectModels
                    environmentId={project.environmentId}
                    label="Default worker model and effort"
                    value={worker}
                    onChange={(v) => change(setWorker, v)}
                    disabled={disabled}
                  />
                  {machineChoices.length > 1 || workerMachine ? (
                    <label>
                      Worker machine
                      <select
                        value={workerMachine?.machineId ?? "local"}
                        disabled={disabled}
                        onChange={(e) =>
                          change(
                            setWorkerMachine,
                            machineChoices.find((choice) => choice.value === e.target.value)
                              ?.machine ?? null,
                          )
                        }
                      >
                        {machineChoices.map((choice) => (
                          <option
                            key={choice.value}
                            value={choice.value}
                            disabled={choice.disabled}
                          >
                            {choice.label}
                          </option>
                        ))}
                      </select>
                      <span className="project-muted">
                        The coordinator starts this project's workers there, in the same repository,
                        and hears back when each one finishes. It can still run one here when you
                        ask.
                      </span>
                    </label>
                  ) : null}
                  <label className="project-checkbox">
                    <input
                      type="checkbox"
                      checked={autoResume}
                      disabled={disabled}
                      onChange={(e) => change(setAutoResume, e.target.checked)}
                    />
                    Automatically arm recovery for new usage-limit stops in this project
                  </label>
                  <p className="project-muted">
                    Native providers own quota recovery. Already armed threads keep their recovery
                    controls. This never changes accounts or enables paid overage.
                  </p>
                  <SettingsScopeProvider search={limitScope} onChange={keepProjectScope}>
                    <SettingsSection id="project-provider-limits" title="Usage limits">
                      <ProviderLimitSettings />
                    </SettingsSection>
                  </SettingsScopeProvider>
                  <div className="project-setting-row">
                    <div>
                      <h3>{snapshot.settings.paused ? "Resume project" : "Pause new work"}</h3>
                      <p className="project-muted">
                        Blocks new coordinator and routine dispatch. Running native turns retain
                        their existing controls.
                      </p>
                    </div>
                    <button
                      className="project-control"
                      disabled={disabled || dirty}
                      onClick={() => void lifecycle("paused")}
                    >
                      {snapshot.settings.paused ? "Resume" : "Pause"}
                    </button>
                  </div>
                  <div className="project-setting-row">
                    <div>
                      <h3>
                        {snapshot.settings.archived ? "Unarchive project" : "Archive project"}
                      </h3>
                      <p className="project-muted">
                        Stops admission of new work; history remains available. Running threads are
                        preserved.
                      </p>
                    </div>
                    <button
                      className="project-control"
                      disabled={disabled || dirty}
                      onClick={() => void lifecycle("archived")}
                    >
                      {snapshot.settings.archived ? "Unarchive" : "Archive"}
                    </button>
                  </div>
                  <section className="project-danger-zone">
                    <h3>Danger zone</h3>
                    <h4>Delete project</h4>
                    <p>
                      Permanently delete this project and all of its threads. This cannot be undone.
                    </p>
                    <p className="project-muted">
                      Project memory, plans, and routines are removed. Your source folders and
                      remote Git branches stay intact. Active work must stop first.
                    </p>
                    <label>
                      Type {project.title} to confirm
                      <input
                        aria-label="Confirm project deletion"
                        autoComplete="off"
                        value={confirmation}
                        onChange={(e) => setConfirmation(e.target.value)}
                        disabled={disabled}
                      />
                    </label>
                    <button
                      className="project-control project-danger"
                      disabled={
                        disabled ||
                        dirty ||
                        memoryDirty ||
                        environmentDraftDirty ||
                        connectionDirty ||
                        confirmation !== project.title
                      }
                      onClick={() => void deleteProject()}
                    >
                      Delete project and threads
                    </button>
                  </section>
                </section>
              )}
              <div hidden={tab !== "memory"}>
                <section className="project-settings-section">
                  <h2>Project instructions</h2>
                  <p className="project-muted">
                    Standing context supplied to coordinator turns. Native thread histories and
                    compaction stay with each provider.
                  </p>
                  <textarea
                    aria-label="Project instructions"
                    rows={6}
                    maxLength={PROJECT_INSTRUCTIONS_MAX_LENGTH}
                    aria-describedby={`${countId}-instructions`}
                    value={instructions}
                    disabled={disabled}
                    onChange={(e) => change(setInstructions, e.target.value)}
                  />
                  <CharacterCount
                    id={`${countId}-instructions`}
                    className="mt-1.5"
                    value={instructions}
                    max={PROJECT_INSTRUCTIONS_MAX_LENGTH}
                  />
                </section>
                <ProjectMemory
                  environmentId={project.environmentId}
                  projectId={project.id}
                  memory={snapshot.memory}
                  disabled={disabled}
                  onSaved={onSaved}
                  onDirtyChange={setMemoryDirty}
                />
              </div>
              <div hidden={tab !== "environment"}>
                <ProjectEnvironment
                  project={project}
                  projectKey={projectKey}
                  kind={snapshot.settings.kind ?? "code"}
                  value={environment}
                  revision={baseRevision}
                  dirty={dirty}
                  navigationBlocked={
                    disabled || dirty || memoryDirty || environmentDraftDirty || connectionDirty
                  }
                  disabled={disabled}
                  admissionBlocked={snapshot.settings.paused || snapshot.settings.archived}
                  onChange={(v) => change(setEnvironment, v)}
                  onPrepared={(revision, value) => {
                    setBaseRevision(revision);
                    setEnvironment(value);
                    onSaved();
                  }}
                  onDraftChange={setEnvironmentDraftDirty}
                  onBusyChange={setEnvironmentBusy}
                />
                <ProjectConnections
                  environmentId={project.environmentId}
                  projectId={project.id}
                  disabled={disabled}
                  admissionBlocked={snapshot.settings.paused || snapshot.settings.archived}
                  onDirtyChange={setConnectionDirty}
                  onBusyChange={setEnvironmentBusy}
                />
              </div>
              {tab === "usage" && (
                <ProjectUsage
                  environmentId={project.environmentId}
                  projectId={project.id}
                  onOpenThread={(id) => {
                    if (dirty || memoryDirty || environmentDraftDirty || connectionDirty) {
                      setCloseWarning(true);
                      return;
                    }
                    onClose();
                    onOpenThread(id);
                  }}
                />
              )}
              {tab === "routines" && (
                <ProjectRoutines
                  environmentId={project.environmentId}
                  projectId={project.id}
                  projectKey={projectKey}
                  canOperate={!disabled}
                  admissionBlocked={snapshot.settings.paused || snapshot.settings.archived}
                />
              )}
            </div>
          </div>
          {dirty && (
            <footer className="project-settings-footer">
              <span>Unsaved project settings</span>
              <button
                className="project-control"
                disabled={busy}
                onClick={() => {
                  setTitle(projectTitle);
                  setTitleEdited(false);
                  setGoal(snapshot.settings.goal);
                  setInstructions(snapshot.settings.instructions);
                  setCoordinator(snapshot.settings.coordinatorModelSelection);
                  setWorker(project.defaultModelSelection);
                  setAutoResume(snapshot.settings.autoResume);
                  setEnvironment(
                    snapshot.settings.environment ?? { additionalFolders: [], repositories: [] },
                  );
                  setBaseRevision(snapshot.settings.revision);
                  setDirty(false);
                  setError(null);
                }}
              >
                Discard
              </button>
              <button
                className="project-control project-primary"
                disabled={disabled || !title.trim()}
                onClick={() => void save()}
              >
                Save changes
              </button>
            </footer>
          )}
          {closeWarning && (
            <div className="project-notice" role="alert">
              <p>Project settings or memory have unsaved changes.</p>
              <button className="project-control" onClick={() => setCloseWarning(false)}>
                Keep editing
              </button>
              <button className="project-control" onClick={onClose}>
                Discard and close
              </button>
            </div>
          )}
        </div>
        {icon.dialogs}
      </DialogPopup>
    </Dialog>
  );
}
