import {
  machineColorProps,
  useMachineIdentity,
  type MachineIdentity,
} from "../../studio/machineIdentity";
import { squashAtomCommandFailure } from "@specweave-studio/client-runtime/state/runtime";
import type { EnvironmentProject } from "@specweave-studio/client-runtime/state/shell";
import type { EnvironmentId } from "@specweave-studio/contracts";
import { useNavigate } from "@tanstack/react-router";
import {
  ArrowRightLeftIcon,
  ChevronDownIcon,
  CopyPlusIcon,
  DoorOpenIcon,
  Link2Icon,
  MessageSquareShareIcon,
  Settings2Icon,
} from "lucide-react";
import { useEffect, useMemo, useRef, useState } from "react";
import { useTx } from "../../i18n";
import { randomUUID } from "../../lib/utils";
import { useAtomCommand } from "../../state/use-atom-command";
import { useProjects } from "../../state/entities";
import { highestEpoch, projectLink, sameRepositoryLinkOffers } from "../../studio/projectLink";
import type { MainOffer } from "../../studio/makeMain";
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
 * main), coordinator paused (it kept its conversation from before, as history),
 * or not linked. The only coordinator item below is "Make X main", one per
 * linked machine that is not main, off with its reason while it cannot run.
 * A machine that is not linked gets "Link X to this project…" instead.
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
  mainOffers = [],
  onMakeMain = null,
  onAllowWorkers,
  onMigrate = null,
  onCopy = null,
  links = [],
  onLink = null,
  onLeave = null,
  identity = null,
  runsOn = null,
}: {
  identity?: MachineIdentity | null;
  /**
   * Where this page's coordinator runs when that is another machine than the viewed copy's
   * (main's, for a copy whose main is elsewhere). Only the chip's face names it, in its color
   * and connection state, as Send does; the menu still names and acts on the viewed copy.
   */
  runsOn?: {
    readonly label: string;
    readonly hostLabel?: string;
    readonly connected: boolean;
    readonly statusDetail: string;
    readonly identity: MachineIdentity | null;
  } | null;
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
  /**
   * "Make X main" for each linked copy that is not main (`useMakeMain`): pressable, or off
   * with its reason. Main itself and copies that are not linked have none.
   */
  mainOffers?: readonly MainOffer[];
  /** Runs that switch behind its own confirmation; null when it cannot be offered. */
  onMakeMain?: ((key: string) => void) | null;
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
   * one, at most one per machine: each gets "Link X to this project…".
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
  const face = runsOn ?? { label, hostLabel, connected, statusDetail, identity };
  const runsOnText = tx("Runs on {machine}", { machine: face.label });
  // The chip names the machine and shows its state by the dot alone, in the machine's own
  // color while connected (never a status green that reads as another machine). While it is not
  // connected, the line above the message box says so once, with what happens next.
  const status = (
    <>
      <span className="sws-dot" data-tone={face.connected ? "machine" : "failed"} aria-hidden />
      <span
        className="sws-host-name"
        title={
          face.hostLabel && face.hostLabel !== face.label
            ? `${runsOnText} (${face.hostLabel})`
            : runsOnText
        }
      >
        {runsOnText}
      </span>
      <span className="sr-only" data-orchestrator-status="">
        {face.connected ? `, ${tx("connected")}` : `, ${tx(face.statusDetail)}`}
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
        {...machineColorProps(face.identity)}
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
  // One "Make X main" per machine at most, the viewed machine included. A machine where a
  // copy runs a coordinator gets none: main is already there, or that copy would have to
  // give its own up first. A copy that is not linked has no main to become: it gets Link.
  const hostOf = (copy: OrchestratorCopy) => checkoutKeyEnvironmentId(copy.key);
  const coordinating = new Set(copies.filter((copy) => copy.role === "coordinator").map(hostOf));
  const mainActions: Array<{ copy: OrchestratorCopy; offer: MainOffer }> = [];
  for (const host of new Set(listed.map(hostOf))) {
    if (coordinating.has(host) || !onMakeMain) continue;
    for (const copy of listed) {
      if (hostOf(copy) !== host || copy.role !== "workers") continue;
      const offer = mainOffers.find((item) => item.key === copy.key);
      if (!offer) continue;
      mainActions.push({ copy, offer });
      break;
    }
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
  const projectActions = onCopy !== null || mainActions.length > 0 || linkActions.length > 0;
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
              {...machineColorProps(face.identity)}
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
                        "{machine} kept its coordinator conversation from before as history. View it to read that conversation.",
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
                    "Makes the project on {machine} part of this one. Main does not change, and threads and files stay where they are. You confirm what {machine} gives up first.",
                    { machine: link.machine },
                  )}
                  onClick={() => {
                    pendingView.current = () => onLink?.(link.key);
                  }}
                >
                  <Link2Icon aria-hidden />
                  {tx("Link {machine} to this project…", { machine: link.machine })}
                </MenuItem>
              ))}
              {mainActions.map(({ copy, offer }) => (
                <MenuItem
                  key={copy.key}
                  data-orchestrator-make-main={copy.key}
                  disabled={offer.kind === "blocked"}
                  title={
                    offer.reason
                      ? tx(offer.reason.text, offer.reason.values)
                      : offer.kind === "takeover"
                        ? tx(
                            "{main} is unreachable: {machine} takes over and starts from the shared goal, memory and plan. You confirm first.",
                            { machine: nameOf(copy), main: offer.main },
                          )
                        : tx(
                            "Moves the coordinator and its conversation from {main} to {machine}. {main} becomes a copy. You confirm first.",
                            { machine: nameOf(copy), main: offer.main },
                          )
                  }
                  onClick={() => {
                    // After the menu has left: the switch may show main's page or open a dialog.
                    if (offer.kind !== "blocked")
                      pendingView.current = () => onMakeMain?.(copy.key);
                  }}
                >
                  <ArrowRightLeftIcon aria-hidden />
                  {tx("Make {machine} main", { machine: nameOf(copy) })}
                  {offer.note ? (
                    <span className="ms-auto ps-4 text-muted-foreground text-xs">
                      {tx(offer.note.text, offer.note.values)}
                    </span>
                  ) : null}
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
 * The project that keeps main when another is linked to it: the viewed copy, or main when it is
 * elsewhere. Linking never changes main, so the dialog opens on that copy and it stays main.
 * Null while a linked project's main is not loaded here: a copy that takes work from main must
 * never be the side that keeps it, so nothing is offered.
 */
export function linkKeeper(
  project: EnvironmentProject,
  projects: readonly EnvironmentProject[],
  copies: readonly OrchestratorCopy[],
): EnvironmentProject | null {
  if (!project.workspaceSettings?.logicalProject) return project;
  const mainKey = copies.find((copy) => copy.main)?.key;
  if (mainKey === undefined) return null;
  return projects.find((item) => `${item.environmentId}:${item.id}` === mainKey) ?? null;
}

/**
 * The switcher on a project page, with its actions wired: viewing changes only
 * what this page shows, "Make X main" runs the page's confirmed switch, linking
 * opens its confirmation. A machine that is not connected shows a red dot; the
 * status line above the message box says what that means.
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
  mainOffers = [],
  onMakeMain = null,
  onCopy = null,
  runsOn = null,
}: {
  project: EnvironmentProject;
  label: string;
  connected: boolean;
  isThisDevice: boolean;
  disconnectedLabel: string;
  /**
   * Where this page's coordinator runs when that is not the viewed copy's machine: main's,
   * for a copy whose main is elsewhere (`composerMachines`). The chip names it, as Send does.
   */
  runsOn?: {
    readonly environmentId: EnvironmentId;
    readonly label: string;
    readonly connected: boolean;
    readonly disconnectedLabel: string;
  } | null;
  current: string;
  copies: readonly OrchestratorCopy[];
  unknown: ReadonlyArray<{ key: string; machine: string }>;
  savedMachineMissing: boolean;
  onView: ((key: string) => void) | null;
  mainOffers?: readonly MainOffer[];
  onMakeMain?: ((key: string) => void) | null;
  onCopy?: (() => void) | null;
}) {
  const navigate = useNavigate();
  // A nickname shows as typed; only a host label drops its owner.
  const name = useMachineNickname(project.environmentId, label);
  const identity = useMachineIdentity(project.environmentId, label);
  // Where the coordinator runs, when that is another machine (`runsOn`): the chip's face.
  const mainId = runsOn?.environmentId ?? project.environmentId;
  const mainName = useMachineNickname(mainId, runsOn?.label ?? label);
  const mainIdentity = useMachineIdentity(mainId, runsOn?.label ?? label);
  const [linkTarget, setLinkTarget] = useState<ProjectLinkTarget | null>(null);
  const projects = useProjects();
  const nickname = useMachineNicknames();
  // Linking needs what copying needs: a project this person can operate, not a private one.
  const offers = useMemo(
    // A machine's "No project" folder has no repository, so it never matches: no lookup needed.
    () => (onCopy ? sameRepositoryLinkOffers(projects, project, () => null) : []),
    [onCopy, projects, project],
  );
  const linkProject = linkKeeper(project, projects, copies);
  const linkOffers = linkProject === null ? [] : offers;
  return (
    <>
      <OrchestratorSwitcher
        identity={identity}
        label={name}
        hostLabel={label}
        connected={connected}
        // The line above the message box says the rest once; the chip names the state.
        statusDetail={disconnectedLabel}
        runsOn={
          runsOn
            ? {
                label: mainName,
                hostLabel: runsOn.label,
                connected: runsOn.connected,
                statusDetail: runsOn.disconnectedLabel,
                identity: mainIdentity,
              }
            : null
        }
        current={current}
        copies={copies}
        unknown={unknown}
        savedMachineMissing={savedMachineMissing}
        onView={onView}
        mainOffers={mainOffers}
        onMakeMain={onMakeMain}
        onCopy={onCopy}
        links={linkOffers.map((offer) => ({
          key: `${offer.environmentId}:${offer.id}`,
          machine: nickname(offer.environmentId),
        }))}
        onLink={(key) => {
          const offer = linkOffers.find((item) => `${item.environmentId}:${item.id}` === key);
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
      {linkTarget !== null && linkProject !== null && (
        <ProjectLinkDialog
          open
          onOpenChange={(open) => {
            if (!open) setLinkTarget(null);
          }}
          project={linkProject}
          initialCandidate={linkTarget}
          // "Link X to this project…": X joins, this project keeps main, and the dialog
          // opens on what X gives up.
          joining
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
 * runs at a time. Resolves true when that coordinator runs. Kept for the
 * Settings revival path (1372 D-07); the copy's message box no longer offers it.
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
