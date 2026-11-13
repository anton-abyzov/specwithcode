import {
  machineColorProps,
  useMachineIdentity,
  type MachineIdentity,
} from "../../studio/machineIdentity";
import { squashAtomCommandFailure } from "@specweave-studio/client-runtime/state/runtime";
import type { EnvironmentProject } from "@specweave-studio/client-runtime/state/shell";
import { useNavigate } from "@tanstack/react-router";
import {
  ChevronDownIcon,
  CopyPlusIcon,
  DoorOpenIcon,
  MessageSquareShareIcon,
  MoveRightIcon,
  PlayIcon,
  Settings2Icon,
} from "lucide-react";
import { useEffect, useRef } from "react";
import { useTx } from "../../i18n";
import { randomUUID } from "../../lib/utils";
import { useAtomCommand } from "../../state/use-atom-command";
import { highestEpoch, projectLink } from "../../studio/projectLink";
import type { OrchestratorCopy } from "../../studio/projectCoordinatorMachine";
import { isProjectFolder } from "../../studio/projectMachineFolders";
import { useMachineNickname } from "../../studio/machineNickname";
import { requestAway } from "../../studio/awayRequest";
import { requestMigrateProjectThreads } from "../handoff/HandOffMachineDialog";
import { toastManager } from "../ui/toast";
import { Button } from "../ui/button";
import {
  Menu,
  MenuGroup,
  MenuGroupLabel,
  MenuItem,
  MenuPopup,
  MenuRadioGroup,
  MenuRadioItem,
  MenuRadioItemIndicator,
  MenuSeparator,
  MenuTrigger,
} from "../ui/menu";

/** Runs the pending action once the popup holding this has left the DOM. */
function AfterUnmount({ pending }: { pending: { current: (() => void) | null } }) {
  useEffect(
    () => () => {
      const run = pending.current;
      pending.current = null;
      run?.();
    },
    [pending],
  );
  return null;
}

/**
 * Which machine's copy of the project this page shows, then what can be done
 * with the project (add, move, start a coordinator) and with the viewed machine
 * (move its running threads, leave). Viewing reads that machine's server and
 * moves nothing; every move is its own confirmed action.
 */
export function OrchestratorSwitcher({
  label,
  hostLabel,
  connected,
  statusDetail,
  current,
  copies,
  unknown,
  savedMachineMissing,
  onView,
  onMove,
  onStart,
  onAllowWorkers,
  onMigrate = null,
  onCopy = null,
  onLeave = null,
  identity = null,
}: {
  identity?: MachineIdentity | null;
  /** The viewed machine's name: its nickname, else its short host label. */
  label: string;
  /** Its full host label for the tooltip; defaults to `label`. */
  hostLabel?: string;
  connected: boolean;
  /** One word for screen readers while the viewed machine is not connected ("Reconnecting"). */
  statusDetail: string;
  current: string;
  copies: readonly OrchestratorCopy[];
  /** Linked machines this device never synced; viewing one says Unknown. */
  unknown: ReadonlyArray<{ key: string; machine: string }>;
  savedMachineMissing: boolean;
  onView: ((key: string) => void) | null;
  /** Opens the confirmed coordinator move; null when it cannot be offered. */
  onMove: ((key: string) => void) | null;
  onStart: ((key: string) => void) | null;
  onAllowWorkers: (() => void) | null;
  /** Opens "Move running threads" for the viewed machine's threads; null while it is offline. */
  onMigrate?: (() => void) | null;
  /**
   * "Copy to another machine…": the one way to bring this project to another machine. The
   * dialog asks where the coordinator runs, so adding, moving and syncing all start here.
   */
  onCopy?: (() => void) | null;
  /** "Leave this machine…": Away mode for everything live here. */
  onLeave?: (() => void) | null;
}) {
  // Switch views only after the menu popup has left the DOM: the page being
  // left is hidden under an Activity, and a menu hidden mid-close stays mounted
  // as an invisible layer that catches clicks.
  const pendingView = useRef<(() => void) | null>(null);
  const tx = useTx();
  const runsOn = tx("Runs on {machine}", { machine: label });
  // The chip names the machine and shows its state by the dot alone: while it is not
  // connected, the line above the message box says so once, with what happens next.
  const status = (
    <>
      <span className="sws-dot" data-tone={connected ? "resolved" : "failed"} aria-hidden />
      <span
        className="sws-host-name"
        title={hostLabel && hostLabel !== label ? `${runsOn} (${hostLabel})` : runsOn}
      >
        {runsOn}
      </span>
      <span className="sr-only" data-orchestrator-status="">
        {connected ? `, ${tx("connected")}` : `, ${tx(statusDetail)}`}
      </span>
      {savedMachineMissing ? (
        <span aria-hidden> · {tx("Last viewed machine not listed")}</span>
      ) : null}
    </>
  );
  const listed = copies.filter((copy) => isProjectFolder(copy.folder));
  const viewable = (listed.length >= 2 || unknown.length > 0) && onView !== null;
  const machineActions = onCopy !== null || onLeave !== null;
  if (!viewable && !machineActions)
    return (
      <span
        className="project-muted sws-host sws-execution-control machine-chip"
        {...machineColorProps(identity)}
      >
        {status}
      </span>
    );
  // Two checkouts on one machine need their folders to tell them apart.
  const machines = listed.map((copy) => copy.machine);
  const ambiguous = (machine: string) =>
    machines.indexOf(machine) !== machines.lastIndexOf(machine);
  const nameOf = (copy: OrchestratorCopy) =>
    ambiguous(copy.machine) ? `${copy.machine} · ${copy.folder}` : copy.machine;
  const others = listed.filter((copy) => copy.key !== current);
  const starts = onStart ? others.filter((copy) => copy.canStart) : [];
  // A copy running its own coordinator already has one: moving this coordinator there is
  // refused. The coordinator-only move stays for copies that run only workers.
  const movable = onMove
    ? others.filter((copy) => copy.role === "workers" || copy.role === "independent")
    : [];
  // Copy, the coordinator moves and Start act on this project; threads and Leave on the machine.
  const projectActions = onCopy !== null || movable.length > 0 || starts.length > 0;
  return (
    <Menu>
      <span className="project-muted sws-host sws-execution-control">
        {/* No tooltip: one opened from this chip covered the message box. What viewing
            means is said inside the menu, which opens only when asked. */}
        <MenuTrigger
          render={
            <Button
              variant="ghost-muted"
              size="xs"
              className="min-w-0 max-w-full machine-chip"
              {...machineColorProps(identity)}
              data-coordinator-machine=""
              aria-label={
                viewable
                  ? tx("Viewing {machine}. Choose a machine to view", { machine: label })
                  : tx("{machine}: this project's machines", { machine: label })
              }
            />
          }
        >
          {status}
          <ChevronDownIcon aria-hidden />
        </MenuTrigger>
      </span>
      <MenuPopup align="start" side="top" className="min-w-64">
        <AfterUnmount pending={pendingView} />
        {viewable && onView ? (
          <MenuGroup>
            <MenuGroupLabel>{tx("View this project on")}</MenuGroupLabel>
            <p className="px-2 pb-1 text-muted-foreground text-xs" data-orchestrator-note="">
              {tx(
                "Viewing moves nothing: work stays on each machine. Adding or moving the project asks first.",
              )}
            </p>
            <MenuRadioGroup
              value={current}
              onValueChange={(value) => {
                pendingView.current = () => onView(value as string);
              }}
            >
              {[
                ...listed.map((copy) => ({
                  key: copy.key,
                  name: nameOf(copy),
                  // The same badge Settings > Machines shows for this copy.
                  note: copy.label.text ? tx(copy.label.text, copy.label.values) : "",
                  hint: nameOf(copy),
                })),
                // Linked, but this app has no connection to it, so it has no copy to show.
                ...unknown.map((ref) => ({
                  key: ref.key,
                  name: ref.machine,
                  note: tx("not connected"),
                  hint: tx(
                    "This app isn't connected to {machine}, so its copy can't be shown. Connect it in Settings > Machines.",
                    { machine: ref.machine },
                  ),
                })),
              ].map((row) => (
                <MenuRadioItem
                  key={row.key}
                  value={row.key}
                  data-orchestrator-view={row.key}
                  closeOnClick
                  title={row.hint}
                >
                  <span className="flex w-full items-center gap-2">
                    <span className="min-w-0 truncate">{row.name}</span>
                    {row.note ? (
                      <span className="shrink-0 text-muted-foreground text-xs">{row.note}</span>
                    ) : null}
                    <MenuRadioItemIndicator className="ms-auto ps-4" />
                  </span>
                </MenuRadioItem>
              ))}
            </MenuRadioGroup>
          </MenuGroup>
        ) : null}
        {projectActions ? (
          <>
            {viewable ? <MenuSeparator /> : null}
            <MenuGroup>
              <MenuGroupLabel>{tx("This project")}</MenuGroupLabel>
              {onCopy ? (
                <MenuItem
                  data-machine-action="copy"
                  onClick={() => {
                    pendingView.current = onCopy;
                  }}
                >
                  <CopyPlusIcon aria-hidden />
                  {tx("Copy to another machine…")}
                </MenuItem>
              ) : null}
              {movable.map((copy) => (
                <MenuItem
                  key={copy.key}
                  data-orchestrator-move={copy.key}
                  onClick={() => onMove?.(copy.key)}
                >
                  <MoveRightIcon aria-hidden />
                  {tx("Move coordinator to {machine}…", { machine: nameOf(copy) })}
                </MenuItem>
              ))}
              {starts.map((copy) => (
                <MenuItem
                  key={copy.key}
                  data-orchestrator-start={copy.key}
                  onClick={() => onStart?.(copy.key)}
                >
                  <PlayIcon aria-hidden />
                  {tx("Start a coordinator on {machine}", { machine: nameOf(copy) })}
                </MenuItem>
              ))}
            </MenuGroup>
          </>
        ) : null}
        {viewable || projectActions ? <MenuSeparator /> : null}
        <MenuGroup>
          <MenuGroupLabel>{tx("On {machine}", { machine: label })}</MenuGroupLabel>
          <MenuItem
            disabled={!onMigrate}
            data-orchestrator-migrate=""
            onClick={() => {
              if (onMigrate) pendingView.current = onMigrate;
            }}
          >
            <MessageSquareShareIcon aria-hidden />
            {tx("Move running threads…")}
            {onMigrate ? null : (
              <span className="ms-auto ps-4 text-muted-foreground text-xs">
                {tx("{machine} offline", { machine: label })}
              </span>
            )}
          </MenuItem>
          {onLeave ? (
            <MenuItem
              data-machine-action="leave"
              onClick={() => {
                pendingView.current = onLeave;
              }}
            >
              <DoorOpenIcon aria-hidden />
              {tx("Leave this machine…")}
            </MenuItem>
          ) : null}
        </MenuGroup>
        {onAllowWorkers ? (
          <>
            <MenuSeparator />
            <MenuItem data-orchestrator-access="" onClick={onAllowWorkers}>
              <Settings2Icon aria-hidden />
              {tx("Machine access settings")}
            </MenuItem>
          </>
        ) : null}
      </MenuPopup>
    </Menu>
  );
}

/**
 * The switcher on a project page, with its actions wired: viewing changes only
 * what this page shows, starting runs another coordinator next to this one,
 * moving opens the confirmed handoff. A machine that is not connected shows a
 * red dot; the status line above the message box says what that means.
 */
export function ProjectOrchestratorSwitcher({
  project,
  members,
  label,
  connected,
  isThisDevice,
  disconnectedLabel,
  current,
  copies,
  unknown,
  savedMachineMissing,
  onView,
  onMove,
  onCopy = null,
}: {
  project: EnvironmentProject;
  members: readonly EnvironmentProject[];
  label: string;
  connected: boolean;
  isThisDevice: boolean;
  disconnectedLabel: string;
  current: string;
  copies: readonly OrchestratorCopy[];
  unknown: ReadonlyArray<{ key: string; machine: string }>;
  savedMachineMissing: boolean;
  onView: ((key: string) => void) | null;
  onMove: ((key: string) => void) | null;
  onCopy?: (() => void) | null;
}) {
  const navigate = useNavigate();
  // A nickname shows as typed; only a host label drops its owner.
  const name = useMachineNickname(project.environmentId, label);
  const identity = useMachineIdentity(project.environmentId, label);
  const start = useStartCoordinator(members, copies);
  return (
    <OrchestratorSwitcher
      identity={identity}
      label={name}
      hostLabel={label}
      connected={connected}
      // The line above the message box says the rest once; the chip names the state.
      statusDetail={disconnectedLabel}
      current={current}
      copies={copies}
      unknown={unknown}
      savedMachineMissing={savedMachineMissing}
      onView={onView}
      onMove={onMove}
      onCopy={onCopy}
      // Away mode runs on this device's machine, so it is offered only there.
      onLeave={isThisDevice ? () => requestAway("away") : null}
      onStart={(key) => void start(key)}
      onAllowWorkers={() => void navigate({ to: "/settings/connections" })}
      onMigrate={
        connected
          ? () =>
              requestMigrateProjectThreads(project.environmentId, {
                id: project.id,
                title: project.title,
              })
          : null
      }
    />
  );
}

// Projects with a coordinator start in flight. Shared by every caller (the
// switcher and the composer notice) so two buttons never start two at once.
const startingProjects = new Set<string>();

/**
 * Starts a coordinator on a linked workers-only copy, next to the one that runs
 * now; each keeps the threads it started. One start per project runs at a time.
 */
export function useStartCoordinator(
  members: readonly EnvironmentProject[],
  copies: readonly OrchestratorCopy[],
) {
  const startCoordinator = useAtomCommand(projectLink.startCoordinator, { reportFailure: false });
  return async (key: string) => {
    const member = members.find((item) => `${item.environmentId}:${item.id}` === key);
    const copy = copies.find((item) => item.key === key);
    const project = member?.workspaceSettings?.logicalProject?.id ?? key;
    if (!member || !copy || startingProjects.has(project)) return;
    startingProjects.add(project);
    try {
      const result = await startCoordinator({
        environmentId: member.environmentId,
        input: {
          operationId: randomUUID(),
          projectId: member.id,
          knownEpoch: highestEpoch(members),
        },
      });
      if (result._tag === "Failure") throw squashAtomCommandFailure(result);
      toastManager.add({
        type: "success",
        title: `${copy.machine} now runs its own coordinator`,
        description: "Each coordinator keeps the threads it started. Nothing moved.",
      });
    } catch (cause) {
      toastManager.add({
        type: "error",
        title: `${copy.machine} did not start a coordinator`,
        description: cause instanceof Error && cause.message ? cause.message : "Retry it.",
      });
    } finally {
      startingProjects.delete(project);
    }
  };
}
