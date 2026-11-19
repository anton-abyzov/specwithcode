import {
  machineColorProps,
  useMachineIdentity,
  type MachineIdentity,
} from "../../studio/machineIdentity";
import type { EnvironmentProject } from "@specweave-studio/client-runtime/state/shell";
import { useNavigate } from "@tanstack/react-router";
import {
  ArrowRightLeftIcon,
  ChevronDownIcon,
  CopyPlusIcon,
  DoorOpenIcon,
  Link2Icon,
  MessageSquareShareIcon,
  RefreshCwIcon,
  Settings2Icon,
} from "lucide-react";
import { useEffect, useMemo, useRef, useState } from "react";
import { useTx } from "../../i18n";
import { useProjects, useServerConfigs } from "../../state/entities";
import { useEnvironments } from "../../state/environments";
import { machineLastSeenAt, useMachineLastSeenVersion } from "../../lib/machineLastSeen";
import { formatAgo } from "../../studio/hostLimitsModel";
import { sameRepositoryLinkOffers } from "../../studio/projectLink";
import type { MainOffer } from "../../studio/makeMain";
import {
  checkoutKeyEnvironmentId,
  type OrchestratorCopy,
} from "../../studio/projectCoordinatorMachine";
import { isProjectFolder } from "../../studio/projectMachineFolders";
import {
  machineReach,
  machineRowState,
  type MachineReach,
  type MachineRowKind,
  type MachineRowText,
  type MachineSyncFact,
} from "../../studio/machineRowState";
import { useMachineNickname, useMachineNicknames } from "../../studio/machineNickname";
import { requestAway } from "../../studio/awayRequest";
import { requestMigrateProjectThreads } from "../handoff/HandOffMachineDialog";
import { ExtraCoordinatorFix } from "./ExtraCoordinatorFix";
import { ProjectSyncDialog } from "./ProjectSyncDialog";
import { useProjectSyncMenu, type SyncAsk } from "./useProjectSyncMenu";
import { ProjectLinkDialog, type ProjectLinkTarget } from "./ProjectLinkDialog";
import { useLinkRefusals } from "../../studio/linkRefusals";
import { Button } from "../ui/button";
import { EnvironmentMachineIcon } from "../EnvironmentMachineIcon";
import {
  Menu,
  MenuGroup,
  MenuGroupLabel,
  MenuHint,
  MenuInfoGroup,
  MenuItem,
  MenuPopup,
  MenuRadioGroup,
  MenuRadioItem,
  MenuRadioItemIndicator,
  MenuSeparator,
  MenuTrigger,
} from "../ui/menu";

/** A machine row's leading glyph: the machine's own icon in its color, as its chip shows it. */
function MachineRowIcon({ checkoutKey, name }: { checkoutKey: string; name: string }) {
  const identity = useMachineIdentity(checkoutKeyEnvironmentId(checkoutKey), name);
  return (
    <span
      className="machine-mark flex size-4 shrink-0 items-center justify-center"
      {...machineColorProps(identity)}
      aria-hidden
    >
      <EnvironmentMachineIcon kind={identity?.icon ?? "laptop"} className="size-4" />
    </span>
  );
}

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

/** What this window can show of a machine with a row, and when it last saw it. */
export interface MachineRowReach {
  readonly reach: MachineReach;
  /** When this window last saw an offline machine, in words; null when unknown. */
  readonly lastSeen?: string | null;
}

const OPEN: MachineRowReach = { reach: "open" };

const PILL: Record<MachineRowKind, string> = {
  coordinator: "border-transparent bg-secondary text-foreground",
  "extra-coordinator": "border-warning/40 bg-warning/10 text-warning-foreground",
  "handing-off": "border-border text-muted-foreground",
  separate: "border-border text-muted-foreground",
  "cannot-open": "",
  plain: "",
};

/** What a row for another machine says about its files, beside its one state. */
export interface MachineRowSync {
  readonly sync: MachineSyncFact | null;
  /** The machine's app is from before Sync; its version when the window knows it. */
  readonly needsUpdate?: { readonly version: string | null } | null;
}

const NO_SYNC: MachineRowSync = { sync: null };

const SYNC_PILL: Record<MachineSyncFact["tone"], string> = {
  same: "border-success/40 text-success-foreground",
  differs: "border-warning/40 bg-warning/10 text-warning-foreground",
  unknown: "border-border text-muted-foreground",
};

/**
 * The machines that have this project, then what can be done with the project (sync it with
 * another machine, add it to one, link a separate project) and with the machine shown (continue the
 * coordinator here, move its running threads, leave). Picking a machine reads that
 * machine's server and moves nothing; every move is its own confirmed action.
 *
 * Each machine appears once, with the one state `machineRowState` gives it: "Coordinator"
 * on the machine that holds the coordinator conversation, "Extra coordinator" with "Fix…"
 * on a linked machine that still runs one of its own, "Separate project" for the same
 * repository added on its own, and a greyed row with its reason for a machine this window
 * cannot open. No row names a role. The chip names the machine shown.
 */
export function OrchestratorSwitcher({
  label,
  hostLabel,
  projectTitle,
  connected,
  statusDetail,
  current,
  copies,
  unknown,
  savedMachineMissing,
  onView,
  reachOf = () => OPEN,
  mainOffers = [],
  onMakeMain = null,
  onFix = null,
  onAllowWorkers,
  onMigrate = null,
  onSync = null,
  syncBlocked = null,
  onAdd = null,
  syncOf = () => NO_SYNC,
  onOpenChange,
  links = [],
  onLink = null,
  onLeave = null,
  identity = null,
}: {
  identity?: MachineIdentity | null;
  /** The name of the machine shown: its nickname, else its short host label. */
  label: string;
  /** Its full host label for the tooltip; defaults to `label`. */
  hostLabel?: string;
  /** The project's name, for the menu's first group. */
  projectTitle: string;
  connected: boolean;
  /** One word for screen readers while the machine shown is not connected ("Reconnecting"). */
  statusDetail: string;
  current: string;
  copies: readonly OrchestratorCopy[];
  /** Linked machines this window never opened: each is a greyed row. */
  unknown: ReadonlyArray<{ key: string; machine: string }>;
  savedMachineMissing: boolean;
  onView: ((key: string) => void) | null;
  /** This window's reach of a listed machine; every machine is open when left out. */
  reachOf?: (key: string) => MachineRowReach;
  /**
   * "Continue the coordinator here" per machine that can take it (`useMakeMain`): pressable,
   * or off with its reason. The menu offers the one for the machine shown.
   */
  mainOffers?: readonly MainOffer[];
  /** Runs it behind its own confirmation; null when it cannot be offered. */
  onMakeMain?: ((key: string) => void) | null;
  /** Opens "Fix…" for a linked machine that still runs a coordinator of its own. */
  onFix?: ((key: string) => void) | null;
  onAllowWorkers: (() => void) | null;
  /** Opens "Move running threads" for the threads of the machine shown; null while it is offline. */
  onMigrate?: (() => void) | null;
  /** "Sync…": offered when another machine has the project; null when none does. */
  onSync?: (() => void) | null;
  /** Why Sync cannot run from the machine shown: the entry is greyed with it. */
  syncBlocked?: MachineRowText | null;
  /** "Add to another machine…": only when a paired machine does not have the project. */
  onAdd?: (() => void) | null;
  /** The sync fact of a row for another machine; no fact when left out. */
  syncOf?: (key: string) => MachineRowSync;
  /** The menu opened or closed. Opening is when each machine's status is read. */
  onOpenChange?: (open: boolean) => void;
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
  // Why linking a copy last failed, kept after the Add dialog was closed.
  const refusalOf = useLinkRefusals();
  const onText = tx("On {machine}", { machine: label });
  // The chip names the machine shown and its state by the dot alone, in the machine's own
  // color while connected (never a status green that reads as another machine). While it is not
  // connected, the line above the message box says so once, with what happens next.
  const status = (
    <>
      <span className="sws-dot" data-tone={connected ? "machine" : "failed"} aria-hidden />
      {/* No native title: the system tooltip floated over the message above the composer,
          outside the popup standard (docs/studio/design-guidelines.md, Popups). The computer's
          own name goes to assistive technology instead. */}
      <span className="sws-host-name">{onText}</span>
      {hostLabel && hostLabel !== label ? (
        <span className="sr-only" data-orchestrator-host="">
          {` (${hostLabel})`}
        </span>
      ) : null}
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
    onSync !== null || onAdd !== null || onLeave !== null || (onLink !== null && links.length > 0);
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
  // One coordinator item, for the machine shown: it is there only while the coordinator is
  // on another machine and this one could take it (`makeMainPath`).
  const viewed = listed.find((copy) => copy.key === current);
  // Never on the machine that already holds the coordinator, nor on a separate project,
  // which has no coordinator of this project to continue.
  const continueOffer =
    onMakeMain && viewed && (viewed.rowRole === "copy" || viewed.rowRole === "also-main")
      ? (mainOffers.find((offer) => offer.key === current) ?? null)
      : null;
  // Linking is what makes two projects for one repository one project; nothing is copied.
  const linkActions = onLink ? links : [];
  const refusalWords = (reason: NonNullable<ReturnType<typeof refusalOf>>) =>
    reason.verbatim ? reason.text : tx(reason.text, reason.values);
  // Every machine added the repository on its own: the menu says once that they are separate
  // projects and what that leaves alone. With a linked machine in the group (listed, or known
  // only as one this window never opened) the sentence does not hold for every row.
  const allSeparate =
    listed.length > 1 &&
    unknown.length === 0 &&
    copies.every((copy) => copy.role === "independent");
  // "Link them below" only when every other row has its link item: a second checkout on the
  // machine shown, or one at another place in the repository, is listed but gets no offer.
  const linkCoversRows =
    allSeparate &&
    others.length > 0 &&
    others.every((copy) => linkActions.some((link) => link.key === copy.key));
  const projectActions = onSync !== null || onAdd !== null || linkActions.length > 0;
  const groupLabel = tx("{project} on your machines", { project: projectTitle });
  const rows = [
    ...listed.map((copy) => {
      const name = nameOf(copy);
      const reach = reachOf(copy.key);
      // The machine shown is what the others are compared with: it has no fact of its own.
      const files = syncOf(copy.key);
      return {
        key: copy.key,
        name,
        state: machineRowState({
          machine: name,
          role: copy.rowRole,
          reach: reach.reach,
          lastSeen: reach.lastSeen ?? null,
          keptConversation: copy.canStart,
          sync: copy.key === current ? null : files.sync,
          needsUpdate: files.needsUpdate ?? null,
        }),
        hint: copy.canStart
          ? tx(
              "{machine} kept its coordinator conversation from before as history. View it to read that conversation.",
              { machine: name },
            )
          : copy.role === "independent"
            ? tx(
                "Separate project: {machine} added this repository on its own, with its own coordinator, threads and memory.",
                { machine: name },
              )
            : name,
      };
    }),
    // The project lists the machine, but this window never opened it: nothing to show.
    ...unknown.map((ref) => ({
      key: ref.key,
      name: ref.machine,
      state: machineRowState({ machine: ref.machine, role: "copy", reach: "never-opened" }),
      hint: ref.machine,
    })),
  ];
  // Machines of this project first; the same repository as separate projects after them.
  const ordered = [
    ...rows.filter((row) => row.state.kind !== "separate"),
    ...rows.filter((row) => row.state.kind === "separate"),
  ];
  const firstSeparate = ordered.findIndex((row) => row.state.kind === "separate");
  return (
    <Menu {...(onOpenChange ? { onOpenChange } : {})}>
      <span className="project-muted sws-host sws-execution-control">
        {/* No tooltip: one opened from this chip covered the message box. What picking a
            machine means is said inside the menu, which opens only when asked. */}
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
      {/* A fixed width, so opening the info note never makes the menu jump wider. */}
      <MenuPopup align="start" side="top" className="w-[min(20rem,calc(100vw-2rem))]">
        <AfterUnmount pending={pendingView} />
        {viewable && onView ? (
          <MenuInfoGroup
            label={groupLabel}
            infoLabel={`${tx("About")}: ${groupLabel}`}
            info={
              <>
                <MenuHint data-orchestrator-note="">
                  {tx(
                    "Pick a machine to see its threads and files. Nothing moves until you sync or hand off.",
                  )}
                </MenuHint>
                {allSeparate ? (
                  <MenuHint data-orchestrator-unlinked-note="">
                    {tx(
                      "These are separate projects for this repository, each with its own coordinator, threads and memory. You can still open and message each one.",
                    )}
                    {linkCoversRows ? ` ${tx("Link them below to make one project.")}` : null}
                  </MenuHint>
                ) : null}
              </>
            }
          >
            {/* What picking a machine means sits behind the label's info button: the lines are
                too long to stand in a menu, and the menu should open on its machines. */}
            <MenuRadioGroup
              value={current}
              onValueChange={(value) => {
                pendingView.current = () => onView(value as string);
              }}
            >
              {ordered.map((row, index) => (
                <div key={row.key}>
                  {index > 0 && index === firstSeparate ? <MenuSeparator /> : null}
                  <div className="flex items-start gap-1">
                    <MenuRadioItem
                      className="min-w-0 flex-1"
                      value={row.key}
                      data-orchestrator-view={row.key}
                      data-row-state={row.state.kind}
                      // A machine this window cannot open is greyed: a click would only lead
                      // to a page with nothing on it.
                      disabled={!row.state.pressable}
                      closeOnClick
                      title={
                        row.state.pressable || !row.state.label
                          ? row.hint
                          : tx(row.state.label.text, row.state.label.values)
                      }
                    >
                      <span className="flex w-full items-start gap-2">
                        <span className="flex h-5 items-center">
                          <MachineRowIcon checkoutKey={row.key} name={row.name} />
                        </span>
                        <span className="flex min-w-0 flex-1 flex-col">
                          {/* The pill drops under the name when both do not fit one line. */}
                          <span className="flex min-w-0 flex-wrap items-center gap-x-2 gap-y-0.5">
                            <span className="max-w-full truncate">{row.name}</span>
                            {row.state.label && row.state.pressable ? (
                              <span
                                className={`shrink-0 rounded-full border px-1.5 text-xs ${PILL[row.state.kind]}`}
                                data-row-pill=""
                              >
                                {tx(row.state.label.text, row.state.label.values)}
                              </span>
                            ) : null}
                            {row.state.sync ? (
                              <span
                                className={`max-w-full rounded-full border px-1.5 text-xs ${SYNC_PILL[row.state.sync.tone]}`}
                                data-row-sync={row.state.sync.tone}
                              >
                                {tx(row.state.sync.text, row.state.sync.values)}
                              </span>
                            ) : null}
                          </span>
                          {row.state.label && !row.state.pressable ? (
                            <span className="text-muted-foreground text-xs" data-row-reason="">
                              {tx(row.state.label.text, row.state.label.values)}
                            </span>
                          ) : null}
                          {row.state.notes.map((note) => (
                            <span
                              key={note.text}
                              className="text-muted-foreground text-xs"
                              data-row-note=""
                            >
                              {tx(note.text, note.values)}
                            </span>
                          ))}
                        </span>
                        <MenuRadioItemIndicator className="ms-auto ps-2" />
                      </span>
                    </MenuRadioItem>
                    {row.state.action === "fix" && onFix ? (
                      <MenuItem
                        className="shrink-0 rounded-md border border-border px-2 text-xs"
                        data-orchestrator-fix={row.key}
                        aria-label={tx("Fix the extra coordinator on {machine}", {
                          machine: row.name,
                        })}
                        onClick={() => {
                          // Its own action: it never picks the row beside it.
                          pendingView.current = () => onFix(row.key);
                        }}
                      >
                        {tx("Fix…")}
                      </MenuItem>
                    ) : null}
                    {row.state.action === "connect" && onAllowWorkers ? (
                      <MenuItem
                        className="shrink-0 rounded-md border border-border px-2 text-xs"
                        data-orchestrator-connect={row.key}
                        aria-label={tx("Connect {machine}", { machine: row.name })}
                        onClick={onAllowWorkers}
                      >
                        {tx("Connect…")}
                      </MenuItem>
                    ) : null}
                  </div>
                </div>
              ))}
            </MenuRadioGroup>
          </MenuInfoGroup>
        ) : null}
        {projectActions ? (
          <MenuGroup>
            {onSync ? (
              <MenuItem
                data-machine-action="sync"
                disabled={syncBlocked !== null}
                onClick={() => {
                  if (syncBlocked === null) pendingView.current = onSync;
                }}
              >
                <RefreshCwIcon aria-hidden />
                {tx("Sync…")}
                {syncBlocked ? (
                  <span
                    className="ms-auto ps-4 text-end text-muted-foreground text-xs"
                    data-sync-blocked=""
                  >
                    {tx(syncBlocked.text, syncBlocked.values)}
                  </span>
                ) : null}
              </MenuItem>
            ) : null}
            {onAdd ? (
              <MenuItem
                data-machine-action="add"
                onClick={() => {
                  pendingView.current = onAdd;
                }}
              >
                <CopyPlusIcon aria-hidden />
                {tx("Add to another machine…")}
              </MenuItem>
            ) : null}
            {linkActions.map((link) => (
              <MenuItem
                key={link.key}
                data-orchestrator-link={link.key}
                title={tx(
                  "Makes the project on {machine} part of this one. The coordinator stays where it is, and threads and files stay where they are. You confirm what {machine} gives up first.",
                  { machine: link.machine },
                )}
                onClick={() => {
                  pendingView.current = () => onLink?.(link.key);
                }}
              >
                <Link2Icon aria-hidden />
                <span className="flex min-w-0 flex-col">
                  {tx("Link {machine} to this project…", { machine: link.machine })}
                  {refusalOf(current, link.key) ? (
                    // Why the last try to link it failed, kept after Add was closed.
                    <span
                      className="text-muted-foreground text-xs wrap-anywhere"
                      data-orchestrator-link-refusal=""
                    >
                      {tx("Not linked yet. {reason}", {
                        reason: refusalWords(refusalOf(current, link.key)!),
                      })}
                    </span>
                  ) : null}
                </span>
              </MenuItem>
            ))}
          </MenuGroup>
        ) : null}
        {viewable || projectActions ? <MenuSeparator /> : null}
        <MenuGroup>
          <MenuGroupLabel>{tx("Work on {machine}", { machine: label })}</MenuGroupLabel>
          {continueOffer ? (
            <MenuItem
              data-orchestrator-continue={continueOffer.key}
              disabled={continueOffer.kind === "blocked"}
              title={
                continueOffer.reason
                  ? tx(continueOffer.reason.text, continueOffer.reason.values)
                  : continueOffer.kind === "takeover"
                    ? tx(
                        "{main} is offline: the coordinator starts on {machine} from the shared goal, memory and plan. You confirm first.",
                        { machine: continueOffer.machine, main: continueOffer.main },
                      )
                    : tx(
                        "Syncs {machine}, then moves the coordinator conversation here from {main}. You confirm first.",
                        { machine: continueOffer.machine, main: continueOffer.main },
                      )
              }
              onClick={() => {
                // After the menu has left: it may show the coordinator's page or open a dialog.
                if (continueOffer.kind !== "blocked")
                  pendingView.current = () => onMakeMain?.(continueOffer.key);
              }}
            >
              <ArrowRightLeftIcon aria-hidden />
              {tx("Continue the coordinator here")}
              {continueOffer.note ? (
                <span className="ms-auto ps-4 text-muted-foreground text-xs">
                  {tx(continueOffer.note.text, continueOffer.note.values)}
                </span>
              ) : null}
            </MenuItem>
          ) : null}
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
 * The project that keeps the coordinator when another is linked to it: the one shown, or the
 * coordinator's when it is elsewhere. Linking never moves the coordinator, so the dialog opens
 * on that project. Null while a linked project's coordinator is not loaded here: a machine
 * that follows a coordinator must never be the side that keeps it, so nothing is offered.
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
 * The switcher on a project page, with its actions wired: picking a machine changes only
 * what this page shows, "Continue the coordinator here" runs the page's confirmed switch,
 * linking opens its confirmation. A machine that is not connected shows a red dot; the
 * status line above the message box says what that means.
 */
export function ProjectOrchestratorSwitcher({
  project,
  projectTitle,
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
  syncReadOnly = false,
  onOpenSettings = null,
}: {
  project: EnvironmentProject;
  projectTitle: string;
  label: string;
  connected: boolean;
  isThisDevice: boolean;
  disconnectedLabel: string;
  current: string;
  copies: readonly OrchestratorCopy[];
  unknown: ReadonlyArray<{ key: string; machine: string }>;
  savedMachineMissing: boolean;
  onView: ((key: string) => void) | null;
  mainOffers?: readonly MainOffer[];
  onMakeMain?: ((key: string) => void) | null;
  /**
   * Opens the folder dialog: "add" for a machine without the project, "sync" with a machine
   * key and the measured copy for "Compare all files…". Null when this window may not
   * operate the project, or the project is personal. The machine menu's Sync and Add ask
   * through this.
   */
  onCopy?: SyncAsk | null;
  /** The window can read this project and may not operate it: Sync is shown greyed, with why. */
  syncReadOnly?: boolean;
  /** Opens this project's settings on its machines, for a machine "Fix…" cannot unlink. */
  onOpenSettings?: (() => void) | null;
}) {
  const navigate = useNavigate();
  // A nickname shows as typed; only a host label drops its owner.
  const name = useMachineNickname(project.environmentId, label);
  const identity = useMachineIdentity(project.environmentId, label);
  // What this window can show of each listed machine: an offline one opens what was last
  // saved, and one that refuses this window is greyed.
  const { environments } = useEnvironments();
  useMachineLastSeenVersion();
  const [now] = useState(Date.now);
  const reachOf = (key: string): MachineRowReach => {
    const environmentId = checkoutKeyEnvironmentId(key);
    // A listed machine this window holds no connection record for is shown as it was:
    // only machines the project names and this window never opened are greyed.
    const known = environments.find((item) => item.environmentId === environmentId);
    const reach = known ? machineReach(known.connection) : "open";
    const seen = reach === "offline" ? machineLastSeenAt(environmentId) : null;
    return { reach, lastSeen: seen === null ? null : formatAgo(seen, now) };
  };
  const [linkTarget, setLinkTarget] = useState<ProjectLinkTarget | null>(null);
  const [fixKey, setFixKey] = useState<string | null>(null);
  const projects = useProjects();
  const nickname = useMachineNicknames();
  // Linking needs what copying needs: a project this person can operate, not a private one.
  const offers = useMemo(
    // A machine's "No project" folder has no repository, so it never matches: no lookup needed.
    () => (onCopy ? sameRepositoryLinkOffers(projects, project, () => null) : []),
    [onCopy, projects, project],
  );
  const linkProject = linkKeeper(project, projects, copies);
  // "Fix…": the machines of this project, the one with the extra coordinator, and the one
  // that holds the project's coordinator.
  const identityId = project.workspaceSettings?.logicalProject?.id;
  const shared =
    identityId === undefined
      ? []
      : projects.filter((item) => item.workspaceSettings?.logicalProject?.id === identityId);
  const keyOf = (item: EnvironmentProject) => `${item.environmentId}:${item.id}`;
  const fixMember = shared.find((item) => keyOf(item) === fixKey);
  const mainKey = copies.find((copy) => copy.main)?.key;
  const fixCoordinator = shared.find((item) => keyOf(item) === mainKey);
  const linkOffers = linkProject === null ? [] : offers;
  const versions = useServerConfigs();
  const files = useProjectSyncMenu({
    project,
    label: name,
    current,
    copies,
    unknown,
    environments,
    projects,
    reachOf: (key) => reachOf(key).reach,
    versionOf: (environmentId) => versions.get(environmentId)?.environment.serverVersion ?? null,
    ask: onCopy,
    readOnly: syncReadOnly,
  });
  return (
    <>
      <OrchestratorSwitcher
        identity={identity}
        label={name}
        hostLabel={label}
        projectTitle={projectTitle}
        reachOf={reachOf}
        connected={connected}
        // The line above the message box says the rest once; the chip names the state.
        statusDetail={disconnectedLabel}
        current={current}
        copies={copies}
        unknown={unknown}
        savedMachineMissing={savedMachineMissing}
        onView={onView}
        mainOffers={mainOffers}
        onMakeMain={onMakeMain}
        onFix={setFixKey}
        onSync={files.onSync}
        syncBlocked={files.syncBlocked}
        onAdd={files.onAdd}
        syncOf={files.syncOf}
        onOpenChange={files.onMenuOpenChange}
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
          // "Link X to this project…": X joins, the coordinator stays where it is, and the
          // dialog opens on what X gives up.
          joining
        />
      )}
      {files.dialog ? (
        <ProjectSyncDialog
          projectTitle={projectTitle}
          shown={files.dialog.shown}
          shownBlocked={files.dialog.shownBlocked}
          targets={files.dialog.targets}
          onClose={files.dialog.onClose}
          onCompare={files.dialog.onCompare}
        />
      ) : null}
      {fixMember && fixCoordinator ? (
        <ExtraCoordinatorFix
          member={fixMember}
          coordinator={fixCoordinator}
          shared={shared}
          projectTitle={projectTitle}
          onOpenSettings={onOpenSettings}
          onClose={() => setFixKey(null)}
        />
      ) : null}
    </>
  );
}
