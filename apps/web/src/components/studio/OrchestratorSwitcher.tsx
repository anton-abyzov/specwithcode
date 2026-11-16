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
  Link2Icon,
  MessageSquareShareIcon,
  MoveRightIcon,
  Settings2Icon,
} from "lucide-react";
import { useEffect, useMemo, useRef, useState } from "react";
import { useTx } from "../../i18n";
import { randomUUID } from "../../lib/utils";
import { useAtomCommand } from "../../state/use-atom-command";
import { useProjects } from "../../state/entities";
import { highestEpoch, projectLink, sameRepositoryLinkOffers } from "../../studio/projectLink";
import {
  checkoutKeyEnvironmentId,
  type OrchestratorCopy,
} from "../../studio/projectCoordinatorMachine";
import { isProjectFolder } from "../../studio/projectMachineFolders";
import { useMachineNickname, useMachineNicknames } from "../../studio/machineNickname";
import { requestAway } from "../../studio/awayRequest";
import { requestMigrateProjectThreads } from "../handoff/HandOffMachineDialog";
import { toastManager } from "../ui/toast";
import { ProjectLinkDialog, type ProjectLinkTarget } from "./ProjectLinkDialog";
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
 * with the project (copy it, and one coordinator action per other machine) and
 * with the viewed machine (move its running threads, leave). Viewing reads that
 * machine's server and moves nothing; every move is its own confirmed action.
 *
 * Each machine appears once, in the view list, with a note naming its state:
 * the badge Settings > Machines shows for it (Main, Copy · main on X, Moving
 * main), coordinator paused (it kept its coordinator from before; its own page
 * offers to run it again), or not linked. The only
 * coordinator item below is "Move coordinator to X…", for a machine whose copy
 * runs workers only and kept nothing.
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
  onAllowWorkers,
  onMigrate = null,
  onCopy = null,
  links = [],
  onLink = null,
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
  onAllowWorkers: (() => void) | null;
  /** Opens "Move running threads" for the viewed machine's threads; null while it is offline. */
  onMigrate?: (() => void) | null;
  /**
   * "Send to another machine…": the one way to bring this project to another machine. The
   * dialog offers Copy or Move, so adding, moving and syncing all start here.
   */
  onCopy?: (() => void) | null;
  /**
   * Projects on other machines that track the same repository and are not part of this
   * one, at most one per machine: each gets "Link with the project on X…".
   */
  links?: ReadonlyArray<{ key: string; machine: string }>;
  /** Opens the link dialog on that project; null when linking cannot be offered. */
  onLink?: ((key: string) => void) | null;
  /** "Leave this machine…": Away mode for everything live here. */
  onLeave?: (() => void) | null;
}) {
  // Switch views only after the menu popup has left the DOM: the page being
  // left is hidden under an Activity, and a menu hidden mid-close stays mounted
  // as an invisible layer that catches clicks.
  const pendingView = useRef<(() => void) | null>(null);
  const tx = useTx();
  const runsOn = tx("Runs on {machine}", { machine: label });
  // The chip names the machine and shows its state by the dot alone, in the machine's own
  // color while connected (never a status green that reads as another machine). While it is not
  // connected, the line above the message box says so once, with what happens next.
  const status = (
    <>
      <span className="sws-dot" data-tone={connected ? "machine" : "failed"} aria-hidden />
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
  const machineActions =
    onCopy !== null || onLeave !== null || (onLink !== null && links.length > 0);
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
  // One coordinator item per machine at most. A machine where any copy runs its own
  // coordinator, or kept one (paused), gets none: viewing it opens it, and a paused one
  // offers to run again on its own page. Moving this one there would leave two
  // conversations for one place.
  const hostOf = (copy: OrchestratorCopy) => checkoutKeyEnvironmentId(copy.key);
  const coordinating = new Set(
    copies.filter((copy) => copy.role === "coordinator" || copy.canStart).map(hostOf),
  );
  const coordinatorActions: OrchestratorCopy[] = [];
  for (const host of new Set(others.map(hostOf))) {
    if (coordinating.has(host) || !onMove) continue;
    const move = others.find(
      (copy) => hostOf(copy) === host && (copy.role === "workers" || copy.role === "independent"),
    );
    if (move) coordinatorActions.push(move);
  }
  // Linking is what makes two projects for one repository one project; nothing is copied.
  const linkActions = onLink ? links : [];
  // Every copy registered on its own: "not linked" is about the projects, and reads like a broken
  // connection unless the menu says what it leaves alone. With a linked copy in the group (listed,
  // or known only as a machine this app never loaded) an unlinked one can be held back, so the
  // sentence is for the all-unlinked case only. It promises viewing and messaging, nothing about
  // agents: a machine may let another one's agents work only in linked projects.
  const allUnlinked =
    listed.length > 1 &&
    unknown.length === 0 &&
    copies.every((copy) => copy.role === "independent");
  // "Link them below" only when every other row has its link item: a second checkout on the
  // viewed machine, or one at another place in the repository, is listed but gets no offer.
  const linkCoversRows =
    allUnlinked &&
    others.length > 0 &&
    others.every((copy) => linkActions.some((link) => link.key === copy.key));
  // Copy, link and the coordinator actions act on this project; threads and Leave on the machine.
  const projectActions = onCopy !== null || coordinatorActions.length > 0 || linkActions.length > 0;
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
            {allUnlinked ? (
              <p
                className="px-2 pb-1 text-muted-foreground text-xs"
                data-orchestrator-unlinked-note=""
              >
                {tx(
                  "Not linked: these are separate projects for this repository, each with its own coordinator, threads and memory. That does not stop you viewing or messaging any of them.",
                )}
                {linkCoversRows ? ` ${tx("Link them below to make one project.")}` : null}
              </p>
            ) : null}
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
                  // A copy that kept its coordinator from before says so: it is paused, not
                  // gone. Every other copy shows the badge Settings > Machines shows for it;
                  // a checkout registered on its own reads "not linked".
                  note: copy.canStart
                    ? tx("coordinator paused")
                    : copy.label.text
                      ? tx(copy.label.text, copy.label.values)
                      : "",
                  hint: copy.canStart
                    ? tx(
                        "{machine} kept its coordinator from before and now runs workers only. View it to read that conversation or run it again.",
                        { machine: nameOf(copy) },
                      )
                    : copy.role === "independent"
                      ? tx(
                          "Not linked: {machine} runs its own coordinator, threads and memory for this repository.",
                          { machine: nameOf(copy) },
                        )
                      : nameOf(copy),
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
                  data-machine-action="send"
                  onClick={() => {
                    pendingView.current = onCopy;
                  }}
                >
                  <CopyPlusIcon aria-hidden />
                  {tx("Send to another machine…")}
                </MenuItem>
              ) : null}
              {linkActions.map((link) => (
                <MenuItem
                  key={link.key}
                  data-orchestrator-link={link.key}
                  title={tx(
                    "Makes this project and the one on {machine} one project with one coordinator. Threads and files stay where they are.",
                    { machine: link.machine },
                  )}
                  onClick={() => {
                    pendingView.current = () => onLink?.(link.key);
                  }}
                >
                  <Link2Icon aria-hidden />
                  {tx("Link with the project on {machine}…", { machine: link.machine })}
                </MenuItem>
              ))}
              {coordinatorActions.map((copy) => (
                <MenuItem
                  key={copy.key}
                  data-orchestrator-move={copy.key}
                  onClick={() => onMove?.(copy.key)}
                >
                  <MoveRightIcon aria-hidden />
                  {tx("Move coordinator to {machine}…", { machine: nameOf(copy) })}
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
  const [linkTarget, setLinkTarget] = useState<ProjectLinkTarget | null>(null);
  const projects = useProjects();
  const nickname = useMachineNicknames();
  // Linking needs what copying needs: a project this person can operate, not a private one.
  const offers = useMemo(
    // A machine's "No project" folder has no repository, so it never matches: no lookup needed.
    () => (onCopy ? sameRepositoryLinkOffers(projects, project, () => null) : []),
    [onCopy, projects, project],
  );
  return (
    <>
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
        links={offers.map((offer) => ({
          key: `${offer.environmentId}:${offer.id}`,
          machine: nickname(offer.environmentId),
        }))}
        onLink={(key) => {
          const offer = offers.find((item) => `${item.environmentId}:${item.id}` === key);
          if (offer) setLinkTarget({ environmentId: offer.environmentId, projectId: offer.id });
        }}
        // Away mode runs on this device's machine, so it is offered only there.
        onLeave={isThisDevice ? () => requestAway("away") : null}
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
      {linkTarget !== null && (
        <ProjectLinkDialog
          open
          onOpenChange={(open) => {
            if (!open) setLinkTarget(null);
          }}
          project={project}
          initialCandidate={linkTarget}
        />
      )}
    </>
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
