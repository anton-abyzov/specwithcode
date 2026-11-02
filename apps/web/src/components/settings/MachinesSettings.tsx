import { useAtomValue } from "@effect/atom-react";
import {
  AuthAccessWriteScope,
  AuthStandardClientScopes,
  type AdvertisedEndpoint,
  type EnvironmentId,
} from "@specweave-studio/contracts";
import type { StudioFleetMachine } from "@specweave-studio/contracts/studioFleet";
import { Link } from "@tanstack/react-router";
import * as DateTime from "effect/DateTime";
import * as Option from "effect/Option";
import { AsyncResult } from "effect/reactivity";
import { InfoIcon, LaptopIcon, PencilIcon, RefreshCwIcon } from "lucide-react";
import { type ReactNode, useMemo, useState } from "react";

import { isThisMachineTarget } from "../../connection/desktopLocal";
import { isElectron } from "../../env";
import { requestConfirmDialog } from "../../confirmDialog";
import {
  createServerPairingCredential,
  readPrimaryEnvironmentTarget,
} from "../../environments/primary";
import { machineStatus } from "../../lib/machineStatus";
import { desktopNetworkAccessStateAtom } from "../../state/desktopNetworkAccess";
import { useProjects, useServerConfigs } from "../../state/entities";
import { useEnvironments } from "../../state/environments";
import { readEnvironmentScope, useEnvironmentScope } from "../../state/session";
import {
  addVisibleMachineToStudioFleet,
  useMachineWorkGrants,
  useStudioFleet,
} from "../../studio/fleet";
import { useMachineNickname, useMachineNicknames } from "../../studio/machineNickname";
import { useHostLimitBlocks } from "../studio/shell/HostLimits";
import { Badge } from "../ui/badge";
import { Button } from "../ui/button";
import { Input } from "../ui/input";
import { Tooltip, TooltipPopup, TooltipTrigger } from "../ui/tooltip";
import { ArchivedDisclosure } from "./ArchivedDisclosure";
import { RenameMachineDialog } from "./RenameMachineDialog";
import { stackedThreadToast, toastManager } from "../ui/toast";
import {
  buildMachineRows,
  connectBothWaysInstruction,
  pairingLinkBaseUrl,
  type MachineProject,
  type MachineRowModel,
  type MachineWorkerGrant,
  type MachineWorkHere,
} from "./machinesSettings.logic";
import { withReadableGrantLabels } from "./machineWorkGrants.logic";
import { MachineWorkGrants } from "./MachineWorkGrants";
import { HandoffModeSettings } from "./HandoffModeSettings";
import { resolveDesktopPairingUrl } from "./pairingUrls";
import { SettingsPageContainer, SettingsSection } from "./settingsLayout";
import { usePrimaryFleet } from "./usePrimaryFleet";

export type { MachineRowModel } from "./machinesSettings.logic";

const NO_ENDPOINTS: ReadonlyArray<AdvertisedEndpoint> = [];

// The desktop bridge is fixed for the window's lifetime, so the hook choice is too.
const useDesktopAdvertisedEndpoints = isElectron
  ? () => {
      const result = useAtomValue(desktopNetworkAccessStateAtom);
      return Option.getOrNull(AsyncResult.value(result))?.advertisedEndpoints ?? NO_ENDPOINTS;
    }
  : () => NO_ENDPOINTS;

/** The server this window talks to, which is not always the page's own origin. */
function currentServerOrigin(): string | null {
  try {
    return readPrimaryEnvironmentTarget()?.target.httpBaseUrl ?? window.location.origin;
  } catch {
    return null;
  }
}

/** Settings > Machines: the machines this app knows of, then who may run work on this one. */
export function MachinesSettingsPanel() {
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
  const projects = useProjects();
  const configs = useServerConfigs();
  // Read once: the page shows sign-ins, not countdowns, so it never ticks.
  const [now] = useState(Date.now);
  const hostBlocks = useHostLimitBlocks(null, now);
  const [pending, setPending] = useState<EnvironmentId | null>(null);
  const [error, setError] = useState<string | null>(null);

  const rows = useMemo(
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
      }),
    [environments, fleet, hostBlocks, projects, grants.snapshot, configs, machineName],
  );

  async function connect(machine: StudioFleetMachine) {
    if (pending) return;
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

  return (
    <SettingsPageContainer>
      <MachineListSection
        rows={rows}
        loading={fleet.loading}
        pending={pending}
        error={error}
        onRefresh={fleet.refresh}
        onConnect={(machine) => void connect(machine)}
        renderAddForAgents={(row) =>
          fleet.primaryEnvironmentId === null ? null : (
            <AddForAgents row={row} primaryEnvironmentId={fleet.primaryEnvironmentId} />
          )
        }
        renderConnectBothWays={(row) =>
          fleet.primaryEnvironmentId === null ? null : (
            <ConnectBothWays row={row} primaryEnvironmentId={fleet.primaryEnvironmentId} />
          )
        }
      />
      {fleet.primaryEnvironmentId ? (
        <MachineWorkGrants environmentId={fleet.primaryEnvironmentId} grants={grants} />
      ) : null}
      {fleet.primaryEnvironmentId ? (
        <HandoffModeSettings environmentId={fleet.primaryEnvironmentId} />
      ) : null}
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
  return (
    <SettingsSection
      id="machines"
      title="Machines"
      headerAction={
        <Button size="xs" variant="ghost-muted" onClick={onRefresh} disabled={loading}>
          <RefreshCwIcon className="size-3" />
          {loading ? "Checking…" : "Refresh"}
        </Button>
      }
    >
      {rows.length === 0 ? (
        <p className="px-3 py-2.5 text-sm text-muted-foreground sm:px-4">
          {loading ? "Checking your machines…" : "No machines yet."}
        </p>
      ) : (
        <ul className="divide-y divide-border/60">
          {rows.map((row) => (
            <MachineRow
              key={row.environmentId}
              row={row}
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
        Add machines and allow or stop workers on them in{" "}
        <Link to="/settings/connections" className="underline underline-offset-2">
          Settings &gt; Connections
        </Link>
        . Machines that may run work here are under Who can run work here. To disconnect one, use
        its card there: Remove machine stops agents here from using it, and Remove under
        Environments stops this app seeing it.
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
  "not-connected": "bg-muted-foreground/50",
};

const WORK_HERE_BADGE: Readonly<
  Record<MachineWorkHere["status"], "success" | "warning" | "secondary">
> = {
  active: "success",
  revoked: "secondary",
  expired: "warning",
};

const WORKER_BADGE: Readonly<
  Record<MachineWorkerGrant["status"], "success" | "warning" | "secondary">
> = {
  allowed: "success",
  expiring: "warning",
  "not-allowed": "secondary",
};

function DetailLine({
  label,
  help,
  children,
}: {
  label: string;
  /** Shown on hover beside the label. */
  help?: string;
  children: ReactNode;
}) {
  return (
    <div className="min-w-0 space-y-1 pl-7">
      <p className="flex items-center gap-1 text-xs text-foreground/80">
        {label}
        {help ? (
          <Tooltip>
            <TooltipTrigger
              delay={200}
              render={
                <Button size="icon-micro" variant="ghost-muted" aria-label={`About ${label}`}>
                  <InfoIcon className="size-3" />
                </Button>
              }
            />
            <TooltipPopup side="top" className="max-w-72">
              {help}
            </TooltipPopup>
          </Tooltip>
        ) : null}
      </p>
      {children}
    </div>
  );
}

const ROLE_BADGE: Readonly<
  Record<NonNullable<MachineProject["role"]>, "info" | "secondary" | "warning" | "outline">
> = {
  coordinator: "info",
  "runs-workers": "secondary",
  "handoff-pending": "warning",
  "only-here": "outline",
};

function projectWhere(project: MachineProject): string {
  const alsoOn = project.alsoOn.length > 0 ? `Also on ${project.alsoOn.join(", ")}` : null;
  return [alsoOn, project.folder].filter((part) => part !== null).join(" · ");
}

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

/** One grid, so names, labels and folders line up however long a name or path is. */
function ProjectList({ projects }: { projects: readonly MachineProject[] }) {
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
                {project.roleLabel}
              </Badge>
            </TooltipTrigger>
            <TooltipPopup side="top" className="max-w-72">
              {project.roleHelp}
            </TooltipPopup>
          </Tooltip>
          <HoverText
            text={projectWhere(project)}
            className="col-span-2 min-w-0 truncate text-muted-foreground sm:col-span-1"
          />
        </li>
      ))}
    </ul>
  );
}

export function MachineRow({
  row,
  pending,
  onConnect,
  addForAgents,
  connectBothWays,
}: {
  row: MachineRowModel;
  pending: EnvironmentId | null;
  onConnect: (machine: StudioFleetMachine) => void;
  addForAgents?: ReactNode;
  connectBothWays?: ReactNode;
}) {
  const seen = row.seen.state === "this-machine" || row.seen.state === "connected";
  const [renaming, setRenaming] = useState(false);
  const nickname = useMachineNickname(row.environmentId, row.label);
  const hostNames = [row.label === nickname ? null : row.label, row.machineName]
    .filter((name): name is string => name !== null)
    .join(" · ");
  return (
    <li className="flex min-w-0 flex-col gap-2 px-3 py-2.5 sm:px-4" aria-label={nickname}>
      <div className="flex min-w-0 items-center gap-3">
        <LaptopIcon aria-hidden className="size-4 shrink-0 text-foreground/70" />
        <div className="min-w-0 flex-1">
          <h3 className="truncate text-sm">
            {nickname}
            {hostNames ? <span className="text-muted-foreground"> · {hostNames}</span> : null}
          </h3>
          <p className="flex min-w-0 items-center gap-1.5 text-xs text-muted-foreground">
            <span
              aria-hidden
              className={`size-1.5 shrink-0 rounded-full ${SEEN_DOT[row.seen.state]}`}
            />
            <span className="truncate text-foreground/80">{row.seen.text}</span>
          </p>
        </div>
        <Button
          className="shrink-0"
          size="icon-xs"
          variant="ghost-muted"
          aria-label={`Rename ${nickname}`}
          title="Rename"
          onClick={() => setRenaming(true)}
        >
          <PencilIcon className="size-3" />
        </Button>
        <RenameMachineDialog
          environmentId={row.environmentId}
          hostLabel={row.label}
          open={renaming}
          onOpenChange={setRenaming}
        />
        {row.connect && row.fleetMachine ? (
          <Button
            className="shrink-0"
            size="xs"
            variant="outline"
            disabled={pending !== null || !row.connect.enabled}
            onClick={() => row.fleetMachine && onConnect(row.fleetMachine)}
          >
            {pending === row.environmentId ? "Connecting…" : row.connect.label}
          </Button>
        ) : null}
      </div>

      {row.workers ? (
        <DetailLine
          label="Workers from this machine"
          help="Whether agents on this machine may start work there. You decide this for each machine."
        >
          <p className="flex min-w-0 flex-wrap items-center gap-1.5 text-xs text-muted-foreground">
            <Badge size="sm" variant={WORKER_BADGE[row.workers.status]}>
              {row.workers.label}
            </Badge>
            <span>{row.workers.detail}</span>
            {row.workers.status === "not-allowed" ? (
              <Link to="/settings/connections" className="underline underline-offset-2">
                Allow workers
              </Link>
            ) : null}
          </p>
        </DetailLine>
      ) : null}

      {addForAgents}

      {row.workHere ? (
        <DetailLine label="Work it may run here">
          <p className="flex min-w-0 flex-wrap items-center gap-1.5 text-xs text-muted-foreground">
            <Badge size="sm" variant={WORK_HERE_BADGE[row.workHere.status]}>
              {row.workHere.label}
            </Badge>
            <span>{row.workHere.detail}</span>
          </p>
        </DetailLine>
      ) : null}

      <DetailLine
        label="Projects"
        help="This machine's projects. For a machine this app cannot see, only those it shares with one it can. Automated ones were made by checks or agents; archived ones are kept but out of your lists. Both stay collapsed, as in the sidebar."
      >
        {row.projects.own.length > 0 ? (
          <ProjectList projects={row.projects.own} />
        ) : (
          <p className="text-xs text-muted-foreground">
            {seen ? "No projects of your own here." : "Connect to see its projects."}
          </p>
        )}
        <ArchivedDisclosure
          count={row.projects.automated.length}
          label="automated"
          className="-ml-3 sm:-ml-4"
        >
          <div className="pl-3 sm:pl-4">
            <ProjectList projects={row.projects.automated} />
          </div>
        </ArchivedDisclosure>
        <ArchivedDisclosure count={row.projects.archived.length} className="-ml-3 sm:-ml-4">
          <div className="pl-3 sm:pl-4">
            <ProjectList projects={row.projects.archived} />
          </div>
        </ArchivedDisclosure>
      </DetailLine>

      <DetailLine label="Accounts">
        {row.accounts === null ? (
          <p className="text-xs text-muted-foreground">Connect to see its accounts.</p>
        ) : row.accounts.length === 0 ? (
          <p className="text-xs text-muted-foreground">No account reported.</p>
        ) : (
          <ul className="space-y-0.5">
            {row.accounts.map((account) => (
              <li key={account.key} className="truncate text-xs text-muted-foreground">
                <span className="text-foreground/80">{account.provider}</span> · {account.identity}
                {account.alsoOn.length > 0 ? ` · also on ${account.alsoOn.join(", ")}` : null}
              </li>
            ))}
          </ul>
        )}
      </DetailLine>

      {connectBothWays}
    </li>
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
      machineLabel={row.label}
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
  allowed,
  adding,
  added = false,
  error,
  onAdd,
}: {
  machineLabel: string;
  /** The desktop app holding full access to both machines; a browser tab is refused. */
  allowed: boolean;
  adding: boolean;
  added?: boolean;
  error: string | null;
  onAdd: () => void;
}) {
  return (
    <DetailLine
      label="Agents on this machine"
      help="Seeing a machine in this app does not tell this machine's server about it. Adding it gives the server its own key to that machine for a year, which can manage its access, updates and skills, with this window closed. Agents still cannot start work until you allow workers."
    >
      <div className="flex min-w-0 flex-col gap-2 sm:flex-row sm:items-center sm:justify-between">
        <p className="text-xs text-muted-foreground">
          {added ? (
            <>
              Added {machineLabel}. Next,{" "}
              <Link to="/settings/connections" className="underline underline-offset-2">
                allow workers
              </Link>{" "}
              on its card.
            </>
          ) : allowed ? (
            `This app can see ${machineLabel}, but agents on this machine cannot use it yet.`
          ) : (
            `Adding ${machineLabel} from here needs the desktop app with full access to it. Otherwise, on ${machineLabel}, choose Join a main machine under Settings > Connections.`
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
            {adding ? "Adding…" : "Add for agents"}
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

export interface CreatedLink {
  /** Null when no address another machine can open is known; the code still works. */
  readonly link: string | null;
  readonly code: string;
  readonly expiresAt: string;
}

/**
 * The step this app cannot do for the other machine: app connections live in
 * each app, so the other machine's app must open a link made here. The link
 * stays in this component's state and is never logged.
 */
function ConnectBothWays({
  row,
  primaryEnvironmentId,
}: {
  row: MachineRowModel;
  primaryEnvironmentId: EnvironmentId;
}) {
  // The address the other machine's server already uses for this one, if it lists it.
  const there = useStudioFleet(row.environmentId);
  const configs = useServerConfigs();
  const advertised = useDesktopAdvertisedEndpoints();
  const canCreate = useEnvironmentScope(primaryEnvironmentId, AuthAccessWriteScope);
  const [creating, setCreating] = useState(false);
  const [created, setCreated] = useState<CreatedLink | null>(null);

  async function create() {
    if (creating || !canCreate) return;
    const scopes = AuthStandardClientScopes.filter((scope) =>
      readEnvironmentScope(primaryEnvironmentId, scope),
    );
    if (scopes.length === 0) return;
    setCreating(true);
    try {
      const result = await createServerPairingCredential({
        label: `App on ${row.label}`,
        coordinatorEnvironmentId: row.environmentId,
        scopes,
      });
      const host = pairingLinkBaseUrl({
        addressSeenThere:
          there.snapshot?.machines.find((machine) => machine.environmentId === primaryEnvironmentId)
            ?.url ?? null,
        pageUrl: currentServerOrigin(),
        directEndpoints: configs.get(primaryEnvironmentId)?.directEndpoints ?? [],
        advertisedEndpoints: advertised,
      });
      setCreated({
        link: host ? resolveDesktopPairingUrl(host, result.credential) : null,
        code: result.credential,
        expiresAt: new Date(DateTime.toEpochMillis(result.expiresAt)).toLocaleTimeString(
          undefined,
          { hour: "numeric", minute: "2-digit" },
        ),
      });
    } catch (failure) {
      toastManager.add(
        stackedThreadToast({
          type: "error",
          title: "Could not create a pairing link",
          description: failure instanceof Error ? failure.message : "Try again in a moment.",
        }),
      );
    } finally {
      setCreating(false);
    }
  }

  return (
    <ConnectBothWaysView
      machineLabel={row.label}
      canCreate={canCreate}
      creating={creating}
      created={created}
      onCreate={() => void create()}
      onDone={() => setCreated(null)}
    />
  );
}

async function copyText(value: string, what: string) {
  try {
    await navigator.clipboard.writeText(value);
    toastManager.add(stackedThreadToast({ type: "success", title: `${what} copied` }));
  } catch {
    toastManager.add(
      stackedThreadToast({
        type: "error",
        title: `Could not copy the ${what.toLowerCase()}`,
        description: "Select it and copy it by hand.",
      }),
    );
  }
}

export function ConnectBothWaysView({
  machineLabel,
  canCreate,
  creating,
  created,
  onCreate,
  onDone,
}: {
  machineLabel: string;
  canCreate: boolean;
  creating: boolean;
  created: CreatedLink | null;
  onCreate: () => void;
  onDone: () => void;
}) {
  return (
    <DetailLine label="Connect both ways">
      {created === null ? (
        <div className="flex min-w-0 flex-col gap-2 sm:flex-row sm:items-center sm:justify-between">
          <p className="text-xs text-muted-foreground">
            This app sees {machineLabel}. To let {machineLabel}&rsquo;s app see this machine, make a
            one-time link here and open it there.
          </p>
          <Button
            className="shrink-0 self-start sm:self-auto"
            size="xs"
            variant="outline"
            disabled={creating || !canCreate}
            onClick={onCreate}
          >
            {creating ? "Creating…" : canCreate ? "Connect both ways" : "Manage access required"}
          </Button>
        </div>
      ) : (
        <div className="min-w-0 space-y-1.5">
          <p className="text-xs text-foreground/80">
            {created.link
              ? connectBothWaysInstruction(machineLabel)
              : `On ${machineLabel}, open Settings > Connections > Add environment > Remote link, enter this machine's private address and this pairing code.`}
          </p>
          <div className="flex min-w-0 gap-2">
            <Input
              readOnly
              size="sm"
              className="min-w-0 flex-1 font-mono text-xs"
              aria-label={created.link ? "Pairing link" : "Pairing code"}
              value={created.link ?? created.code}
              onFocus={(event) => event.currentTarget.select()}
            />
            <Button
              size="xs"
              variant="outline"
              onClick={() =>
                void copyText(created.link ?? created.code, created.link ? "Link" : "Pairing code")
              }
            >
              Copy
            </Button>
            <Button size="xs" variant="ghost-muted" onClick={onDone}>
              Done
            </Button>
          </div>
          <p className="text-xs text-muted-foreground">
            Works once, until {created.expiresAt}. Paste it only into SpecWithCode on {machineLabel}
            , not into a chat.
          </p>
        </div>
      )}
    </DetailLine>
  );
}
