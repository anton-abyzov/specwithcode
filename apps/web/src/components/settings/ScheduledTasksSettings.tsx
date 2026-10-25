import { useAtomValue } from "@effect/atom-react";
import { Clock3Icon, CopyIcon, PlusIcon } from "lucide-react";
import { type ReactNode, useCallback, useEffect, useMemo, useRef, useState } from "react";
import type {
  EnvironmentId,
  ModelSelection,
  OrchestrationV2ThreadLaunchWorkspaceStrategy,
  ProjectId,
  ScheduledTask,
  ScheduledTaskId,
  ScheduledTaskSchedule,
  ScheduledTaskUpsertInput,
  ThreadId,
} from "@specweave-studio/contracts";
import { DEFAULT_WEBHOOK_PROMPT } from "@specweave-studio/client-runtime/scheduled-task-webhook";
import {
  MAX_WEBHOOK_DELIVERY_AGE_MINUTES,
  MIN_SCHEDULED_TASK_INTERVAL_MS,
  ProviderInstanceId,
  resolveEnvironmentMachineKind,
} from "@specweave-studio/contracts";
import {
  isAtomCommandInterrupted,
  squashAtomCommandFailure,
} from "@specweave-studio/client-runtime/state/runtime";

import { useEnvironmentSettings } from "../../hooks/useSettings";
import { getCustomModelOptionsByInstance } from "../../modelSelection";
import {
  applyProviderInstanceSettings,
  deriveProviderInstanceEntries,
  sortProviderInstanceEntries,
} from "../../providerInstances";
import { usePrimaryCloudLinkState } from "../../cloud/primaryCloudLinkState";
import { requestConfirmDialog } from "../../confirmDialog";
import { webhookAddress } from "@specweave-studio/client-runtime/webhook-address";
import { Link, useLocation, useNavigate } from "@tanstack/react-router";
import { useCopyToClipboard } from "../../hooks/useCopyToClipboard";
import {
  useEnvironment,
  useEnvironmentHttpBaseUrl,
  type EnvironmentPresentation,
} from "../../state/environments";
import { useProjects, useServerConfigs } from "../../state/entities";
import {
  ineligibleProjectLabel,
  ineligibleSelectedMember,
  isArchivedMember,
  projectPickerMembers,
} from "../../studio/projectListVisibility";
import { useEnvironmentQuery } from "../../state/query";
import { EMPTY_SERVER_PROVIDERS, serverEnvironment } from "../../state/server";
import { useAtomCommand } from "../../state/use-atom-command";
import { WorktreeBaseBranchPicker } from "../WorktreeBaseBranchPicker";
import { EnvironmentMachineIcon } from "../EnvironmentMachineIcon";
import { AuthOrchestrationOperateScope } from "@specweave-studio/contracts";
import { readEnvironmentScope } from "~/state/session";
import { useSettingsScope } from "./SettingsScopeContext";
import {
  WEBHOOK_SIGNATURE_DEFAULTS,
  defaultOnceAt,
  matchesScheduledTaskScope,
  onceAtIso,
  MORNING_BRIEFING_TEMPLATE,
  NEW_ROUTINE_TEMPLATE,
  relativeLabel,
  morningBriefingDraft,
  scheduledTaskEditorCloseHref,
  scheduleFromDraft,
  scheduledTaskDefaultModel,
  taskToDraft,
  type DraftState,
  type ScheduleMode,
  type WorkspaceMode,
} from "./scheduledTasksSettings.logic";
import { Label } from "../ui/label";
import { ToggleGroup, Toggle } from "../ui/toggle-group";
import { Empty, EmptyHeader, EmptyTitle, EmptyDescription, EmptyMedia } from "../ui/empty";
import { ProviderModelPicker } from "../chat/ProviderModelPicker";
import { Button } from "../ui/button";
import {
  Dialog,
  DialogClose,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogPanel,
  DialogPopup,
  DialogTitle,
} from "../ui/dialog";
import { Input } from "../ui/input";
import { Select, SelectItem, SelectPopup, SelectTrigger, SelectValue } from "../ui/select";
import { Switch } from "../ui/switch";
import { Textarea } from "../ui/textarea";
import { stackedThreadToast, toastManager } from "../ui/toast";
import {
  SettingsPageContainer,
  SettingsRow,
  SettingsSection,
  SETTINGS_PICKER_TRIGGER_CLASSNAME,
  useRelativeTimeTick,
} from "./settingsLayout";
import { ArchivedDisclosure } from "./ArchivedDisclosure";
import { ScheduledTaskRow } from "./ScheduledTaskRow";
import { routineCadenceLabel } from "@specweave-studio/shared/routineBrief";

/** JS day-of-week (0 = Sunday) rendered Monday-first, matching how people read a week. */
const WEEKDAY_ORDER = [1, 2, 3, 4, 5, 6, 0] as const;
const WEEKDAY_LABELS = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"] as const;
const WEEKDAY_SHORT = ["Su", "Mo", "Tu", "We", "Th", "Fr", "Sa"] as const;

const WORKSPACE_MODE_LABELS: Record<WorkspaceMode, string> = {
  worktree: "Create a new worktree",
  root: "Use the project checkout",
  existing_worktree: "Use a specific checkout",
};

const EMPTY_DRAFT: DraftState = {
  editingId: null,
  title: "",
  prompt: "",
  enabled: true,
  scheduleMode: "fixed",
  intervalMinutes: "15",
  timeOfDay: "09:00",
  weekdays: new Set([1, 2, 3, 4, 5]),
  projectId: "",
  threadId: "",
  ownThread: true,
  workspaceMode: "worktree",
  baseRef: "main",
  startFromOrigin: true,
  existingWorktreePath: "",
  modelKey: "",
  modelPinned: false,
  runtimeMode: "full-access",
  interactionMode: "default",
  baseModelSelection: null,
  signatureEnabled: false,
  ...WEBHOOK_SIGNATURE_DEFAULTS,
  signatureSecret: "",
  maxDeliveryAgeMinutes: "",
};

/** Labelled field: a caption sitting above its control. */
function Field({
  label,
  hint,
  htmlFor,
  children,
}: {
  label: string;
  hint?: string;
  htmlFor?: string;
  children: ReactNode;
}) {
  return (
    <div className="space-y-1.5">
      <Label className="flex items-baseline justify-between" htmlFor={htmlFor}>
        <span>{label}</span>
        {hint ? <span className="font-normal text-2xs text-muted-foreground">{hint}</span> : null}
      </Label>
      {children}
    </div>
  );
}

function splitModelKey(value: string): ModelSelection | null {
  const index = value.indexOf(":");
  if (index <= 0 || index === value.length - 1) return null;
  return {
    instanceId: ProviderInstanceId.make(value.slice(0, index)),
    model: value.slice(index + 1),
  };
}

export { relativeLabel };
export const scheduleLabel = (schedule: ScheduledTaskSchedule): string =>
  routineCadenceLabel(schedule);

export function ScheduledTasksSettings(target: {
  readonly environmentId?: EnvironmentId;
  readonly taskId?: ScheduledTaskId | undefined;
  readonly template?: typeof MORNING_BRIEFING_TEMPLATE | typeof NEW_ROUTINE_TEMPLATE | undefined;
  readonly projectId?: ProjectId | undefined;
  readonly returnTo?: string | undefined;
}) {
  const navigate = useNavigate();
  const href = useLocation({ select: (location) => location.href });
  const { scope, environments, connectedEnvironments, environment } = useSettingsScope();
  const [editor, setEditor] = useState<{
    environmentId: EnvironmentId;
    task: ScheduledTask | null;
    preset?: DraftState;
  } | null>(null);
  const openForEdit = useCallback((environmentId: EnvironmentId, task: ScheduledTask) => {
    setEditor({ environmentId, task });
  }, []);
  const defaultEnvironment = environment ?? connectedEnvironments[0];
  // A template link opens a prefilled editor once; the person still picks the model and saves.
  const allProjects = useProjects();
  const templateProject =
    target.template !== undefined
      ? allProjects.find((project) => project.id === target.projectId)
      : undefined;
  const templateEditor =
    templateProject === undefined
      ? null
      : target.template === NEW_ROUTINE_TEMPLATE
        ? {
            environmentId: templateProject.environmentId,
            task: null,
            preset: { ...EMPTY_DRAFT, projectId: templateProject.id },
          }
        : {
            environmentId: templateProject.environmentId,
            task: null,
            preset: morningBriefingDraft(EMPTY_DRAFT, {
              id: templateProject.id,
              coordinatorModelSelection:
                templateProject.workspaceSettings?.coordinatorModelSelection ?? null,
            }),
          };
  const activeEditor = editor ?? templateEditor;
  const canCreate = useAtomValue(
    serverEnvironment.upsertScheduledTask.permissionAtom(defaultEnvironment?.environmentId ?? null),
  );
  return (
    <SettingsPageContainer>
      <SettingsSection
        title="Routines"
        variant="plain"
        headerAction={
          <Button
            size="xs"
            variant="ghost-muted"
            disabled={!defaultEnvironment || !canCreate}
            onClick={() =>
              defaultEnvironment &&
              setEditor({ environmentId: defaultEnvironment.environmentId, task: null })
            }
          >
            <PlusIcon className="size-3" />
            New routine
          </Button>
        }
      >
        {scope.kind === "unavailable" ? (
          <SettingsSection title="Unavailable selection">
            <SettingsRow title={scope.message} />
          </SettingsSection>
        ) : environments.length === 0 ? (
          <Empty>
            <EmptyHeader>
              <EmptyMedia variant="icon">
                <Clock3Icon />
              </EmptyMedia>
              <EmptyTitle>No environments available</EmptyTitle>
              <EmptyDescription>Connect an environment to manage scheduled tasks.</EmptyDescription>
            </EmptyHeader>
          </Empty>
        ) : (
          <div className="space-y-8">
            {environments.map((entry) => (
              <ScheduledTaskEnvironmentSection
                key={`${entry.environmentId}:${target.taskId ?? ""}`}
                environment={entry}
                showEnvironmentHeading={environments.length > 1}
                taskId={
                  (target.environmentId ?? defaultEnvironment?.environmentId) ===
                  entry.environmentId
                    ? target.taskId
                    : undefined
                }
                onEdit={openForEdit}
              />
            ))}
          </div>
        )}
      </SettingsSection>
      {activeEditor ? (
        <ScheduledTaskEditorDialog
          key={`${activeEditor.environmentId}:${activeEditor.task?.id ?? "new"}`}
          initialEnvironmentId={activeEditor.environmentId}
          task={activeEditor.task}
          preset={activeEditor.preset ?? null}
          onClose={(outcome) => {
            setEditor(null);
            if (
              (editor === null && templateEditor) ||
              (target.taskId && editor?.task?.id === target.taskId)
            ) {
              void navigate({
                href: scheduledTaskEditorCloseHref(href, target.returnTo, outcome),
                replace: true,
              });
            }
          }}
        />
      ) : null}
    </SettingsPageContainer>
  );
}

function ScheduledTaskEnvironmentSection({
  environment,
  showEnvironmentHeading,
  taskId,
  onEdit,
}: {
  readonly environment: EnvironmentPresentation;
  readonly showEnvironmentHeading: boolean;
  readonly taskId?: ScheduledTaskId | undefined;
  readonly onEdit: (environmentId: EnvironmentId, task: ScheduledTask) => void;
}) {
  const { scope } = useSettingsScope();
  const connected =
    environment.connection.phase === "connected" && environment.serverConfig !== null;
  const tasksQuery = useEnvironmentQuery(
    connected
      ? serverEnvironment.scheduledTasksLive({
          environmentId: environment.environmentId,
          input: {},
        })
      : null,
  );
  const tasks = tasksQuery.data?.tasks.filter((task) =>
    matchesScheduledTaskScope(scope, environment.environmentId, task.projectId),
  );
  const linkedTask = tasks?.find((task) => task.id === taskId);
  const projects = useProjects();
  const archivedProjectIds = new Set(
    projects
      .filter(
        (project) =>
          project.environmentId === environment.environmentId && isArchivedMember(project),
      )
      .map((project) => project.id),
  );
  // A linked task stays in the main list so the deep link still lands on a visible row.
  const isArchivedTask = (task: ScheduledTask) =>
    task.projectId != null && archivedProjectIds.has(task.projectId) && task.id !== taskId;
  const activeTasks = tasks?.filter((task) => !isArchivedTask(task)) ?? [];
  const archivedTasks = tasks?.filter(isArchivedTask) ?? [];
  // A list across projects names each routine's project; a project's own list does not.
  const projectTitles =
    scope.kind === "project" || scope.kind === "checkout"
      ? null
      : new Map(
          projects
            .filter((project) => project.environmentId === environment.environmentId)
            .map((project) => [project.id, project.title] as const),
        );
  const renderTask = (task: ScheduledTask) => (
    <ScheduledTaskRow
      key={task.id}
      environmentId={environment.environmentId}
      task={task}
      projectLabel={projectTitles?.get(task.projectId) ?? null}
      onEdit={() => onEdit(environment.environmentId, task)}
    />
  );
  const openedLink = useRef(false);
  useEffect(() => {
    if (!openedLink.current && linkedTask) {
      openedLink.current = true;
      onEdit(environment.environmentId, linkedTask);
    }
  }, [environment.environmentId, linkedTask, onEdit]);
  useRelativeTimeTick(60_000);
  return (
    <SettingsSection
      title={environment.label}
      hideTitle={!showEnvironmentHeading}
      icon={
        <EnvironmentMachineIcon
          kind={resolveEnvironmentMachineKind(environment.serverConfig)}
          className="size-3.5"
        />
      }
    >
      {!connected ? (
        <SettingsRow
          title="Environment disconnected"
          description={`Reconnect ${environment.label} to view its scheduled tasks.`}
        />
      ) : tasksQuery.error ? (
        <SettingsRow title="Could not load scheduled tasks" description={tasksQuery.error} />
      ) : !tasks ? (
        <SettingsRow title="Loading scheduled tasks…" role="status" />
      ) : (
        <>
          {taskId && !linkedTask ? (
            <SettingsRow
              title="Task unavailable"
              description="This task no longer exists or is outside the selected project scope."
              role="status"
            />
          ) : null}
          {tasks.length === 0 ? (
            <SettingsRow
              title="No scheduled tasks"
              description="No tasks match this environment and project selection."
            />
          ) : (
            <>
              {activeTasks.map(renderTask)}
              {activeTasks.length === 0 ? (
                <SettingsRow
                  title="No scheduled tasks for active projects"
                  description="Every task here belongs to an archived project."
                />
              ) : null}
              <ArchivedDisclosure count={archivedTasks.length}>
                {archivedTasks.map(renderTask)}
              </ArchivedDisclosure>
            </>
          )}
        </>
      )}
    </SettingsSection>
  );
}

function WebhookEndpointField({
  environmentId,
  task,
}: {
  readonly environmentId: EnvironmentId;
  readonly task: ScheduledTask | null;
}) {
  const canRotate = useAtomValue(
    serverEnvironment.rotateScheduledTaskWebhookToken.permissionAtom(environmentId),
  );
  const httpBaseUrl = useEnvironmentHttpBaseUrl(environmentId);
  const { copyToClipboard, isCopied } = useCopyToClipboard({ target: "webhook URL" });
  const rotate = useAtomCommand(serverEnvironment.rotateScheduledTaskWebhookToken, {
    label: "scheduled task rotate webhook token",
  });
  const [rotating, setRotating] = useState(false);
  const endpoint = task?.webhook;
  if (!task || !endpoint) {
    return <p className="text-sm text-muted-foreground">The URL appears after you save.</p>;
  }
  const { address: url, copyable, note } = webhookAddress(endpoint, httpBaseUrl);
  const rotateUrl = async () => {
    const confirmed =
      (await requestConfirmDialog("Rotate this webhook URL?\nThe current URL stops working.", {
        variant: "destructive",
      })) ??
      // No themed dialog host is mounted; fall back to the native prompt
      // rather than rotating unasked.
      window.confirm("Rotate this webhook URL? The current URL stops working.");
    if (!confirmed) return;
    setRotating(true);
    const result = await rotate({ environmentId, input: { id: task.id } });
    setRotating(false);
    if (result._tag === "Failure" && !isAtomCommandInterrupted(result)) {
      toastManager.add(
        stackedThreadToast({
          type: "error",
          title: "Could not rotate webhook URL",
          description: String(squashAtomCommandFailure(result)),
        }),
      );
    }
  };
  return (
    <div className="space-y-1.5">
      <div className="flex items-center gap-2">
        <Input
          readOnly
          aria-label="Webhook URL"
          value={url}
          onFocus={(event) => event.currentTarget.select()}
        />
        <Button
          size="sm"
          variant="outline"
          type="button"
          // A bare path is not a URL a sender can call.
          disabled={!copyable}
          onClick={() => copyToClipboard(url, undefined)}
        >
          <CopyIcon />
          {isCopied ? "Copied" : "Copy"}
        </Button>
        <Button
          size="sm"
          variant="outline"
          type="button"
          disabled={rotating || !canRotate}
          onClick={() => void rotateUrl()}
        >
          Rotate
        </Button>
      </div>
      {note !== null ? <p className="text-xs text-muted-foreground">{note}</p> : null}
      {endpoint.url !== null ? <WebhookDeliveryMode environmentId={environmentId} /> : null}
    </div>
  );
}

/**
 * Whether Studio Connect forwards requests live or holds them while the
 * environment is offline. The setting is per environment and only readable
 * for this machine's own environment, so other environments show nothing.
 */
function WebhookDeliveryMode({ environmentId }: { readonly environmentId: EnvironmentId }) {
  const cloudLink = usePrimaryCloudLinkState();
  if (cloudLink.target?.environmentId !== environmentId || cloudLink.data === null) return null;
  return (
    <p className="text-xs text-muted-foreground">
      {cloudLink.data.holdWebhooksWhileOffline
        ? "Held for up to 24 hours while this environment is offline. "
        : "Forwarded live. Requests fail while this environment is offline. "}
      <Link to="/settings/connections" className="underline underline-offset-2">
        Change in Connections
      </Link>
    </p>
  );
}

function ScheduledTaskEditorDialog({
  initialEnvironmentId,
  task,
  preset = null,
  onClose,
}: {
  readonly initialEnvironmentId: EnvironmentId;
  readonly task: ScheduledTask | null;
  /** A new task's starting values, from a template link. */
  readonly preset?: DraftState | null;
  readonly onClose: (outcome: "dismissed" | "saved") => void;
}) {
  const { scope, connectedEnvironments } = useSettingsScope();
  const [environmentId, setEnvironmentId] = useState(initialEnvironmentId);
  const environment = useEnvironment(environmentId);
  const connected =
    environment?.connection.phase === "connected" && environment.serverConfig !== null;
  const tasksQuery = useEnvironmentQuery(
    connected ? serverEnvironment.scheduledTasksLive({ environmentId, input: {} }) : null,
  );
  const allProjects = useProjects();
  const configs = useServerConfigs();
  const scopedProjects = useMemo(
    () =>
      allProjects.filter(
        (project) =>
          project.environmentId === environmentId &&
          matchesScheduledTaskScope(scope, environmentId, project.id),
      ),
    [allProjects, environmentId, scope],
  );
  const scratchRootFor = useCallback(
    (id: EnvironmentId) => configs.get(id)?.scratchWorkspaceRoot ?? null,
    [configs],
  );
  // Only the person's own projects are choices. A task whose project was since archived or
  // made by a check shows it apart (unavailableProject below), and saving needs another.
  const projects = useMemo(
    () => projectPickerMembers(scopedProjects, scratchRootFor),
    [scopedProjects, scratchRootFor],
  );
  const settings = useEnvironmentSettings(environmentId);
  const providers =
    useAtomValue(serverEnvironment.providersValueAtom(environmentId)) ?? EMPTY_SERVER_PROVIDERS;
  const canOperate = useAtomValue(
    serverEnvironment.upsertScheduledTask.permissionAtom(environmentId),
  );
  const upsertTask = useAtomCommand(serverEnvironment.upsertScheduledTask, {
    label: "scheduled task upsert",
  });
  const instanceEntries = useMemo(
    () =>
      sortProviderInstanceEntries(
        applyProviderInstanceSettings(deriveProviderInstanceEntries(providers), settings),
      ),
    [providers, settings],
  );
  const [draft, setDraft] = useState<DraftState>(() =>
    task ? taskToDraft(task) : (preset ?? { ...EMPTY_DRAFT, projectId: projects[0]?.id ?? "" }),
  );
  const [saving, setSaving] = useState(false);
  const submissionPending = useRef(false);
  const editingTaskMissing =
    draft.editingId !== null &&
    tasksQuery.data !== null &&
    !tasksQuery.data.tasks.some((entry) => entry.id === draft.editingId);
  // The live row, so a rotated URL shows up without reopening the dialog.
  // Once the list has loaded, a missing task is gone; don't keep showing its URL.
  const liveTask = tasksQuery.data
    ? (tasksQuery.data.tasks.find((entry) => entry.id === draft.editingId) ?? null)
    : task;
  const selectedProjectId = draft.projectId || projects[0]?.id || "";
  const selectedProject = projects.find((project) => project.id === selectedProjectId);
  const unavailableProject = ineligibleSelectedMember(
    scopedProjects,
    selectedProjectId ? { environmentId, id: selectedProjectId as ProjectId } : null,
    scratchRootFor,
  );

  // The real model picker is keyed by a `${instanceId}:${model}` string, which
  // is exactly how the draft stores its selection.
  const firstInstance = instanceEntries[0];
  const activeSelection = draft.modelKey
    ? splitModelKey(draft.modelKey)
    : scheduledTaskDefaultModel(settings, selectedProject ?? null, instanceEntries);
  const activeInstanceId =
    activeSelection?.instanceId ?? firstInstance?.instanceId ?? ("" as ProviderInstanceId);
  const activeModel = activeSelection?.model ?? "";
  const modelOptionsByInstance = useMemo(
    () => getCustomModelOptionsByInstance(settings, providers, activeInstanceId, activeModel),
    [settings, providers, activeInstanceId, activeModel],
  );

  const reportFailure = (title: string, error: unknown) => {
    toastManager.add(
      stackedThreadToast({
        type: "error",
        title,
        description: error instanceof Error ? error.message : String(error),
      }),
    );
  };

  const submit = async () => {
    if (
      !readEnvironmentScope(environmentId, AuthOrchestrationOperateScope) ||
      submissionPending.current ||
      saving ||
      editingTaskMissing ||
      !connected ||
      tasksQuery.data === null
    )
      return;
    const selection = activeSelection;
    if (selection === null && !draft.modelPinned) {
      reportFailure(
        "No provider can run this task",
        "Install or sign in to a provider in Settings > Providers, then save again.",
      );
      return;
    }
    if (unavailableProject) {
      reportFailure(
        "Choose another project",
        `${unavailableProject.project.title}: ${ineligibleProjectLabel(unavailableProject.reason)}.`,
      );
      return;
    }
    if (
      !draft.title.trim() ||
      !draft.prompt.trim() ||
      !projects.some((project) => project.id === selectedProjectId) ||
      selection === null
    ) {
      reportFailure(
        "Scheduled task is incomplete",
        draft.modelPinned
          ? "Add a title, prompt, project, and model."
          : "Add a title, prompt, and project.",
      );
      return;
    }
    if (draft.scheduleMode === "once" && onceAtIso(draft.onceAt) === null) {
      reportFailure("Invalid time", "Pick the date and time to run it.");
      return;
    }
    const schedule = scheduleFromDraft(draft);
    if (schedule === null) {
      reportFailure(
        "Invalid age limit",
        `Enter whole minutes from 1 to ${MAX_WEBHOOK_DELIVERY_AGE_MINUTES}, or leave it blank.`,
      );
      return;
    }
    if (
      schedule.type === "webhook" &&
      schedule.signature &&
      (!schedule.signature.header ||
        (!schedule.signature.secret &&
          !(liveTask?.schedule.type === "webhook" && liveTask.webhook?.hasSecret)))
    ) {
      reportFailure("Signing secret is required", "Enter the signature header and secret.");
      return;
    }
    if (
      schedule.type === "interval" &&
      (!Number.isSafeInteger(schedule.everyMs) || schedule.everyMs < MIN_SCHEDULED_TASK_INTERVAL_MS)
    ) {
      reportFailure("Invalid interval", "Enter an interval of at least one minute.");
      return;
    }
    if (draft.workspaceMode === "existing_worktree" && !draft.existingWorktreePath.trim()) {
      reportFailure("Checkout path is required", "Enter the path of the checkout to run in.");
      return;
    }
    // Keep the original selection object (with provider options) when the
    // picker still points at the same instance+model.
    const modelSelection =
      draft.baseModelSelection !== null &&
      draft.baseModelSelection.instanceId === selection.instanceId &&
      draft.baseModelSelection.model === selection.model
        ? draft.baseModelSelection
        : selection;
    const workspaceStrategy: OrchestrationV2ThreadLaunchWorkspaceStrategy =
      draft.workspaceMode === "root"
        ? { type: "root" }
        : draft.workspaceMode === "existing_worktree"
          ? { type: "existing_worktree", worktreePath: draft.existingWorktreePath.trim() }
          : {
              type: "worktree",
              baseRef: draft.baseRef.trim() || "main",
              startFromOrigin: draft.startFromOrigin,
            };
    const input: ScheduledTaskUpsertInput = {
      ...(draft.editingId ? { id: draft.editingId as ScheduledTaskId, requireExisting: true } : {}),
      title: draft.title.trim(),
      prompt: draft.prompt.trim(),
      enabled: draft.enabled,
      schedule,
      projectId: selectedProjectId as ProjectId,
      threadId: draft.threadId ? (draft.threadId as ThreadId) : null,
      ...(draft.ownThread ? { ownThread: true } : {}),
      workspaceStrategy,
      modelSelection,
      modelPinned: draft.modelPinned,
      runtimeMode: draft.runtimeMode,
      interactionMode: draft.interactionMode,
      creationSource: "web",
    };
    // Lock before React renders, and keep successful creates locked until the form closes.
    submissionPending.current = true;
    setSaving(true);
    const result = await upsertTask({ environmentId, input });
    setSaving(false);
    if (result._tag === "Failure") {
      submissionPending.current = false;
      if (!isAtomCommandInterrupted(result)) {
        reportFailure("Could not save scheduled task", squashAtomCommandFailure(result));
      }
      return;
    }
    onClose("saved");
  };

  return (
    <Dialog
      open
      onOpenChange={(open) => {
        if (!open && !saving) onClose("dismissed");
      }}
    >
      <DialogPopup className="max-w-xl">
        <DialogHeader>
          <DialogTitle>{draft.editingId ? "Edit routine" : "New routine"}</DialogTitle>
          <DialogDescription>
            Run a prompt automatically — on an interval, at a fixed time, or when a webhook is
            called.
          </DialogDescription>
        </DialogHeader>

        <DialogPanel>
          <fieldset disabled={saving} className="space-y-5">
            {!connected ? (
              <p className="text-sm text-destructive-foreground">
                Reconnect this environment before saving.
              </p>
            ) : null}
            <Field label="Runs on" htmlFor="scheduled-task-environment">
              <Select
                value={environmentId}
                disabled={task !== null || saving}
                onValueChange={(id) => {
                  const next = connectedEnvironments.find((entry) => entry.environmentId === id);
                  if (!next) return;
                  setEnvironmentId(next.environmentId);
                  setDraft((current) => ({
                    ...current,
                    projectId: "",
                    modelKey: "",
                    baseModelSelection: null,
                    baseRef: "main",
                    startFromOrigin: true,
                    existingWorktreePath: "",
                  }));
                }}
              >
                <SelectTrigger id="scheduled-task-environment" size="sm">
                  <SelectValue>
                    <span className="flex items-center gap-2">
                      <EnvironmentMachineIcon
                        kind={resolveEnvironmentMachineKind(environment?.serverConfig ?? null)}
                        className="size-4"
                      />
                      {environment?.label ?? "Unavailable environment"}
                    </span>
                  </SelectValue>
                </SelectTrigger>
                <SelectPopup>
                  {connectedEnvironments.map((entry) => (
                    <SelectItem key={entry.environmentId} value={entry.environmentId}>
                      <EnvironmentMachineIcon
                        kind={resolveEnvironmentMachineKind(entry.serverConfig)}
                        className="size-4"
                      />
                      {entry.label}
                    </SelectItem>
                  ))}
                </SelectPopup>
              </Select>
            </Field>
            {tasksQuery.error ? (
              <p className="text-sm text-destructive-foreground" role="status">
                {tasksQuery.error}
              </p>
            ) : null}
            {editingTaskMissing ? (
              <p className="text-xs text-destructive-foreground" role="status">
                This scheduled task no longer exists.
              </p>
            ) : null}
            <Field label="Name" htmlFor="scheduled-task-title">
              <Input
                id="scheduled-task-title"
                placeholder="e.g. Check for Sentry issues"
                value={draft.title}
                onChange={(event) =>
                  setDraft((current) => ({ ...current, title: event.target.value }))
                }
              />
            </Field>

            <div className="grid gap-3 sm:grid-cols-2">
              <Field label="Project" htmlFor="scheduled-task-project">
                <Select
                  value={selectedProjectId}
                  onValueChange={(projectId) =>
                    setDraft((current) => ({
                      ...current,
                      projectId: projectId ?? "",
                      // A new routine's thread belongs to the project it was made for.
                      ...(current.editingId === null ? { threadId: "", ownThread: true } : {}),
                    }))
                  }
                >
                  <SelectTrigger size="sm" id="scheduled-task-project">
                    <SelectValue placeholder="Select a project">
                      {selectedProject?.title ?? unavailableProject?.project.title}
                    </SelectValue>
                  </SelectTrigger>
                  <SelectPopup>
                    {unavailableProject ? (
                      <SelectItem value={unavailableProject.project.id} disabled>
                        {unavailableProject.project.title}
                        <span className="ms-2 text-muted-foreground text-xs">
                          {ineligibleProjectLabel(unavailableProject.reason)}
                        </span>
                      </SelectItem>
                    ) : null}
                    {projects.map((project) => (
                      <SelectItem key={project.id} value={project.id}>
                        {project.title}
                      </SelectItem>
                    ))}
                  </SelectPopup>
                </Select>
              </Field>

              <Field label="Workspace" htmlFor="scheduled-task-workspace">
                <Select
                  value={draft.workspaceMode}
                  onValueChange={(value) =>
                    setDraft((current) => ({ ...current, workspaceMode: value as WorkspaceMode }))
                  }
                >
                  <SelectTrigger size="sm" id="scheduled-task-workspace">
                    <SelectValue>{WORKSPACE_MODE_LABELS[draft.workspaceMode]}</SelectValue>
                  </SelectTrigger>
                  <SelectPopup>
                    <SelectItem value="worktree">Create a new worktree</SelectItem>
                    <SelectItem value="root">Use the project checkout</SelectItem>
                    <SelectItem value="existing_worktree">Use a specific checkout</SelectItem>
                  </SelectPopup>
                </Select>
              </Field>
            </div>
            <p className="text-muted-foreground text-xs" data-routine-destination>
              {draft.ownThread
                ? draft.threadId
                  ? "Runs in its own thread, which keeps this routine's history apart from the coordinator."
                  : "Runs in a thread of its own, named after the routine: the first run starts it in this workspace and later runs continue it."
                : "Continues the worker thread it was set up from."}
            </p>

            {draft.workspaceMode === "worktree" ? (
              <Field label="Base branch" htmlFor="scheduled-task-base-ref">
                <WorktreeBaseBranchPicker
                  key={`${environmentId}:${selectedProjectId}`}
                  id="scheduled-task-base-ref"
                  environmentId={environmentId}
                  cwd={selectedProject?.workspaceRoot ?? null}
                  value={draft.baseRef}
                  onValueChange={(baseRef) => setDraft((current) => ({ ...current, baseRef }))}
                  startFromOrigin={draft.startFromOrigin}
                  onStartFromOriginChange={(startFromOrigin) =>
                    setDraft((current) => ({ ...current, startFromOrigin }))
                  }
                  disabled={saving || !connected}
                />
              </Field>
            ) : null}
            {draft.workspaceMode === "existing_worktree" ? (
              <Field label="Checkout path" htmlFor="scheduled-task-checkout">
                <Input
                  id="scheduled-task-checkout"
                  value={draft.existingWorktreePath}
                  placeholder="/path/to/checkout"
                  onChange={(event) =>
                    setDraft((current) => ({
                      ...current,
                      existingWorktreePath: event.target.value,
                    }))
                  }
                />
              </Field>
            ) : null}

            <Field label="Prompt" htmlFor="scheduled-task-prompt">
              <Textarea
                id="scheduled-task-prompt"
                className="max-h-64 overflow-y-auto"
                placeholder="What should the agent do each time this runs?"
                value={draft.prompt}
                onChange={(event) =>
                  setDraft((current) => ({ ...current, prompt: event.target.value }))
                }
              />
            </Field>

            <div className="space-y-3">
              <div className="flex items-center justify-between gap-4">
                <div className="min-w-0 space-y-1">
                  <Label htmlFor="scheduled-task-model-pinned">Use a specific model</Label>
                  <p className="text-sm text-muted-foreground">
                    {draft.modelPinned
                      ? "Every run uses this model."
                      : "The routine's thread starts on this model, then each run uses what its next turn would, switching to a provider with room when one runs out."}
                  </p>
                </div>
                <Switch
                  id="scheduled-task-model-pinned"
                  checked={draft.modelPinned}
                  disabled={saving || !connected}
                  onCheckedChange={(modelPinned) =>
                    setDraft((current) => ({ ...current, modelPinned }))
                  }
                />
              </div>
              {draft.modelPinned ? (
                <Field label="Model">
                  <ProviderModelPicker
                    disabled={saving || !connected}
                    activeInstanceId={activeInstanceId}
                    model={activeModel}
                    lockedProvider={null}
                    instanceEntries={instanceEntries}
                    modelOptionsByInstance={modelOptionsByInstance}
                    isComposerOwned={false}
                    triggerClassName={SETTINGS_PICKER_TRIGGER_CLASSNAME}
                    onInstanceModelChange={(instanceId, model) =>
                      setDraft((current) => ({ ...current, modelKey: `${instanceId}:${model}` }))
                    }
                  />
                </Field>
              ) : null}
            </div>

            <div className="space-y-3">
              {task?.schedule.type === "interval" &&
              task.schedule.everyMs < MIN_SCHEDULED_TASK_INTERVAL_MS ? (
                <p className="text-sm text-muted-foreground" role="status">
                  This task uses a legacy interval below one minute. Saving updates it to at least
                  one minute.
                </p>
              ) : null}
              <div className="flex items-center justify-between gap-2">
                <Label>Schedule</Label>
                <ToggleGroup
                  aria-label="Schedule type"
                  value={[draft.scheduleMode]}
                  onValueChange={(values) => {
                    const mode = values[0] as ScheduleMode | undefined;
                    if (
                      mode === "fixed" ||
                      mode === "interval" ||
                      mode === "webhook" ||
                      mode === "manual" ||
                      mode === "monthly" ||
                      mode === "once"
                    )
                      setDraft((current) => ({
                        ...current,
                        scheduleMode: mode,
                        onceAt: current.onceAt || defaultOnceAt(),
                        prompt:
                          mode === "webhook" && !current.prompt.trim()
                            ? DEFAULT_WEBHOOK_PROMPT
                            : current.prompt,
                      }));
                  }}
                >
                  <Toggle value="once">Once</Toggle>
                  <Toggle value="fixed">At a time</Toggle>
                  <Toggle value="interval">Every interval</Toggle>
                  <Toggle value="webhook">On webhook</Toggle>
                  <Toggle value="manual">When I ask</Toggle>
                  <Toggle value="monthly">Monthly</Toggle>
                </ToggleGroup>
              </div>

              {draft.scheduleMode === "webhook" ? (
                <div className="space-y-4">
                  <WebhookEndpointField environmentId={environmentId} task={liveTask} />
                  <p className="text-xs text-muted-foreground">
                    {
                      "Each request runs the prompt. Use {{body.path}}, {{headers.name}}, {{query.name}}, {{body}} or {{request}} in the prompt; only what it names reaches the agent."
                    }
                  </p>
                  <Field
                    label="Skip requests older than"
                    hint="minutes, optional"
                    htmlFor="scheduled-task-max-age"
                  >
                    <Input
                      id="scheduled-task-max-age"
                      type="number"
                      nativeInput
                      min={1}
                      max={MAX_WEBHOOK_DELIVERY_AGE_MINUTES}
                      placeholder="Run every request"
                      value={draft.maxDeliveryAgeMinutes}
                      onChange={(event) =>
                        setDraft((current) => ({
                          ...current,
                          maxDeliveryAgeMinutes: event.target.value,
                        }))
                      }
                    />
                  </Field>
                  <div className="flex items-center justify-between gap-4">
                    <div className="min-w-0 space-y-1">
                      <Label htmlFor="scheduled-task-signature">Require signature</Label>
                      <p className="text-sm text-muted-foreground">
                        Reject requests without a valid HMAC-SHA256 signature of the body.
                      </p>
                    </div>
                    <Switch
                      id="scheduled-task-signature"
                      checked={draft.signatureEnabled}
                      onCheckedChange={(signatureEnabled) =>
                        setDraft((current) => ({ ...current, signatureEnabled }))
                      }
                    />
                  </div>
                  {draft.signatureEnabled ? (
                    <div className="grid gap-3 sm:grid-cols-2">
                      <Field label="Header" htmlFor="scheduled-task-signature-header">
                        <Input
                          id="scheduled-task-signature-header"
                          value={draft.signatureHeader}
                          onChange={(event) =>
                            setDraft((current) => ({
                              ...current,
                              signatureHeader: event.target.value,
                            }))
                          }
                        />
                      </Field>
                      <Field label="Prefix" htmlFor="scheduled-task-signature-prefix">
                        <Input
                          id="scheduled-task-signature-prefix"
                          value={draft.signaturePrefix}
                          placeholder="None"
                          onChange={(event) =>
                            setDraft((current) => ({
                              ...current,
                              signaturePrefix: event.target.value,
                            }))
                          }
                        />
                      </Field>
                      <Field label="Encoding" htmlFor="scheduled-task-signature-encoding">
                        <Select
                          value={draft.signatureEncoding}
                          onValueChange={(value) =>
                            setDraft((current) => ({
                              ...current,
                              signatureEncoding: value === "base64" ? "base64" : "hex",
                            }))
                          }
                        >
                          <SelectTrigger size="sm" id="scheduled-task-signature-encoding">
                            <SelectValue>{draft.signatureEncoding}</SelectValue>
                          </SelectTrigger>
                          <SelectPopup>
                            <SelectItem value="hex">hex</SelectItem>
                            <SelectItem value="base64">base64</SelectItem>
                          </SelectPopup>
                        </Select>
                      </Field>
                      <Field label="Secret" htmlFor="scheduled-task-signature-secret">
                        <Input
                          id="scheduled-task-signature-secret"
                          type="password"
                          autoComplete="off"
                          value={draft.signatureSecret}
                          placeholder={
                            liveTask?.schedule.type === "webhook" && liveTask.webhook?.hasSecret
                              ? "Unchanged"
                              : "Shared secret"
                          }
                          onChange={(event) =>
                            setDraft((current) => ({
                              ...current,
                              signatureSecret: event.target.value,
                            }))
                          }
                        />
                      </Field>
                    </div>
                  ) : null}
                </div>
              ) : draft.scheduleMode === "manual" ? (
                <p className="text-sm text-muted-foreground">
                  Runs only when you press Run now, or an agent runs it for you.
                </p>
              ) : draft.scheduleMode === "once" ? (
                <div className="flex flex-wrap items-center gap-2">
                  <Label htmlFor="scheduled-task-once-at">Run once at</Label>
                  <Input
                    type="datetime-local"
                    id="scheduled-task-once-at"
                    nativeInput
                    className="w-56"
                    value={draft.onceAt ?? ""}
                    onChange={(event) =>
                      setDraft((current) => ({ ...current, onceAt: event.target.value }))
                    }
                  />
                  <span className="text-xs text-muted-foreground">then it turns off</span>
                </div>
              ) : draft.scheduleMode === "monthly" ? (
                <div className="flex flex-wrap items-center gap-2">
                  <Label htmlFor="scheduled-task-day">Day</Label>
                  <Input
                    type="number"
                    id="scheduled-task-day"
                    nativeInput
                    min={1}
                    max={28}
                    className="w-20"
                    value={String(draft.dayOfMonth ?? 1)}
                    onChange={(event) =>
                      setDraft((current) => ({
                        ...current,
                        dayOfMonth: Number(event.target.value) || 1,
                      }))
                    }
                  />
                  <Label htmlFor="scheduled-task-time">at</Label>
                  <Input
                    type="time"
                    id="scheduled-task-time"
                    nativeInput
                    className="w-32"
                    value={draft.timeOfDay}
                    onChange={(event) =>
                      setDraft((current) => ({ ...current, timeOfDay: event.target.value }))
                    }
                  />
                </div>
              ) : draft.scheduleMode === "fixed" ? (
                <div className="flex flex-wrap items-center gap-3">
                  <div className="flex items-center gap-2">
                    <Label htmlFor="scheduled-task-time">Run at</Label>
                    <Input
                      type="time"
                      id="scheduled-task-time"
                      nativeInput
                      className="w-32"
                      value={draft.timeOfDay}
                      onChange={(event) =>
                        setDraft((current) => ({ ...current, timeOfDay: event.target.value }))
                      }
                    />
                    <span className="text-xs text-muted-foreground">on</span>
                  </div>
                  <ToggleGroup
                    multiple
                    variant="outline"
                    size="sm"
                    aria-label="Days to run"
                    value={[...draft.weekdays].map(String)}
                    onValueChange={(values) => {
                      if (values.length === 0) return;
                      setDraft((current) => ({
                        ...current,
                        weekdays: new Set(values.map(Number)),
                      }));
                    }}
                  >
                    {WEEKDAY_ORDER.map((day) => (
                      <Toggle key={day} value={String(day)} aria-label={WEEKDAY_LABELS[day]}>
                        {WEEKDAY_SHORT[day]}
                      </Toggle>
                    ))}
                  </ToggleGroup>
                </div>
              ) : (
                <div className="flex items-center gap-2">
                  <Label htmlFor="scheduled-task-interval">Run every</Label>
                  <Input
                    type="number"
                    id="scheduled-task-interval"
                    nativeInput
                    min={1}
                    step="any"
                    className="w-24"
                    value={draft.intervalMinutes}
                    onChange={(event) =>
                      setDraft((current) => ({ ...current, intervalMinutes: event.target.value }))
                    }
                  />
                  <span className="text-xs text-muted-foreground">minutes</span>
                </div>
              )}
            </div>

            <div className="flex items-center justify-between gap-4">
              <div className="min-w-0 space-y-1">
                <Label htmlFor="scheduled-task-enabled">Enabled</Label>
                <p
                  id="scheduled-task-enabled-description"
                  className="text-sm text-muted-foreground"
                >
                  Disabled tasks stay saved but do not run.
                </p>
              </div>
              <Switch
                id="scheduled-task-enabled"
                aria-describedby="scheduled-task-enabled-description"
                checked={draft.enabled}
                onCheckedChange={(enabled) => setDraft((current) => ({ ...current, enabled }))}
              />
            </div>
          </fieldset>
        </DialogPanel>

        <DialogFooter>
          <DialogClose render={<Button variant="outline" size="sm" disabled={saving} />}>
            Cancel
          </DialogClose>
          <Button
            size="sm"
            disabled={!canOperate || saving || editingTaskMissing || !connected || !tasksQuery.data}
            onClick={() => void submit()}
          >
            {draft.editingId ? "Save routine" : "Create routine"}
          </Button>
        </DialogFooter>
      </DialogPopup>
    </Dialog>
  );
}
