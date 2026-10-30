import { squashAtomCommandFailure } from "@specweave-studio/client-runtime/state/runtime";
import type { EnvironmentProject } from "@specweave-studio/client-runtime/state/shell";
import { useNavigate } from "@tanstack/react-router";
import {
  ArrowRightLeftIcon,
  ChevronDownIcon,
  KeyRoundIcon,
  PlayIcon,
  SendIcon,
} from "lucide-react";
import { useEffect, useRef } from "react";
import { useNowMinute } from "../../hooks/useNowMinute";
import { machineLastSeenAt, useMachineLastSeenVersion } from "../../lib/machineLastSeen";
import { randomUUID } from "../../lib/utils";
import { useAtomCommand } from "../../state/use-atom-command";
import { highestEpoch, projectLink } from "../../studio/projectLink";
import type { OrchestratorCopy } from "../../studio/projectCoordinatorMachine";
import { isProjectFolder } from "../../studio/projectMachineFolders";
import { remoteOrchestratorOfflineLabel } from "../../studio/projectWorkspaceModel";
import { useMachineNickname } from "../../studio/machineNickname";
import { nowFromMinute } from "../../studio/shellModel";
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
import { Tooltip, TooltipPopup, TooltipTrigger } from "../ui/tooltip";

const ROLE_NOTE: Record<OrchestratorCopy["role"], string> = {
  coordinator: "",
  workers: "workers only",
  pending: "handoff pending",
  independent: "independent",
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
 * Which machine's orchestrator this page shows, and the separate actions on
 * the others. Viewing reads that machine's server and moves nothing; moving
 * the coordinator and migrating threads are their own confirmed actions.
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
}: {
  /** The viewed machine's name: its nickname, else its short host label. */
  label: string;
  /** Its full host label for the tooltip; defaults to `label`. */
  hostLabel?: string;
  connected: boolean;
  /** Shown after the name while the viewed machine is not connected. */
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
}) {
  // Switch views only after the menu popup has left the DOM: the page being
  // left is hidden under an Activity, and a menu hidden mid-close stays mounted
  // as an invisible layer that catches clicks.
  const pendingView = useRef<(() => void) | null>(null);
  const status = (
    <>
      <span className="sws-dot" data-tone={connected ? "resolved" : "failed"} aria-hidden />
      <span className="sws-host-name">{label}</span>
      <span className="sr-only">{connected ? ", connected" : `, ${statusDetail}`}</span>
      {connected ? null : (
        <span aria-hidden data-orchestrator-status="">
          {" "}
          · {statusDetail}
        </span>
      )}
      {savedMachineMissing ? <span aria-hidden> · Last viewed machine not listed</span> : null}
    </>
  );
  const listed = copies.filter((copy) => isProjectFolder(copy.folder));
  if ((listed.length < 2 && unknown.length === 0) || !onView)
    return (
      <Tooltip>
        <TooltipTrigger render={<span className="project-muted sws-host" />}>
          {status}
        </TooltipTrigger>
        <TooltipPopup side="top">{hostLabel ?? label}</TooltipPopup>
      </Tooltip>
    );
  // Two checkouts on one machine need their folders to tell them apart.
  const machines = listed.map((copy) => copy.machine);
  const ambiguous = (machine: string) =>
    machines.indexOf(machine) !== machines.lastIndexOf(machine);
  const nameOf = (copy: OrchestratorCopy) =>
    ambiguous(copy.machine) ? `${copy.machine} · ${copy.folder}` : copy.machine;
  const others = listed.filter((copy) => copy.key !== current);
  const startable = others.filter((copy) => copy.canStart);
  const movable = onMove ? others.filter((copy) => copy.role !== "pending") : [];
  return (
    <Menu>
      <span className="project-muted sws-host">
        <Tooltip>
          <TooltipTrigger
            render={
              <MenuTrigger
                render={
                  <Button
                    variant="ghost-muted"
                    size="xs"
                    className="min-w-0 max-w-full"
                    aria-label={`Viewing ${label}'s orchestrator. Choose a machine to view`}
                  />
                }
              />
            }
          >
            {status}
            <ChevronDownIcon aria-hidden />
          </TooltipTrigger>
          <TooltipPopup side="top">
            Viewing {label}'s orchestrator. Viewing changes nothing; handing off the coordinator is
            a separate, confirmed action.
          </TooltipPopup>
        </Tooltip>
      </span>
      <MenuPopup align="start" side="top" className="min-w-64">
        <AfterUnmount pending={pendingView} />
        <MenuGroup>
          <MenuGroupLabel>View orchestrator</MenuGroupLabel>
          <MenuRadioGroup
            value={current}
            onValueChange={(value) => {
              pendingView.current = () => onView(value as string);
            }}
          >
            {listed.map((copy) => (
              <MenuRadioItem
                key={copy.key}
                value={copy.key}
                data-orchestrator-view={copy.key}
                closeOnClick
              >
                <span className="flex w-full items-center justify-between gap-6">
                  <span>
                    View {nameOf(copy)}'s orchestrator
                    {ROLE_NOTE[copy.role] ? (
                      <span className="text-muted-foreground"> · {ROLE_NOTE[copy.role]}</span>
                    ) : null}
                  </span>
                  <MenuRadioItemIndicator />
                </span>
              </MenuRadioItem>
            ))}
            {unknown.map((ref) => (
              <MenuRadioItem
                key={ref.key}
                value={ref.key}
                data-orchestrator-view={ref.key}
                closeOnClick
              >
                <span className="flex w-full items-center justify-between gap-6">
                  <span>
                    View {ref.machine}'s orchestrator
                    <span className="text-muted-foreground"> · Unknown</span>
                  </span>
                  <MenuRadioItemIndicator />
                </span>
              </MenuRadioItem>
            ))}
          </MenuRadioGroup>
        </MenuGroup>
        {startable.length > 0 && onStart ? (
          <>
            <MenuSeparator />
            {startable.map((copy) => (
              <MenuItem key={copy.key} onClick={() => onStart(copy.key)}>
                <PlayIcon aria-hidden />
                Start a coordinator on {nameOf(copy)}
              </MenuItem>
            ))}
          </>
        ) : null}
        <MenuSeparator />
        {movable.map((copy) => (
          <MenuItem key={copy.key} onClick={() => onMove?.(copy.key)}>
            <SendIcon aria-hidden />
            Hand off coordinator to {nameOf(copy)}…
          </MenuItem>
        ))}
        <MenuItem
          disabled={!onMigrate}
          data-orchestrator-migrate=""
          onClick={() => {
            if (onMigrate) pendingView.current = onMigrate;
          }}
        >
          <ArrowRightLeftIcon aria-hidden />
          {onMigrate
            ? `Move ${label}'s running threads…`
            : `Move ${label}'s running threads… (${label} offline)`}
        </MenuItem>
        {onAllowWorkers ? (
          <MenuItem onClick={onAllowWorkers}>
            <KeyRoundIcon aria-hidden />
            Allow workers both ways…
          </MenuItem>
        ) : null}
      </MenuPopup>
    </Menu>
  );
}

/**
 * The switcher on a project page, with its actions wired: viewing changes only
 * what this page shows, starting runs another coordinator next to this one,
 * moving opens the confirmed handoff. A remote machine that is not connected
 * says when this device last synced it and that the page is read-only.
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
}) {
  const navigate = useNavigate();
  // A nickname shows as typed; only a host label drops its owner.
  const name = useMachineNickname(project.environmentId, label);
  const start = useStartCoordinator(members, copies);
  useMachineLastSeenVersion();
  const now = nowFromMinute(useNowMinute());
  const statusDetail = isThisDevice
    ? disconnectedLabel
    : remoteOrchestratorOfflineLabel(name, machineLastSeenAt(project.environmentId), now);
  return (
    <OrchestratorSwitcher
      label={name}
      hostLabel={label}
      connected={connected}
      statusDetail={statusDetail}
      current={current}
      copies={copies}
      unknown={unknown}
      savedMachineMissing={savedMachineMissing}
      onView={onView}
      onMove={onMove}
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
