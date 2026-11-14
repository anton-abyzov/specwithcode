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
  SquareArrowOutUpRightIcon,
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

const ROLE_NOTE: Record<OrchestratorCopy["role"], string> = {
  coordinator: "",
  workers: "workers only",
  pending: "move pending",
  independent: "separate project",
};

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
 * with the project (copy it, and one coordinator action per other machine) and
 * with the viewed machine (move its running threads, leave). Viewing reads that
 * machine's server and moves nothing; every move is its own confirmed action.
 *
 * Each other machine gets at most one coordinator action, named by its state:
 * a copy that kept its own coordinator from before (its binding was handed
 * over, so it can start again) gets "Open coordinator on X", which runs that
 * coordinator again and shows it; a copy that only runs workers gets "Move
 * coordinator to X…"; a copy that already runs a coordinator gets none, since
 * viewing it above is how it is opened.
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
  /**
   * Runs the coordinator a copy kept from before again; resolves true once it runs,
   * and the switcher then shows that copy.
   */
  onStart: ((key: string) => Promise<boolean> | void) | null;
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
  // Open shows the started copy only while this switcher still shows the copy it was
  // clicked on: a start that settles after the person viewed another copy or left the
  // project never pulls them back.
  const shown = useRef({ mounted: true, current });
  shown.current.current = current;
  useEffect(() => {
    const state = shown.current;
    state.mounted = true;
    return () => {
      state.mounted = false;
    };
  }, []);
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
  // One coordinator action per machine. A copy that kept its coordinator from before is
  // opened (run again); moving this one there would leave two conversations for one
  // place. A copy running its own coordinator already has one: moving there is refused
  // and viewing it opens it, so it gets nothing here.
  const coordinatorActions = others.flatMap(
    (copy): Array<{ copy: OrchestratorCopy; kind: "open" | "move" }> =>
      onStart && copy.canStart
        ? [{ copy, kind: "open" }]
        : onMove && (copy.role === "workers" || copy.role === "independent")
          ? [{ copy, kind: "move" }]
          : [],
  );
  // Copy and the coordinator actions act on this project; threads and Leave on the machine.
  const projectActions = onCopy !== null || coordinatorActions.length > 0;
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
                  note: ROLE_NOTE[copy.role],
                  hint: nameOf(copy),
                })),
                // Linked, but this app has no connection to it, so it has no copy to show.
                ...unknown.map((ref) => ({
                  key: ref.key,
                  name: ref.machine,
                  note: "not connected",
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
                      <span className="shrink-0 text-muted-foreground text-xs">{tx(row.note)}</span>
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
              {coordinatorActions.map(({ copy, kind }) =>
                kind === "open" ? (
                  <MenuItem
                    key={copy.key}
                    data-orchestrator-start={copy.key}
                    title={tx(
                      "{machine} kept its coordinator from before. Opening runs it again next to this one; nothing moves.",
                      { machine: nameOf(copy) },
                    )}
                    onClick={() => {
                      const from = current;
                      const opened = onStart?.(copy.key);
                      void Promise.resolve(opened).then((ok) => {
                        const state = shown.current;
                        if (ok && onView && state.mounted && state.current === from)
                          onView(copy.key);
                      });
                    }}
                  >
                    <SquareArrowOutUpRightIcon aria-hidden />
                    {tx("Open coordinator on {machine}", { machine: nameOf(copy) })}
                  </MenuItem>
                ) : (
                  <MenuItem
                    key={copy.key}
                    data-orchestrator-move={copy.key}
                    onClick={() => onMove?.(copy.key)}
                  >
                    <MoveRightIcon aria-hidden />
                    {tx("Move coordinator to {machine}…", { machine: nameOf(copy) })}
                  </MenuItem>
                ),
              )}
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
      onStart={start}
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
 * Runs again the coordinator a linked workers-only copy kept from before, next to
 * the one that runs now; each keeps the threads it started. One start per project
 * runs at a time. Resolves true when that coordinator runs.
 */
export function useStartCoordinator(
  members: readonly EnvironmentProject[],
  copies: readonly OrchestratorCopy[],
) {
  const startCoordinator = useAtomCommand(projectLink.startCoordinator, { reportFailure: false });
  return async (key: string): Promise<boolean> => {
    const member = members.find((item) => `${item.environmentId}:${item.id}` === key);
    const copy = copies.find((item) => item.key === key);
    const project = member?.workspaceSettings?.logicalProject?.id ?? key;
    if (!member || !copy || startingProjects.has(project)) return false;
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
        title: `${copy.machine}'s coordinator runs again`,
        description: "Each coordinator keeps the threads it started. Nothing moved.",
      });
      return true;
    } catch (cause) {
      toastManager.add({
        type: "error",
        title: `${copy.machine} did not start a coordinator`,
        description: cause instanceof Error && cause.message ? cause.message : "Retry it.",
      });
      return false;
    } finally {
      startingProjects.delete(project);
    }
  };
}
