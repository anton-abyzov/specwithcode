import { renderRich } from "../../i18n/rich";
import { useTx } from "../../i18n";
import { ConnectionsSettings } from "./ConnectionsSettings";
import type { FleetMachineCardExtras } from "./StudioFleetConnections";
import { MachineRemoteControl } from "./MachineRemoteControl";
import { AuthAccessWriteScope, type EnvironmentId } from "@specweave-studio/contracts";
import type { StudioFleetMachine } from "@specweave-studio/contracts/studioFleet";
import { Link } from "@tanstack/react-router";
import { EllipsisIcon, RefreshCwIcon } from "lucide-react";
import { type ReactNode, useMemo, useState } from "react";

import { isThisMachineTarget } from "../../connection/desktopLocal";
import { isElectron } from "../../env";
import { requestConfirmDialog } from "../../confirmDialog";
import { displayFolder } from "../../lib/displayFolder";
import { machineStatus } from "../../lib/machineStatus";
import { useProjects, useServerConfigs } from "../../state/entities";
import { useEnvironments, useRelayEnvironmentDiscovery } from "../../state/environments";
import { useEnvironmentScope } from "../../state/session";
import { addVisibleMachineToStudioFleet, useMachineWorkGrants } from "../../studio/fleet";
import { fleetMachineHasTailnetAddress } from "../../studio/fleetAutoConnect";
import {
  useAccountAutoConnectStates,
  requestAccountMachineConnect,
} from "../../studio/grantedAccountMachines";
import {
  machineColorProps,
  useKnownMachineIdentities,
  useMachineIdentities,
  useMachineIdentity,
} from "../../studio/machineIdentity";
import { useMachineNickname, useMachineNicknames } from "../../studio/machineNickname";
import { useHostLimitBlocks } from "../studio/shell/HostLimits";
import { Badge } from "../ui/badge";
import { Menu, MenuItem, MenuPopup, MenuTrigger } from "../ui/menu";
import { Button } from "../ui/button";
import { MiddleTruncate } from "../ui/middle-truncate";
import { Popover, PopoverPopup, PopoverTitle, PopoverTrigger } from "../ui/popover";
import { Tooltip, TooltipPopup, TooltipTrigger } from "../ui/tooltip";
import { ArchivedDisclosure } from "./ArchivedDisclosure";
import { MachineDot } from "../MachineDot";
import { MachineColorButton } from "./MachineColor";
import { RenameMachineDialog } from "./RenameMachineDialog";
import { stackedThreadToast, toastManager } from "../ui/toast";
import {
  buildMachineRows,
  type MachineProject,
  type MachineRowModel,
  type MachineSeen,
  ACCOUNT_NOT_REPORTED,
  withAccountConnectState,
} from "./machinesSettings.logic";
import { withReadableGrantLabels } from "./machineWorkGrants.logic";
import { AccountJoinCard } from "./AccountJoinCard";
import {
  AddProjectToMachine,
  AddProjectToMachineDialog,
  type AddProjectTarget,
} from "./AddProjectToMachine";
import { MachineSetupState, MachineSummary, type MachineSetup } from "./MachineSummary";
import { MachineWorkGrants } from "./MachineWorkGrants";
import { ConnectBothWays } from "./ConnectBothWays";
import { DetailLine } from "./DetailLine";
import {
  DirectionRow,
  IncomingButton,
  OutgoingButton,
  useWorkGrantChanges,
  type WorkGrantChanges,
} from "./MachineCardDirections";
import { incomingLine, outgoingLine } from "./machineDirections.logic";
import { AwayAccessRequestsAll } from "../away/AwayAccessRequests";
import { HandoffModeSettings } from "./HandoffModeSettings";
import { IncomingWorkerAction } from "./IncomingWorkerSetup";
import { isPhoneConnectShown, PhoneConnectSettings } from "./PhoneConnectSettings";
import { SettingHelp } from "./SettingHelp";
import {
  scrollToSettingsTarget,
  SettingsPageContainer,
  SettingsSection,
  TeamRulesLabel,
} from "./settingsLayout";
import { TeamRulesInert } from "./TeamRulesLock";
import { ThisMachineAdvanced } from "./ThisMachineAdvanced";
import { usePrimaryFleet } from "./usePrimaryFleet";
import { useReplacedMachineRecords } from "./useReplacedMachineRecords";
import { RemoveOldRecord } from "./RemoveOldRecord";

export type { MachineRowModel } from "./machinesSettings.logic";
export { ConnectBothWaysView, type CreatedLink } from "./ConnectBothWays";

/**
 * Settings > Machines, in one order: this machine and its one next step, your
 * phone, the other machines, who may run work here, then everything most
 * people never change, folded.
 */
export function MachinesSettingsPanel() {
  const tx = useTx();
  const fleet = usePrimaryFleet();
  const rawGrants = useMachineWorkGrants(fleet.primaryEnvironmentId);
  const { environments } = useEnvironments();
  const machineName = useMachineNicknames();
  // A coordinator the server cannot name gets a name this app knows, else a short id.
  const labeledSnapshot = useMemo(
    () =>
      withReadableGrantLabels(rawGrants.snapshot, (id) =>
        machineName(id, environments.find((entry) => entry.environmentId === id)?.label),
      ),
    [rawGrants.snapshot, environments, machineName],
  );
  const grants = { ...rawGrants, snapshot: labeledSnapshot };
  const grantChanges = useWorkGrantChanges(fleet.primaryEnvironmentId, grants);
  const hereLabel = fleet.primaryEnvironmentId
    ? machineName(
        fleet.primaryEnvironmentId,
        environments.find((entry) => entry.environmentId === fleet.primaryEnvironmentId)?.label ??
          "this machine",
      )
    : "this machine";
  const projects = useProjects();
  const configs = useServerConfigs();
  // Read once: the page shows sign-ins, not countdowns, so it never ticks.
  const [now] = useState(Date.now);
  const hostBlocks = useHostLimitBlocks(null, now);
  const [pending, setPending] = useState<EnvironmentId | null>(null);
  // The add dialog is the page's, not a card's: a card can leave the list while a clone runs.
  const [addingProject, setAddingProject] = useState<AddProjectTarget | null>(null);
  const [error, setError] = useState<string | null>(null);

  const accountStates = useAccountAutoConnectStates();
  const accountMachines = useRelayEnvironmentDiscovery().environments;
  const replaced = useReplacedMachineRecords(fleet.snapshot, fleet.primaryEnvironmentId);
  const builtRows = useMemo(
    () =>
      buildMachineRows({
        environments: environments.map((environment) => ({
          environmentId: environment.environmentId,
          label: environment.label,
          phase: environment.connection?.phase ?? "disconnected",
          statusText: environment.connection
            ? machineStatus(environment.connection, true, isThisMachineTarget(environment.entry))
                .text
            : "Not connected",
          teamRules: environment.serverConfig?.teamRules,
          configKnown: environment.serverConfig != null,
        })),
        primaryEnvironmentId: fleet.primaryEnvironmentId,
        fleet: fleet.snapshot,
        savedOrigins: fleet.savedOrigins,
        canPair: fleet.canPair,
        projects,
        hostBlocks,
        workGrants: grants.snapshot,
        scratchRootFor: (id) => configs.get(id)?.scratchWorkspaceRoot,
        displayName: machineName,
        replaced,
      }),
    [environments, fleet, hostBlocks, projects, grants.snapshot, configs, machineName, replaced],
  );
  const savedIds = useMemo(
    () => new Set<string>(environments.map((environment) => environment.environmentId)),
    [environments],
  );
  // Connect-only machines that allowed this one are saved over Connect, not paired.
  const rows = useMemo(
    () =>
      builtRows.map((row) =>
        withAccountConnectState(
          row,
          accountStates.get(row.environmentId),
          // Also while the account list is read again and is empty for a moment.
          accountMachines.has(row.environmentId) || accountStates.has(row.environmentId),
          savedIds.has(row.environmentId),
        ),
      ),
    [accountMachines, accountStates, builtRows, savedIds],
  );

  async function connect(machine: StudioFleetMachine) {
    if (pending) return;
    // A Connect-only machine of this account is saved over Connect, not paired.
    if (
      !fleetMachineHasTailnetAddress(machine) &&
      // A saved machine's Connect updates its address through the pairing below.
      !savedIds.has(machine.environmentId) &&
      (accountMachines.has(machine.environmentId) || accountStates.has(machine.environmentId))
    ) {
      setError(null);
      // Signed out of Connect, nothing saves it: the pairing below is tried.
      if (requestAccountMachineConnect([machine.environmentId])) return;
    }
    setPending(machine.environmentId);
    setError(null);
    try {
      await fleet.connect(machine);
    } catch (failure) {
      setError(failure instanceof Error ? failure.message : "Could not connect to this machine.");
    } finally {
      setPending(null);
    }
  }

  const renderRow = (
    row: MachineRowModel,
    details?: ReactNode,
    workersControl?: ReactNode,
    card?: FleetMachineCardExtras,
    bare = false,
  ) => (
    <MachineRow
      key={row.environmentId}
      row={row}
      bare={bare}
      hereLabel={hereLabel}
      grantChanges={grantChanges}
      durations={grants.snapshot?.durations === true}
      workersControl={workersControl}
      actions={card?.actions}
      gone={card?.gone}
      pending={pending}
      onConnect={(machine) => void connect(machine)}
      remoteControl={
        row.seen.state === "this-machine" ? null : (
          <MachineRemoteControl environmentId={row.environmentId} name={row.label} />
        )
      }
      addForAgents={
        row.canAddForAgents && fleet.primaryEnvironmentId ? (
          <AddForAgents row={row} primaryEnvironmentId={fleet.primaryEnvironmentId} />
        ) : null
      }
      connectBothWays={
        row.connectBothWays && fleet.primaryEnvironmentId ? (
          <ConnectBothWays row={row} primaryEnvironmentId={fleet.primaryEnvironmentId} />
        ) : null
      }
      allowBack={
        row.canAllowBack && fleet.primaryEnvironmentId ? (
          <AllowBack
            row={row}
            primaryEnvironmentId={fleet.primaryEnvironmentId}
            onGranted={grants.refresh}
          />
        ) : null
      }
      addProject={
        row.seen.state === "connected" && row.projects.own.length === 0 ? (
          <AddProjectToMachine
            environmentId={row.environmentId}
            name={machineName(row.environmentId, row.label)}
            onChoose={setAddingProject}
          />
        ) : null
      }
      details={details}
    />
  );
  const workGrants = fleet.primaryEnvironmentId ? (
    <MachineWorkGrants grants={grants} changes={grantChanges} />
  ) : null;
  // One card allows a machine of this SpecWithCode Connect account. It reads the grants itself.
  const joinCard = fleet.primaryEnvironmentId ? (
    <AccountJoinCard
      environmentId={fleet.primaryEnvironmentId}
      onShowConnectSwitch={() => scrollToSettingsTarget("connections-environment")}
    />
  ) : null;
  // This machine's own card holds what the summary does not: its projects and accounts.
  const hereRow = rows.find((row) => row.seen.state === "this-machine") ?? null;
  const page = (setup: MachineSetup | null) => (
    <>
      {error ? (
        <p role="alert" className="text-sm text-destructive-foreground">
          {error}
        </p>
      ) : null}
      {setup && fleet.primaryEnvironmentId ? (
        <MachineSummary environmentId={fleet.primaryEnvironmentId} rows={rows} setup={setup} />
      ) : null}
      {hereRow ? (
        <details data-machine-here-details className="rounded-xl border border-border/60 text-sm">
          <summary className="cursor-pointer rounded-xl px-4 py-2.5 text-sm text-muted-foreground focus-visible:outline-2 focus-visible:outline-ring">
            <span className="ml-2">{tx("Projects and accounts on this machine")}</span>
          </summary>
          <ul className="border-t border-border/50">
            {renderRow(hereRow, undefined, undefined, undefined, true)}
          </ul>
        </details>
      ) : null}
      <ConnectionsSettings
        additionalMachines={rows
          .filter(
            (row) =>
              row !== hereRow &&
              !fleet.snapshot?.machines.some(
                (machine) => machine.environmentId === row.environmentId,
              ),
          )
          .map((row) => renderRow(row))}
        renderMachine={(environmentId, controls, workersControl, card) => {
          const row = rows.find((item) => item.environmentId === environmentId);
          // This machine has its own fold above; the list holds the others.
          if (row && row === hereRow) return null;
          return row ? renderRow(row, <ul>{controls}</ul>, workersControl, card) : controls;
        }}
        renderLayout={(parts) => (
          <>
            {isPhoneConnectShown() ? (
              <PhoneConnectSettings setup={setup ?? undefined} pairRow={parts.pairPhone} />
            ) : (
              parts.pairPhone
            )}
            {parts.otherMachines}
            {joinCard}
            <AwayAccessRequestsAll />
            {workGrants}
            {fleet.primaryEnvironmentId ? (
              <HandoffModeSettings environmentId={fleet.primaryEnvironmentId} />
            ) : null}
            {parts.routing}
            <ThisMachineAdvanced>
              {parts.thisMachine}
              {parts.savedConnections}
            </ThisMachineAdvanced>
          </>
        )}
      />
      <AddProjectToMachineDialog target={addingProject} onClose={() => setAddingProject(null)} />
    </>
  );
  // The page container is the scroll area: without it Settings > Machines cannot scroll.
  return (
    <SettingsPageContainer width="wide">
      {fleet.primaryEnvironmentId ? (
        <MachineSetupState environmentId={fleet.primaryEnvironmentId}>{page}</MachineSetupState>
      ) : (
        page(null)
      )}
    </SettingsPageContainer>
  );
}

export function MachineListSection({
  rows,
  loading,
  pending,
  error,
  onRefresh,
  onConnect,
  renderAddForAgents,
  renderConnectBothWays,
}: {
  rows: readonly MachineRowModel[];
  loading: boolean;
  pending: EnvironmentId | null;
  error: string | null;
  onRefresh: () => void;
  onConnect: (machine: StudioFleetMachine) => void;
  renderAddForAgents?: (row: MachineRowModel) => ReactNode;
  renderConnectBothWays?: (row: MachineRowModel) => ReactNode;
}) {
  const tx = useTx();
  const name = useMachineNicknames();
  const thisRow = rows.find((row) => row.seen.state === "this-machine");
  const hereLabel = thisRow ? name(thisRow.environmentId, thisRow.label) : "this machine";
  return (
    <SettingsSection
      id="machines"
      title="Machines"
      headerAction={
        <Button size="xs" variant="ghost-muted" onClick={onRefresh} disabled={loading}>
          <RefreshCwIcon className="size-3" />
          {loading ? tx("Checking…") : tx("Refresh")}
        </Button>
      }
    >
      {rows.length === 0 ? (
        <p className="px-3 py-2.5 text-sm text-muted-foreground sm:px-4">
          {loading ? tx("Checking your machines…") : tx("No machines yet.")}
        </p>
      ) : (
        <ul className="divide-y divide-border/60">
          {rows.map((row) => (
            <MachineRow
              key={row.environmentId}
              row={row}
              hereLabel={hereLabel}
              pending={pending}
              onConnect={onConnect}
              addForAgents={
                row.canAddForAgents && renderAddForAgents ? renderAddForAgents(row) : null
              }
              connectBothWays={
                row.connectBothWays && renderConnectBothWays ? renderConnectBothWays(row) : null
              }
            />
          ))}
        </ul>
      )}
      <p className="border-t border-border/60 px-3 py-2 text-xs text-muted-foreground sm:px-4">
        {renderRich(
          tx(
            "Add a machine, manage its routes and allow or stop workers in {link}. Machines that may run work here are under Who can run work here. To disconnect one, use its card there: Remove machine stops agents here from using it, and Remove under Saved connections stops this app seeing it.",
          ),
          {
            link: (
              <Link to="/settings/machines" className="underline underline-offset-2">
                {tx("Advanced connection settings")}
              </Link>
            ),
          },
        )}
      </p>
      {error ? (
        <p
          role="alert"
          className="border-t border-border/60 px-3 py-2 text-xs text-destructive-foreground sm:px-4"
        >
          {error}
        </p>
      ) : null}
    </SettingsSection>
  );
}

const SEEN_DOT: Readonly<Record<MachineRowModel["seen"]["state"], string>> = {
  "this-machine": "bg-success",
  connected: "bg-success",
  elsewhere: "bg-warning",
  reachable: "bg-success/60",
  "not-connected": "bg-muted-foreground/50",
};

const ROLE_BADGE: Readonly<
  Record<NonNullable<MachineProject["role"]>, "info" | "secondary" | "warning" | "outline">
> = {
  coordinator: "info",
  "also-coordinator": "secondary",
  "runs-workers": "secondary",
  "handoff-pending": "warning",
  "only-here": "outline",
};

/** Text that may be cut short, in full on hover: paths run long, Windows paths longest. */
function HoverText({ text, className }: { text: string; className: string }) {
  if (!text) return <span className={className} />;
  return (
    <Tooltip>
      <TooltipTrigger delay={200} render={<span className={className} />}>
        {text}
      </TooltipTrigger>
      <TooltipPopup side="top" className="max-w-96 break-all">
        {text}
      </TooltipPopup>
    </Tooltip>
  );
}

/** Machines named on a row before the rest fold into "+N", so a long list never crowds it. */
const MAX_MACHINE_CHIPS = 2;

/** The machine a card is for, as its project lines name it. */
interface MachineHere {
  readonly environmentId: EnvironmentId;
  readonly name: string;
  readonly seen: MachineSeen;
}

/** The machine a copy is on, as "ministorm (This app can see it)", so its dot is never the only clue. */
function spokenMachine(machine: { name: string; seen: MachineSeen }): string {
  return `${machine.name} (${machine.seen.text})`;
}

/** The folder's own name, so a Windows path keeps it whole too: MiddleTruncate splits on "/" only. */
function folderNameTail(folder: string): { tail?: number } {
  if (folder.includes("/")) return {};
  const name = folder.split("\\").pop() ?? "";
  return name.length > 0 && name.length < folder.length ? { tail: name.length } : {};
}

/** Why a copy's folder is missing: a machine this app sees has simply not sent it yet. */
function missingFolderText(seen: MachineSeen): string {
  return seen.state === "this-machine" || seen.state === "connected"
    ? "Folder not loaded yet"
    : "Connect to see its folder";
}

/** What the "where" button reads aloud: every machine and the folder, though the row shows fewer. */
function projectWhereLabel(project: MachineProject, here: MachineHere): string {
  const elsewhere =
    project.elsewhere.length > 0
      ? `Also on ${project.elsewhere.map(spokenMachine).join("; ")}`
      : `Not shared, only on ${here.name}`;
  const folder = project.folder ? `. Folder on ${here.name}: ${project.folder}` : "";
  return `${project.title}: ${elsewhere}${folder}. Show every copy`;
}

/** A machine's name in its color, as the sidebar and composer chips wear it, with its status dot. */
function MachineChip({
  environmentId,
  name,
  seen,
}: {
  environmentId: EnvironmentId;
  name: string;
  seen: MachineSeen;
}) {
  const identity = useMachineIdentity(environmentId);
  return (
    <span
      {...machineColorProps(identity)}
      data-settings-machine-chip={environmentId}
      className="machine-chip inline-flex min-w-0 max-w-32 items-center gap-1 rounded-full border border-border/70 px-1.5 py-px text-foreground/80"
    >
      <span aria-hidden className={`size-1.5 shrink-0 rounded-full ${SEEN_DOT[seen.state]}`} />
      <span className="truncate">{name}</span>
    </span>
  );
}

/**
 * Where a project lives, at a glance: the other machines as chips with their
 * status dot, the first few by name and the rest as "+N", then this copy's
 * folder with the home folder as "~" and the end kept. Pressing it lists every
 * copy with its machine, status, role and full folder.
 */
function ProjectWhere({
  project,
  here,
}: {
  project: MachineProject;
  here: MachineHere;
}) {
  const tx = useTx();
  const identities = useMachineIdentities();
  const shown = project.elsewhere.slice(0, MAX_MACHINE_CHIPS);
  const folded = project.elsewhere.length - shown.length;
  const copies = [
    {
      key: "here",
      environmentId: here.environmentId,
      name: here.name,
      seen: here.seen,
      folder: project.folder,
      roleLabel: project.role ? project.roleLabel : null,
    },
    ...project.elsewhere.map((copy) => ({ key: copy.environmentId, ...copy })),
  ];
  return (
    <Popover>
      <PopoverTrigger
        openOnHover
        delay={300}
        closeDelay={100}
        render={
          <button
            type="button"
            aria-label={projectWhereLabel(project, here)}
            className="col-span-2 flex min-w-0 cursor-pointer items-center gap-1.5 rounded-sm text-left text-muted-foreground outline-hidden hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring sm:col-span-1"
          />
        }
      >
        {/* This card's own folder first, after its machine's color; the other machines follow. */}
        {project.folder ? (
          <>
            <MachineDot identity={identities(here.environmentId, here.name)} />
            <MiddleTruncate
              value={displayFolder(project.folder)}
              {...folderNameTail(displayFolder(project.folder))}
              showTitle={false}
              className="min-w-0 flex-1"
              data-copy-folder=""
            />
          </>
        ) : (
          <span className="min-w-0 flex-1" />
        )}
        {shown.length > 0 ? <span className="shrink-0">{tx("also on")}</span> : null}
        {shown.map((copy) => (
          <MachineChip
            key={copy.environmentId}
            environmentId={copy.environmentId}
            name={copy.name}
            seen={copy.seen}
          />
        ))}
        {folded > 0 ? (
          <span className="shrink-0 rounded-full border border-border/70 px-1.5 py-px text-foreground/80">
            +{folded}
          </span>
        ) : null}
      </PopoverTrigger>
      <PopoverPopup side="top" align="start" width="md" padding="compact">
        <PopoverTitle className="text-xs font-medium">
          {copies.length === 1
            ? `${project.title} is only on ${here.name}`
            : `${project.title} is on ${copies.length} machines`}
        </PopoverTitle>
        <ul className="mt-2 space-y-2 text-xs">
          {copies.map((copy) => (
            <li key={copy.key} className="min-w-0 space-y-0.5">
              <p className="flex min-w-0 items-center gap-1.5">
                <span
                  aria-hidden
                  className={`size-1.5 shrink-0 rounded-full ${SEEN_DOT[copy.seen.state]}`}
                />
                <MachineDot identity={identities(copy.environmentId, copy.name)} />
                <span className="truncate font-medium text-foreground">{copy.name}</span>
                <span className="shrink-0 text-muted-foreground">
                  {[copy.seen.text, copy.roleLabel]
                    .filter((part): part is string => Boolean(part))
                    .map((part) => tx(part))
                    .join(" · ")}
                </span>
              </p>
              <p className="select-text break-all pl-3 font-mono text-2xs text-muted-foreground">
                {copy.folder ?? missingFolderText(copy.seen)}
              </p>
            </li>
          ))}
        </ul>
      </PopoverPopup>
    </Popover>
  );
}

/**
 * The other machines signed in to the same account, as chips like a project's.
 * The rest fold into "+N", a button whose tooltip names them all; a screen
 * reader hears every name either way.
 */
function AccountAlsoOn({ names }: { names: readonly string[] }) {
  const tx = useTx();
  // The names come from the limits list, which names a machine as everywhere else;
  // a name two machines share gets no color rather than a wrong one.
  const known = useKnownMachineIdentities();
  const byName = useMemo(() => {
    const found = new Map<string, (typeof known)[number] | null>();
    for (const identity of known) {
      found.set(identity.name, found.has(identity.name) ? null : identity);
    }
    return found;
  }, [known]);
  const shown = names.slice(0, MAX_MACHINE_CHIPS);
  const rest = names.slice(MAX_MACHINE_CHIPS);
  return (
    <span className="flex min-w-0 items-center gap-1">
      <span className="sr-only">
        {renderRich(tx("also on {value}"), { value: names.join(", ") })}
      </span>
      <span aria-hidden className="shrink-0">
        {tx("also on")}
      </span>
      {shown.map((name) => (
        <span
          key={name}
          aria-hidden
          {...machineColorProps(byName.get(name))}
          className="machine-chip min-w-0 max-w-32 truncate rounded-full border border-border/70 px-1.5 py-px text-foreground/80"
        >
          {name}
        </span>
      ))}
      {rest.length > 0 ? (
        <Tooltip>
          <TooltipTrigger
            delay={200}
            render={
              <button
                type="button"
                aria-label={`Same account on ${names.join(", ")}`}
                className="shrink-0 cursor-help rounded-full border border-border/70 px-1.5 py-px text-foreground/80 outline-hidden hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring"
              />
            }
          >
            +{rest.length}
          </TooltipTrigger>
          <TooltipPopup side="top" className="max-w-72">
            {renderRich(tx("Same account on {value}"), { value: names.join(", ") })}
          </TooltipPopup>
        </Tooltip>
      ) : null}
    </span>
  );
}

/** One grid, so names, labels and folders line up however long a name or path is. */
function ProjectList({
  projects,
  here,
}: {
  projects: readonly MachineProject[];
  here: MachineHere;
}) {
  const tx = useTx();
  return (
    <ul className="grid grid-cols-[minmax(0,1fr)_auto] items-center gap-x-3 gap-y-1 text-xs sm:grid-cols-[minmax(0,14rem)_auto_minmax(0,1fr)]">
      {projects.map((project) => (
        <li key={project.key} className="contents">
          <HoverText text={project.title} className="truncate text-foreground" />
          <Tooltip>
            <TooltipTrigger
              delay={200}
              render={<span className="inline-flex justify-self-start" />}
            >
              <Badge size="sm" variant={project.role ? ROLE_BADGE[project.role] : "secondary"}>
                {tx(project.roleLabel)}
              </Badge>
            </TooltipTrigger>
            <TooltipPopup side="top" className="max-w-72">
              {tx(project.roleHelp)}
            </TooltipPopup>
          </Tooltip>
          <ProjectWhere project={project} here={here} />
        </li>
      ))}
    </ul>
  );
}

/** The sign-ins a machine reports: on this machine's card, else in Connection details. */
/** A card lists this many projects, then "Show N more". */
const MAX_PROJECTS_SHOWN = 5;

function AccountsLine({ accounts }: { accounts: MachineRowModel["accounts"] }) {
  const tx = useTx();
  return (
    <DetailLine label={tx("Accounts")}>
      {accounts === null ? (
        <p className="text-xs text-muted-foreground">{tx("Connect to see its accounts.")}</p>
      ) : accounts.length === 0 ? (
        <p className="text-xs text-muted-foreground">{tx("No account reported.")}</p>
      ) : (
        <ul className="space-y-0.5">
          {accounts.map((account) => (
            <li
              key={account.key}
              className="flex min-w-0 flex-wrap items-center gap-x-1.5 gap-y-1 text-xs text-muted-foreground"
            >
              <span className="min-w-0 truncate">
                <span className="text-foreground/80">{account.provider}</span> ·{" "}
                {account.identity === ACCOUNT_NOT_REPORTED
                  ? tx(ACCOUNT_NOT_REPORTED)
                  : account.identity}
              </span>
              {account.alsoOn.length > 0 ? <AccountAlsoOn names={account.alsoOn} /> : null}
            </li>
          ))}
        </ul>
      )}
    </DetailLine>
  );
}

export function MachineRow({
  remoteControl,
  workersControl,
  actions,
  gone,
  details,
  row,
  hereLabel,
  pending,
  onConnect,
  addForAgents,
  connectBothWays,
  allowBack,
  addProject,
  grantChanges = null,
  durations = false,
  devices,
  bare = false,
}: {
  /** Without the name line and Rename: this machine's card under the page's own summary. */
  bare?: boolean;
  /** Stop and Allow… on the incoming row; null where the card only shows the grant. */
  grantChanges?: WorkGrantChanges | null;
  /** This machine takes a time limit on Allow. */
  durations?: boolean;
  /**
   * Slot for "Devices that can use this machine" (increment 1327): the people plane,
   * above the two agent direction rows. Nothing shows until that list exists.
   */
  devices?: ReactNode;
  remoteControl?: ReactNode;
  /** The Allow workers control for agents here; it sits on the first access line. */
  workersControl?: ReactNode;
  /** Stop workers and Remove machine, shown in the header so they need no disclosure. */
  actions?: ReactNode;
  /** Shown under the header when the machine no longer answers: says so and offers Remove. */
  gone?: ReactNode;
  details?: ReactNode;
  row: MachineRowModel;
  /** This machine's name, so each grant line names its direction. */
  hereLabel: string;
  pending: EnvironmentId | null;
  onConnect: (machine: StudioFleetMachine) => void;
  addForAgents?: ReactNode;
  connectBothWays?: ReactNode;
  /** Shown where the grant would be until that machine may run work here. */
  allowBack?: ReactNode;
  /** The next step for a connected machine with no project of its own: add one. */
  addProject?: ReactNode;
}) {
  const tx = useTx();
  const seen = row.seen.state === "this-machine" || row.seen.state === "connected";
  const [renaming, setRenaming] = useState(false);
  const nickname = useMachineNickname(row.environmentId, row.label);
  const hostNames = [row.label === nickname ? null : row.label, row.machineName]
    .filter((name): name is string => name !== null)
    .join(" · ");
  const identity = useMachineIdentity(row.environmentId, row.label);
  const here = { environmentId: row.environmentId, name: nickname, seen: row.seen };
  const [detailsOpen, setDetailsOpen] = useState(false);
  const [allProjects, setAllProjects] = useState(false);
  const thisMachine = row.seen.state === "this-machine";
  const incoming = incomingLine(
    { there: nickname, workHere: row.workHere, durations, canSetUp: Boolean(allowBack) },
    tx,
  );
  const outgoing = outgoingLine(
    {
      there: nickname,
      workers: row.workers,
      canSetUp: Boolean(addForAgents) || Boolean(row.workers && workersControl),
    },
    tx,
  );
  const message =
    grantChanges && grantChanges.about === row.environmentId
      ? grantChanges.error
        ? { text: grantChanges.error, alert: true }
        : // A stopped or ended row already says what happened in its note.
          grantChanges.notice && incoming.note === null
          ? { text: grantChanges.notice, alert: false }
          : null
      : null;
  const shownProjects = allProjects
    ? row.projects.own
    : row.projects.own.slice(0, MAX_PROJECTS_SHOWN);
  return (
    <li
      {...(bare ? {} : machineColorProps(identity))}
      className="machine-card flex min-w-0 flex-col gap-2 px-3 py-2.5 sm:px-4"
      aria-label={nickname}
    >
      <div className={bare ? "hidden" : "flex min-w-0 flex-wrap items-center gap-3"}>
        {/* Pulled in by a step each side, so the name still starts where the lines below do. */}
        <MachineColorButton
          environmentId={row.environmentId}
          fallbackLabel={row.label}
          className="-mx-1"
        />
        <div className="min-w-0 flex-1">
          <h3 className="text-sm break-words sm:truncate">
            {nickname}
            {hostNames ? <span className="text-muted-foreground"> · {hostNames}</span> : null}
            {row.replacedBy ? (
              <Badge variant="outline" size="sm" className="ml-2 align-middle">
                {tx("Old record")}
              </Badge>
            ) : null}
          </h3>
          <p className="flex min-w-0 items-center gap-1.5 text-xs text-muted-foreground">
            <span
              aria-hidden
              className={`size-1.5 shrink-0 rounded-full ${SEEN_DOT[row.seen.state]}`}
            />
            <span className="break-words text-foreground/80 sm:truncate">
              {tx(row.seen.text)}
              {row.seen.detail ? ` (${row.seen.detail})` : null}
            </span>
          </p>
        </div>
        <RenameMachineDialog
          environmentId={row.environmentId}
          hostLabel={row.label}
          open={renaming}
          onOpenChange={setRenaming}
        />
        {remoteControl || row.connect ? (
          <div className="flex w-full flex-wrap items-center gap-2 pl-7 sm:w-auto sm:pl-0">
            {remoteControl}
            {row.connect && row.fleetMachine ? (
              <>
                {row.connectLock ? <TeamRulesLabel>{row.connectLock.setBy}</TeamRulesLabel> : null}
                <TeamRulesInert lock={row.connectLock}>
                  <Button
                    className="shrink-0"
                    size="xs"
                    variant="outline"
                    disabled={pending !== null || !row.connect.enabled}
                    onClick={() => row.fleetMachine && onConnect(row.fleetMachine)}
                  >
                    {pending === row.environmentId ? tx("Connecting…") : tx(row.connect.label)}
                  </Button>
                </TeamRulesInert>
              </>
            ) : null}
          </div>
        ) : null}
        <Menu>
          <MenuTrigger
            render={
              <Button
                className="shrink-0"
                size="icon-xs"
                variant="ghost-muted"
                aria-label={tx("More for {machine}", { machine: nickname })}
                data-machine-more=""
              />
            }
          >
            <EllipsisIcon className="size-3.5" />
          </MenuTrigger>
          <MenuPopup align="end">
            <MenuItem onClick={() => setRenaming(true)}>{tx("Rename…")}</MenuItem>
            <MenuItem data-connection-details="" onClick={() => setDetailsOpen((open) => !open)}>
              {detailsOpen ? tx("Hide connection details") : tx("Connection details")}
            </MenuItem>
          </MenuPopup>
        </Menu>
        {row.replacedBy ? (
          <RemoveOldRecord
            environmentId={row.environmentId}
            name={nickname}
            hostLabel={row.label}
          />
        ) : null}
      </div>

      {gone ? <div className="pl-7">{gone}</div> : null}
      {row.connect && row.connectLock ? (
        <div className="pl-7">
          <p className="text-xs text-muted-foreground">{row.connectLock.message}</p>
        </div>
      ) : null}

      {devices ? (
        <div className="pl-7" data-slot="machine-devices">
          {devices}
        </div>
      ) : null}

      {thisMachine ? null : (
        <div className="flex min-w-0 flex-col gap-1.5 pl-7" data-slot="machine-directions">
          <DirectionRow
            direction="incoming"
            line={incoming}
            message={message}
            button={
              <IncomingButton
                line={incoming}
                there={nickname}
                coordinatorEnvironmentId={row.environmentId}
                durations={durations}
                changes={grantChanges}
                onSetUp={() => setDetailsOpen(true)}
              />
            }
          />
          <DirectionRow
            direction="outgoing"
            line={outgoing}
            button={<OutgoingButton line={outgoing} onOpen={() => setDetailsOpen(true)} />}
          />
        </div>
      )}

      {detailsOpen ? (
        <div
          className="ml-7 flex min-w-0 flex-col gap-3 rounded-lg border border-border/60 px-3 py-2.5 text-xs [&>.pl-7]:pl-0"
          data-slot="connection-details"
        >
          <p className="flex items-center gap-1 font-medium text-foreground/80">
            {tx("Connection details")}
            <SettingHelp label={tx("Connection details")}>
              {tx(
                "{there} can start work here: its agents may start threads in this machine's projects. Stop refuses new work at once; threads it already runs stop 2 minutes later. This machine can start work on {there}: agents here may start threads there, up to the access {there} allows.",
                { there: nickname },
              )}
            </SettingHelp>
          </p>
          {row.workers ? (
            workersControl ? (
              <div className="min-w-0 space-y-1">
                <p className="text-foreground/80">
                  {tx("Most access for agents from {hereLabel}", { hereLabel })}
                </p>
                {workersControl}
              </div>
            ) : null
          ) : (
            addForAgents
          )}
          {row.workHere ? null : allowBack}
          {connectBothWays}
          {details}
          {actions ? <div className="flex flex-wrap items-center gap-1">{actions}</div> : null}
          <AccountsLine accounts={row.accounts} />
        </div>
      ) : null}

      {row.teamRules ? (
        <DetailLine label={tx("Team rules")}>
          <p className="flex min-w-0 flex-wrap items-center gap-1.5 text-xs text-muted-foreground">
            <Badge size="sm" variant={row.teamRules.tone}>
              {row.teamRules.label}
            </Badge>
            {row.teamRules.fingerprint ? (
              <span className="font-mono">
                {renderRich(tx("rules {fingerprint}"), { fingerprint: row.teamRules.fingerprint })}
              </span>
            ) : null}
            {row.teamRules.detail ? <span>{row.teamRules.detail}</span> : null}
          </p>
        </DetailLine>
      ) : null}

      <DetailLine
        label={tx("Projects")}
        help="This machine's projects. For a machine this app cannot see, only those it shares with one it can. Automated ones were made by checks or agents; archived ones are kept but out of your lists. Both stay collapsed, as in the sidebar."
      >
        {row.projects.own.length > 0 ? (
          <>
            <ProjectList projects={shownProjects} here={here} />
            {row.projects.own.length > MAX_PROJECTS_SHOWN ? (
              <Button
                size="xs"
                variant="ghost-muted"
                className="-ml-2"
                data-projects-more=""
                onClick={() => setAllProjects((all) => !all)}
              >
                {allProjects
                  ? tx("Show fewer")
                  : tx("Show {count} more", {
                      count: String(row.projects.own.length - MAX_PROJECTS_SHOWN),
                    })}
              </Button>
            ) : null}
          </>
        ) : (
          <p className="text-xs text-muted-foreground">
            {seen ? tx("No projects of your own here.") : tx("Connect to see its projects.")}
          </p>
        )}
        {addProject}
        <ArchivedDisclosure
          count={row.projects.automated.length}
          label={tx("automated")}
          className="-ml-3 sm:-ml-4"
        >
          <div className="pl-3 sm:pl-4">
            <ProjectList projects={row.projects.automated} here={here} />
          </div>
        </ArchivedDisclosure>
        <ArchivedDisclosure count={row.projects.archived.length} className="-ml-3 sm:-ml-4">
          <div className="pl-3 sm:pl-4">
            <ProjectList projects={row.projects.archived} here={here} />
          </div>
        </ArchivedDisclosure>
      </DetailLine>

      {thisMachine ? <AccountsLine accounts={row.accounts} /> : null}
    </li>
  );
}

/**
 * The other direction of a pair: that machine is connected but may not run
 * work here. When this machine lists it, this machine's server asks it to add
 * and allow this one; otherwise the existing incoming setup does both there,
 * after the same confirmation. Once the grants refresh, the card shows the
 * grant instead.
 */
export function AllowBack({
  row,
  primaryEnvironmentId,
  onGranted,
}: {
  row: MachineRowModel;
  primaryEnvironmentId: EnvironmentId;
  onGranted: () => void;
}) {
  const tx = useTx();
  const name = useMachineNicknames();
  const { environments } = useEnvironments();
  const hereLabel = name(
    primaryEnvironmentId,
    environments.find((environment) => environment.environmentId === primaryEnvironmentId)?.label ??
      "this machine",
  );
  const coordinatorLabel = name(row.environmentId, row.label);
  // The card's row already says this direction is not set up; this is its setup.
  return (
    <div className="min-w-0 space-y-1" data-slot="allow-back">
      <p className="text-foreground/80">
        {tx("Let {thereLabel} start work here", { thereLabel: coordinatorLabel })}
      </p>
      <IncomingWorkerAction
        here={primaryEnvironmentId}
        coordinator={row.environmentId}
        hereLabel={hereLabel}
        coordinatorLabel={coordinatorLabel}
        connected={row.seen.state === "connected"}
        coordinatorFleetId={row.fleetMachine?.id}
        accountJoin={
          environments.find((environment) => environment.environmentId === row.environmentId)
            ?.serverConfig?.environment.capabilities.fleetAccountJoinWorkers === true
        }
        actionLabel={tx("Allow {coordinatorLabel}", { coordinatorLabel })}
        onGranted={onGranted}
      />
    </div>
  );
}

/**
 * This app already reaches both machines, so it carries the invitation line
 * between them: no ID to copy and nothing to paste. The line stays inside
 * the call. Allowing workers is still the person's separate choice.
 */
function AddForAgents({
  row,
  primaryEnvironmentId,
}: {
  row: MachineRowModel;
  primaryEnvironmentId: EnvironmentId;
}) {
  const canInvite = useEnvironmentScope(row.environmentId, AuthAccessWriteScope);
  const canAdd = useEnvironmentScope(primaryEnvironmentId, AuthAccessWriteScope);
  const nickname = useMachineNickname(row.environmentId, row.label);
  const { environments } = useEnvironments();
  const hereLabel = useMachineNickname(
    primaryEnvironmentId,
    environments.find((entry) => entry.environmentId === primaryEnvironmentId)?.label ??
      "this machine",
  );
  const [adding, setAdding] = useState(false);
  const [added, setAdded] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function add() {
    if (adding || added) return;
    // Fail closed: no mounted confirm host means no grant.
    const confirmed = await requestConfirmDialog(
      `Let this machine manage ${row.label}?\nThis machine's server gets a key to ${row.label} for a year, which can manage its access, updates and skills. Agents still cannot start work there until you allow workers.`,
    );
    if (confirmed !== true) return;
    setAdding(true);
    setError(null);
    try {
      await addVisibleMachineToStudioFleet(primaryEnvironmentId, row.environmentId, row.label);
      setAdded(true);
    } catch (failure) {
      setError(failure instanceof Error ? failure.message : "Could not add this machine.");
    } finally {
      setAdding(false);
    }
  }

  return (
    <AddForAgentsView
      machineLabel={nickname}
      hereLabel={hereLabel}
      allowed={isElectron && canInvite && canAdd}
      adding={adding}
      added={added}
      error={error}
      onAdd={() => void add()}
    />
  );
}

export function AddForAgentsView({
  machineLabel,
  hereLabel = "this machine",
  allowed,
  adding,
  added = false,
  error,
  onAdd,
}: {
  machineLabel: string;
  /** This machine's name, so the line names its direction. */
  hereLabel?: string;
  /** The desktop app holding full access to both machines; a browser tab is refused. */
  allowed: boolean;
  adding: boolean;
  added?: boolean;
  error: string | null;
  onAdd: () => void;
}) {
  const tx = useTx();
  return (
    <DetailLine
      label={tx("Agents on {hereLabel} can start work on {thereLabel}", {
        hereLabel,
        thereLabel: machineLabel,
      })}
      help="Seeing a machine in this app does not tell this machine's server about it. Adding it gives the server its own key to that machine for a year, which can manage its access, updates and skills, with this window closed. Agents still cannot start work until you allow workers."
    >
      <div className="flex min-w-0 flex-col gap-2 sm:flex-row sm:items-center sm:justify-between">
        <p className="text-xs text-muted-foreground">
          {added ? (
            <>
              {tx("Added {machineLabel}. Choose Allow on this line after Refresh.", {
                machineLabel,
              })}
            </>
          ) : allowed ? (
            `Not set up yet. Step 1: add ${machineLabel} so this machine's server can reach it. Step 2: Allow.`
          ) : (
            `Adding ${machineLabel} from here needs the desktop app with full access to it. Otherwise, on ${machineLabel}, choose Join a main machine under Settings > Machines.`
          )}
        </p>
        {allowed && !added ? (
          <Button
            className="shrink-0 self-start sm:self-auto"
            size="xs"
            variant="outline"
            disabled={adding}
            onClick={onAdd}
          >
            {adding ? tx("Adding…") : tx("Add {machineLabel}", { machineLabel })}
          </Button>
        ) : null}
      </div>
      {error ? (
        <p role="alert" className="text-xs text-destructive-foreground">
          {error}
        </p>
      ) : null}
    </DetailLine>
  );
}
