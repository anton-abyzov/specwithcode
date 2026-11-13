import { renderRich } from "../../i18n/rich";
import { useTx } from "../../i18n";
import { hasRelayRoute } from "@specweave-studio/client-runtime/connection";
import { Link } from "@tanstack/react-router";
import { type ReactNode, useState } from "react";
import { CheckIcon, EllipsisIcon, LaptopIcon, ListChecksIcon, RefreshCwIcon } from "lucide-react";
import {
  AuthAccessWriteScope,
  type EnvironmentId,
  type ServerAuthPolicy,
} from "@specweave-studio/contracts";
import type {
  StudioFleetMachine,
  StudioFleetSnapshot,
  StudioFleetWorkerAccess,
} from "@specweave-studio/contracts/studioFleet";
import { useCopyToClipboard } from "../../hooks/useCopyToClipboard";
import {
  addStudioFleetMachine,
  allowStudioFleetWorkers,
  pairStudioFleet,
  removeStudioFleetMachine,
  stopStudioFleetWorkers,
  useFleetRemoveSupported,
  useStudioFleet,
} from "../../studio/fleet";
import {
  DEFAULT_FLEET_WORKER_ACCESS,
  FLEET_WORKER_ACCESS_CHOICES,
  fleetInviteCommand,
  fleetWorkersHelp,
  fleetWorkerDraftAccess,
  fleetRemoveNotice,
  sentSecretsWarning,
  fleetWorkersView,
} from "../../studio/fleetWorkers";
import {
  fleetMachineSaved,
  rejectedSavedEnvironments,
  savedRouteOrigins,
  setFleetEnvironmentSkipped,
} from "../../studio/fleetAutoConnect";
import { useEnvironments } from "../../state/environments";
import { machineLastSeenAt, useMachineLastSeenVersion } from "../../lib/machineLastSeen";
import {
  isThisMachineCatchingUp,
  lastSeenLabel,
  machineStatus,
  readableConnectionReason,
} from "../../lib/machineStatus";
import { isThisMachineTarget } from "../../connection/desktopLocal";
import { useClientSettings, useUpdateClientSettings } from "../../hooks/useSettings";
import { Switch } from "../ui/switch";
import { useEnvironmentScope } from "../../state/session";
import { useAtomCommand } from "../../state/use-atom-command";
import { connectPairing } from "../../connection/onboarding";
import { machineHandoff } from "../../studio/machineHandoff";
import { requestConfirmDialog } from "../../confirmDialog";
import { unreachableMachines } from "../../cloud/connectRoutePlan";
import { hasCloudPublicConfig } from "../../cloud/publicConfig";
import { useMachineNicknames } from "../../studio/machineNickname";
import { ConnectDeregisterHint, fleetRemoveConnectNote } from "./ConnectDeregisterHint";
import { ConnectReachBanner } from "./ConnectReachBanner";
import { FleetInviteArea, fleetInviteManagedMachines } from "./FleetInvite";
import { MachineReadinessChecklist } from "./MachineReadinessChecklist";
import {
  ADD_DEVICE_WITH_CODE_ROW_ID,
  AddDeviceWithCodeRow,
  useCanAddDeviceWithCode,
} from "./AddDeviceWithCodeRow";
import { OtherAccountJoinFold } from "./OtherAccountJoinFold";
import { MachineTerminal, MachineTerminalButton, useCloseMachineTerminal } from "./MachineTerminal";
import { ConnectionReason } from "./ConnectionReason";
import { ProvisionMachineButton } from "./ProvisionMachineSheet";
import { SettingHelp } from "./SettingHelp";
import { SettingsRow, SettingsSection, TeamRulesLabel } from "./settingsLayout";
import { TeamRulesInert, TeamRulesLockNote } from "./TeamRulesLock";
import type { TeamRulesSummary } from "@specweave-studio/contracts";
import { teamRulesMachineLinkLock, teamRulesMachineLock } from "../../teamRules/teamRulesView";
import { searchableSetting } from "./settingsSearch";
import { Button } from "../ui/button";
import {
  Select,
  SelectGroup,
  SelectGroupLabel,
  SelectItem,
  SelectPopup,
  SelectTrigger,
  SelectValue,
} from "../ui/select";
import { Menu, MenuItem, MenuPopup, MenuSeparator, MenuTrigger } from "../ui/menu";
import { fleetMachineHasTailnetAddress } from "../../studio/fleetAutoConnect";
import { requestAccountMachineConnect } from "../../studio/grantedAccountMachines";

/** A listener's bind address does not describe Tailscale Serve or an SSH tunnel. */
export function StudioListenerRow({
  policy,
  desktop,
}: {
  policy: ServerAuthPolicy | null;
  desktop: boolean;
}) {
  return (
    <SettingsRow
      title="Server listener"
      description={
        desktop
          ? "Network settings are managed where this server runs."
          : policy === "loopback-browser"
            ? "Bound to this machine. Private HTTPS and SSH tunnels can still provide remote access."
            : policy === "remote-reachable"
              ? "Remote connections are enabled. Pairing is required for access."
              : "Check the server launch settings for its listener address."
      }
    />
  );
}
/** How this browser's own connection to a saved machine reads, as everywhere else in the app. */
export interface FleetMachineConnection {
  readonly text: string;
  readonly connected: boolean;
  /** "last seen 2h ago", when not connected. */
  readonly lastSeen: string | null;
  /** Why it failed and what to do, shown on its own wrapped line. */
  readonly reason: string | null;
  /** Retrying now can help, unlike a refused approval. */
  readonly retryable: boolean;
  /** "muted" when the reason is not a failure, such as a machine needing an app update. */
  readonly tone: "error" | "muted";
}
const NO_REJECTED_ENVIRONMENTS: ReadonlyArray<string> = [];
const NO_MACHINE_STATUSES: Readonly<Record<string, FleetMachineConnection>> = {};
export interface WorkerDraft {
  readonly access: StudioFleetWorkerAccess;
  /** A one-time code made on that machine, for when this server cannot make one. */
  readonly pairingCode: string;
}
/** Full access on the owner's own machines; the Workers row's select can lower it. */
const DEFAULT_WORKER_DRAFT: WorkerDraft = { access: DEFAULT_FLEET_WORKER_ACCESS, pairingCode: "" };
/**
 * A machine's Workers draft: what the user picked, else the grant's current
 * access once allowed (so changing it starts from what is in force), else `fallback`.
 */
export function fleetWorkerDraft(
  machine: Pick<StudioFleetMachine, "id" | "workers">,
  drafts: Readonly<Record<string, WorkerDraft>>,
  fallback: WorkerDraft = DEFAULT_WORKER_DRAFT,
): WorkerDraft {
  return (
    drafts[machine.id] ?? {
      ...fallback,
      access: fleetWorkerDraftAccess(machine.workers, fallback.access),
    }
  );
}

/**
 * Whether coordinators on this server may start workers on a machine. The
 * grant lives on this server; the browser only allows, stops and reads it.
 */
export function FleetWorkersRow({
  machine,
  disabled,
  canManage,
  draft,
  onDraftChange,
  onAction,
  bare = false,
}: {
  machine: StudioFleetMachine;
  /** The card already names the direction and shows the status, so only the controls render. */
  bare?: boolean;
  disabled: boolean;
  canManage: boolean;
  draft: WorkerDraft;
  onDraftChange: (draft: WorkerDraft) => void;
  onAction: (action: "allow" | "stop") => void;
}) {
  const tx = useTx();
  const workers = machine.workers;
  if (!workers) return null;
  const view = fleetWorkersView(workers, machine.pairingConfigured);
  const busy = disabled || !canManage;
  // Allowed rows change their access by allowing again with the new ceiling.
  const allowed = view.action === "stop";
  const changed = allowed && draft.access !== workers.access;
  const codeNeeded = allowed ? changed && view.changeCodeNeeded : view.codeNeeded;
  return (
    <div className="min-w-0 space-y-1.5" aria-label={`Workers on ${machine.label}`}>
      {bare ? (
        view.action === "allow" && !canManage ? (
          <p className="text-xs text-muted-foreground">
            {tx("Allowing them needs Manage access on this machine.")}
          </p>
        ) : null
      ) : (
        <p className="text-xs text-muted-foreground">
          <span className="text-foreground/80">{tx("Workers")}</span>{" "}
          <SettingHelp label={tx("workers")}>
            <div className="space-y-1.5">
              {fleetWorkersHelp(machine.label).map((line) => (
                <p key={line}>{line}</p>
              ))}
            </div>
          </SettingHelp>{" "}
          · {view.summary}
          {view.action === "allow" && !canManage ? tx(" Allowing them needs Manage access.") : null}
        </p>
      )}
      {view.accessHint ? <p className="text-xs text-muted-foreground">{view.accessHint}</p> : null}
      {view.problem ? <p className="text-xs text-warning-foreground">{view.problem}</p> : null}
      {canManage ? (
        <div className="flex min-w-0 flex-wrap items-center gap-2">
          <Select
            value={draft.access}
            disabled={busy}
            onValueChange={(value) => {
              if (value) onDraftChange({ ...draft, access: value as StudioFleetWorkerAccess });
            }}
          >
            <SelectTrigger
              size="xs"
              className="w-auto min-w-0"
              aria-label={`Most access for workers on ${machine.label}`}
            >
              <SelectValue>
                {FLEET_WORKER_ACCESS_CHOICES.find((choice) => choice.value === draft.access)
                  ?.label ?? draft.access}
              </SelectValue>
            </SelectTrigger>
            <SelectPopup align="start" alignItemWithTrigger={false}>
              <SelectGroup>
                <SelectGroupLabel>{tx("Most access a worker gets")}</SelectGroupLabel>
                {FLEET_WORKER_ACCESS_CHOICES.map((choice) => (
                  <SelectItem key={choice.value} value={choice.value}>
                    {choice.label}
                  </SelectItem>
                ))}
              </SelectGroup>
            </SelectPopup>
          </Select>
          <SettingHelp label={tx("the most access a worker gets")}>
            <p className="mb-1.5">
              {renderRich(
                tx(
                  "The most a worker started on {label} may do, even when its coordinator has more.",
                ),
                { label: machine.label },
              )}
            </p>
            <dl className="space-y-1">
              {FLEET_WORKER_ACCESS_CHOICES.map((choice) => (
                <div key={choice.value}>
                  <dt className="inline font-medium">{choice.label}: </dt>
                  <dd className="inline text-muted-foreground">{choice.description}</dd>
                </div>
              ))}
            </dl>
          </SettingHelp>
          {codeNeeded ? (
            <input
              aria-label={`Pairing code made on ${machine.label}`}
              className="h-7 min-w-0 flex-1 rounded-md border border-input bg-background px-2 font-mono text-xs dark:bg-input/32"
              placeholder={`Code made on ${machine.label} for this machine`}
              autoComplete="off"
              spellCheck={false}
              value={draft.pairingCode}
              disabled={busy}
              onChange={(e) => onDraftChange({ ...draft, pairingCode: e.target.value })}
            />
          ) : null}
          {allowed ? (
            changed ? (
              <Button
                size="xs"
                disabled={busy || (codeNeeded && !draft.pairingCode.trim())}
                onClick={() => onAction("allow")}
              >
                {tx("Change access")}
              </Button>
            ) : null
          ) : (
            <Button
              size="xs"
              disabled={busy || (codeNeeded && !draft.pairingCode.trim())}
              title={`Let coordinators on this machine start threads on ${machine.label}`}
              onClick={() => onAction("allow")}
            >
              {bare ? tx("Allow") : tx("Allow workers")}
            </Button>
          )}
        </div>
      ) : null}
    </div>
  );
}

export interface FleetInventoryComposition {
  /**
   * Wraps a machine's controls. `workers` is that machine's Allow workers
   * control: when composed, the card shows it on its own access line, so it
   * is left out of `controls`.
   */
  renderMachine?: (
    environmentId: EnvironmentId,
    controls: ReactNode,
    workers: ReactNode,
    card?: FleetMachineCardExtras,
  ) => ReactNode;
  additionalMachines?: ReactNode;
}

/** What a composed machine card shows itself, so it is not left under Connection details. */
export interface FleetMachineCardExtras {
  /** Stop workers and Remove machine, for the card's header. */
  readonly actions: ReactNode;
  /** Says the machine no longer answers and offers Remove; null while it answers. */
  readonly gone: ReactNode;
}

/** A Connect-only machine this account's list does not show (yet). */
export const CONNECT_ONLY_NOT_LISTED =
  "This machine is reached over SpecWithCode Connect only, and this app's Connect account does not list it yet. Sign in to SpecWithCode Connect here with the same account, wait a moment, then press Connect again.";
interface Props extends FleetInventoryComposition {
  environmentId: EnvironmentId;
  savedEnvironmentIds: ReadonlyArray<EnvironmentId>;
}
export function StudioFleetConnections({
  environmentId,
  savedEnvironmentIds,
  renderMachine,
  additionalMachines,
}: Props) {
  const { snapshot: rawSnapshot, loading, failed, refresh } = useStudioFleet(environmentId);
  const nickname = useMachineNicknames();
  // Every machine below is named by its nickname; the roster and its rows
  // render machine.label as-is.
  const snapshot = rawSnapshot
    ? {
        ...rawSnapshot,
        machines: rawSnapshot.machines.map((machine) => {
          const label = nickname(machine.environmentId, machine.label);
          return label === machine.label ? machine : { ...machine, label };
        }),
      }
    : rawSnapshot;
  const canPair = useEnvironmentScope(
    environmentId,
    snapshot?.connectPermission ?? AuthAccessWriteScope,
  );
  const canAddDeviceWithCode = useCanAddDeviceWithCode(environmentId);
  const connect = useAtomCommand(connectPairing, { reportFailure: false });
  const sentSecrets = useAtomCommand(machineHandoff.sentSecrets, { reportFailure: false });
  const autoConnect = useClientSettings((settings) => settings.autoConnectPrivateMachines);
  const updateClientSettings = useUpdateClientSettings();
  const [pending, setPending] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const canManageWorkers = useEnvironmentScope(environmentId, AuthAccessWriteScope);
  const removeSupported = useFleetRemoveSupported(environmentId);
  const [notice, setNotice] = useState<string | null>(null);
  const [added, setAdded] = useState<string | null>(null);
  // The machine just removed here: it may still be registered on the Connect account.
  const [removedLabel, setRemovedLabel] = useState<string | null>(null);
  const [workerDrafts, setWorkerDrafts] = useState<Readonly<Record<string, WorkerDraft>>>({});
  const [invitation, setInvitation] = useState("");
  const [inviteOpen, setInviteOpen] = useState(false);
  const { environments } = useEnvironments();
  const teamRules = environments.find((environment) => environment.environmentId === environmentId)
    ?.serverConfig?.teamRules;
  // A machine saved here only at an address it has left reads as not saved,
  // so Connect machine adds its new address. So does one whose server turned
  // down the saved credential: Approve again pairs it anew.
  const rejected = rejectedSavedEnvironments(environments);
  const origins = savedRouteOrigins(
    environments.map((environment) => environment.entry),
    rejected,
  );
  useMachineLastSeenVersion();
  const machineStatuses: Record<string, FleetMachineConnection> = {};
  for (const environment of environments) {
    if (!environment.connection) continue;
    // This Mac is never offline here either: while its server is busy it
    // reads "Catching up…" with no last-seen or failure line.
    const isThisMachine = isThisMachineTarget(environment.entry);
    const status = machineStatus(environment.connection, true, isThisMachine);
    const connected = environment.connection.phase === "connected";
    const quiet =
      connected || (isThisMachine && isThisMachineCatchingUp(environment.connection.phase));
    machineStatuses[environment.environmentId] = {
      text: status.text,
      connected,
      lastSeen: quiet
        ? null
        : lastSeenLabel(machineLastSeenAt(environment.environmentId), Date.now()),
      reason:
        quiet || status.reason === null
          ? null
          : fleetConnectionReason(
              environment.connection.error ?? "",
              environment.environmentId,
              snapshot?.machines ?? [],
            ),
      retryable: status.retryable,
      tone: environment.connection.phase === "unsupported" ? "muted" : "error",
    };
  }
  const saved = new Set<string>(savedEnvironmentIds);
  const savedHere = savedEnvironmentIds.filter((id) => {
    const machine = snapshot?.machines.find((candidate) => candidate.environmentId === id);
    return machine === undefined || fleetMachineSaved(machine, saved, origins);
  });
  async function addMachine() {
    if (pending || !canManageWorkers || !invitation.trim()) return;
    setPending("add-machine");
    setError(null);
    setNotice(null);
    setAdded(null);
    setRemovedLabel(null);
    try {
      const result = await addStudioFleetMachine(environmentId, invitation.trim());
      const addedName = nickname(result.environmentId, result.label);
      // The line holds a management token: never keep it once sent.
      setInvitation("");
      setAdded(
        result.change === "added"
          ? `Added ${addedName}. ${autoConnect ? "This browser connects to it on its own." : "Choose Connect machine to use it here."} Choose Allow on its card, on the line about agents here starting work on it.`
          : result.previousUrl
            ? `${addedName} now answers at its new address. Workers allowed there carry over.`
            : `Renewed ${addedName}.`,
      );
    } catch (failure) {
      setError(failure instanceof Error ? failure.message : "Could not add this machine.");
    } finally {
      setPending(null);
    }
  }
  async function changeWorkers(machine: StudioFleetMachine, action: "allow" | "stop") {
    if (pending || !canManageWorkers) return;
    const draft = fleetWorkerDraft(machine, workerDrafts);
    setPending(`workers:${machine.id}`);
    setError(null);
    setNotice(null);
    setRemovedLabel(null);
    try {
      if (action === "stop") {
        const stopped = await stopStudioFleetWorkers(environmentId, machine.id);
        if (stopped.remoteSessionKept)
          setNotice(
            `Workers are stopped here. ${machine.label} could not be told, so its access stays listed there until it expires; revoke it on ${machine.label} under Settings > Machines > Who can run work here.`,
          );
      } else
        await allowStudioFleetWorkers(environmentId, {
          id: machine.id,
          access: draft.access,
          ...(draft.pairingCode.trim() ? { pairingCode: draft.pairingCode.trim() } : {}),
        });
      // A pasted code is single-use: never keep it once sent.
      setWorkerDrafts((current) => ({
        ...current,
        [machine.id]: { ...draft, pairingCode: "" },
      }));
    } catch (failure) {
      setError(failure instanceof Error ? failure.message : "Could not change workers there.");
    } finally {
      setPending(null);
    }
  }
  async function remove(machine: StudioFleetMachine) {
    if (pending || !canManageWorkers) return;
    // Secret files a folder copy sent there; an older server without the ledger lists none.
    const sent = await sentSecrets({
      environmentId,
      input: { destinationEnvironmentId: machine.environmentId },
    });
    const secretsWarning = sentSecretsWarning(
      sent._tag === "Success" ? sent.value.entries : [],
      machine.label,
    );
    // Fail closed: no mounted confirm host means no removal.
    const confirmed = await requestConfirmDialog(
      `Remove ${machine.label} from this machine's list?\nThis machine gives up its worker access and management token on ${machine.label}. Threads already running there keep running.\n${fleetRemoveConnectNote(machine.label)}${secretsWarning ? `\n${secretsWarning}` : ""}`,
      { variant: "destructive" },
    );
    if (confirmed !== true) return;
    setPending(`remove:${machine.id}`);
    setError(null);
    setNotice(null);
    setAdded(null);
    setRemovedLabel(null);
    try {
      const removed = await removeStudioFleetMachine(environmentId, machine.id);
      setRemovedLabel(machine.label);
      if (secretsWarning) setNotice(`${fleetRemoveNotice(removed)} ${secretsWarning}`);
      else if (removed.workerAccess === "kept" || removed.managementToken === "kept")
        setNotice(fleetRemoveNotice(removed));
      else setAdded(fleetRemoveNotice(removed));
    } catch (failure) {
      setError(failure instanceof Error ? failure.message : "Could not remove this machine.");
    } finally {
      setPending(null);
    }
  }
  async function pair(machine: StudioFleetMachine) {
    if (pending) return;
    setError(null);
    // A Connect-only machine is saved over Connect, which needs no pairing
    // permission; Tailscale pairing cannot reach it.
    // A saved one is paired as before; an unsaved one this account's list does
    // not show yet cannot be reached here, so the press says why.
    if (!fleetMachineHasTailnetAddress(machine)) {
      if (requestAccountMachineConnect([machine.environmentId])) return;
      if (!savedEnvironmentIds.includes(machine.environmentId)) {
        setError(CONNECT_ONLY_NOT_LISTED);
        return;
      }
    }
    if (!canPair) return;
    setPending(machine.id);
    try {
      const credential = await pairStudioFleet(environmentId, machine.id);
      const result = await connect({
        host: credential.host,
        pairingCode: credential.pairingCode,
        expectedEnvironmentId: credential.environmentId,
      });
      if (result._tag === "Failure")
        throw new Error(
          "The browser could not connect to this machine. Check Tailscale and retry. The server must allow this browser's origin.",
        );
      setFleetEnvironmentSkipped(machine.environmentId, false);
    } catch (failure) {
      setError(failure instanceof Error ? failure.message : "Could not connect to this machine.");
    } finally {
      setPending(null);
    }
  }
  const unreachable = unreachableMachines(
    environments.filter(
      (environment) =>
        environment.environmentId !== environmentId && saved.has(environment.environmentId),
    ),
  ).map((environment) => {
    const machine = snapshot?.machines.find(
      (candidate) => candidate.environmentId === environment.environmentId,
    );
    return {
      environmentId: environment.environmentId,
      label: machine?.label ?? environment.label,
      onConnect: Boolean(machine?.connectUrl),
      // The window's own primary never takes a Connect route.
      hasConnectRoute:
        environment.entry.target._tag === "PrimaryConnectionTarget" ||
        hasRelayRoute(environment.entry),
    };
  });
  return (
    <StudioFleetRoster
      renderMachine={renderMachine}
      additionalMachines={additionalMachines}
      banner={<ConnectReachBanner machines={unreachable} />}
      teamRules={teamRules}
      snapshot={snapshot}
      loading={loading}
      failed={failed}
      canPair={canPair}
      environmentId={environmentId}
      savedEnvironmentIds={savedHere}
      rejectedEnvironmentIds={[...rejected]}
      pending={pending}
      error={error}
      autoConnect={autoConnect}
      onAutoConnectChange={(checked) =>
        void updateClientSettings({ autoConnectPrivateMachines: checked })
      }
      onRefresh={refresh}
      onPair={(machine) => void pair(machine)}
      canCheckReadiness
      canManageWorkers={canManageWorkers}
      workerDrafts={workerDrafts}
      defaultWorkerDraft={DEFAULT_WORKER_DRAFT}
      notice={notice}
      added={added}
      removedLabel={removedLabel}
      onWorkerDraftChange={(id, draft) =>
        setWorkerDrafts((current) => ({ ...current, [id]: draft }))
      }
      onWorkers={(machine, action) => void changeWorkers(machine, action)}
      {...(removeSupported
        ? { onRemove: (machine: StudioFleetMachine) => void remove(machine) }
        : {
            removeUnavailable:
              "Removing a machine from this list needs SpecWithCode 1.0.58 or later on this server. Connecting, workers and everything else here work as is.",
          })}
      invitation={invitation}
      onInvitationChange={setInvitation}
      onAddMachine={() => void addMachine()}
      onInvite={() => setInviteOpen(true)}
      inviteOpen={inviteOpen}
      deviceCodeRow={canAddDeviceWithCode ? <AddDeviceWithCodeRow /> : null}
      inviteDialog={
        <FleetInviteArea
          environmentId={environmentId}
          defaultName={
            environments.find((environment) => environment.environmentId === environmentId)
              ?.label ?? null
          }
          canManage={canManageWorkers}
          open={inviteOpen}
          onOpenChange={setInviteOpen}
          managedMachines={fleetInviteManagedMachines(snapshot?.machines ?? [], environmentId)}
        />
      }
      machineStatuses={machineStatuses}
    />
  );
}
/**
 * The address line for a machine card. A machine reached through another
 * machine's private name (a relay port on it) says so, instead of showing
 * that other machine's host as if it were its own.
 */
/** The ID with a Copy beside it, since nobody retypes one by hand. */
/** A command or ID to copy, as its own line so it reads the same on every platform. */
function CopyableCode({ value, label }: { readonly value: string; readonly label: string }) {
  const tx = useTx();
  const { copyToClipboard, isCopied } = useCopyToClipboard<void>({ target: label });
  return (
    <span className="mt-1 flex min-w-0 items-center gap-2 rounded-md border border-border/60 bg-muted/40 py-1 ps-2 pe-1">
      <code className="min-w-0 flex-1 font-mono text-xs break-all text-foreground select-all">
        {value}
      </code>
      <Button
        type="button"
        size="xs"
        variant="ghost-muted"
        aria-label={`Copy ${label}`}
        onClick={() => copyToClipboard(value, undefined)}
      >
        {isCopied ? tx("Copied") : tx("Copy")}
      </Button>
    </span>
  );
}

function AddMachineStep({
  title,
  children,
}: {
  readonly title: string;
  readonly children: ReactNode;
}) {
  const tx = useTx();
  return (
    <li className="min-w-0 text-xs text-muted-foreground">
      <span className="text-foreground/80">{tx(title)}</span>
      <div className="mt-0.5 space-y-1">{children}</div>
    </li>
  );
}

export function fleetMachineAddress(
  machine: Pick<StudioFleetMachine, "id" | "url" | "connectUrl" | "transport">,
  machines: ReadonlyArray<Pick<StudioFleetMachine, "id" | "label" | "url">>,
): string {
  // The address that answered: its SpecWithCode Connect one when that is it.
  if (machine.transport === "connect" && machine.connectUrl)
    return new URL(machine.connectUrl).host;
  const url = new URL(machine.url);
  const relay = relayHostMachine(url, machine.id, machines);
  return relay ? `Through ${relay.label}, port ${url.port}` : url.host;
}

/**
 * The other machine whose private name an address is a port on (a relay to
 * this machine), or undefined when the address is not a relay port.
 */
function relayHostMachine<M extends Pick<StudioFleetMachine, "id" | "url">>(
  url: URL,
  excludeId: string,
  machines: ReadonlyArray<M>,
): M | undefined {
  if (!url.port) return undefined;
  return machines.find((other) => {
    if (other.id === excludeId) return false;
    try {
      const otherUrl = new URL(other.url);
      return otherUrl.hostname === url.hostname && !otherUrl.port;
    } catch {
      return false;
    }
  });
}

function originOf(value: string | undefined): string | null {
  if (!value) return null;
  try {
    return new URL(value).origin;
  } catch {
    return null;
  }
}

/**
 * Why a saved machine can't be reached, naming the address this window tried
 * in words: its own Tailscale or SpecWithCode Connect address, or a relay port
 * on another machine. The fleet card shows the address the main machine's
 * server reached, which can differ from the one saved in this window.
 */
export function fleetConnectionReason(
  reason: string,
  environmentId: string,
  machines: ReadonlyArray<
    Pick<StudioFleetMachine, "id" | "label" | "url" | "connectUrl" | "environmentId">
  >,
): string {
  const machine = machines.find((candidate) => candidate.environmentId === environmentId);
  return readableConnectionReason(reason, (url) => {
    if (machine && url.origin === originOf(machine.connectUrl))
      return "its SpecWithCode Connect address";
    // A relay port on another machine reads as such even when it is the
    // address the fleet lists for this machine.
    const relay = relayHostMachine(url, machine?.id ?? "", machines);
    if (relay) return `port ${url.port} on ${relay.label}`;
    if (machine && url.origin === originOf(machine.url))
      return url.hostname.toLowerCase().endsWith(".ts.net") ? "its Tailscale address" : null;
    return null;
  });
}

/** Which address answered the last check, in words. */
export function fleetMachineTransport(
  machine: Pick<StudioFleetMachine, "transport">,
): string | null {
  return machine.transport === "connect"
    ? "via SpecWithCode Connect"
    : machine.transport === "tailnet"
      ? "via Tailscale"
      : null;
}

/**
 * A machine that answers only through SpecWithCode Connect while the token
 * saved for it works only over Tailscale needs a new line from it.
 */
export function fleetMachineNeedsReinvite(
  machine: Pick<StudioFleetMachine, "transport" | "managementBinding">,
): string | null {
  return machine.transport === "connect" && machine.managementBinding === "bearer"
    ? "On that machine, choose Join a main machine again and add the new line here to use SpecWithCode Connect."
    : null;
}

export function StudioFleetRoster({
  renderMachine,
  additionalMachines,
  snapshot,
  loading,
  failed,
  canPair,
  environmentId,
  savedEnvironmentIds,
  rejectedEnvironmentIds = NO_REJECTED_ENVIRONMENTS,
  pending,
  error,
  autoConnect = false,
  onAutoConnectChange,
  onRefresh,
  onPair,
  canManageWorkers = false,
  workerDrafts = {},
  defaultWorkerDraft = DEFAULT_WORKER_DRAFT,
  notice = null,
  added = null,
  removedLabel = null,
  onWorkerDraftChange,
  onWorkers,
  onRemove,
  removeUnavailable = null,
  invitation = "",
  onInvitationChange,
  onAddMachine,
  onInvite,
  inviteOpen = false,
  inviteDialog = null,
  deviceCodeRow = null,
  machineStatuses = NO_MACHINE_STATUSES,
  canCheckReadiness = false,
  banner = null,
  teamRules,
}: {
  renderMachine?: FleetInventoryComposition["renderMachine"];
  additionalMachines?: ReactNode;
  /** This machine's rules, which refuse new links and machines they do not match. */
  teamRules?: TeamRulesSummary | undefined;
  snapshot: StudioFleetSnapshot | null;
  loading: boolean;
  failed: boolean;
  canPair: boolean;
  environmentId: EnvironmentId;
  savedEnvironmentIds: ReadonlyArray<EnvironmentId>;
  /** Saved machines whose server turned down this browser's credential. */
  rejectedEnvironmentIds?: ReadonlyArray<string>;
  pending: string | null;
  error: string | null;
  autoConnect?: boolean;
  onAutoConnectChange?: (checked: boolean) => void;
  onRefresh: () => void;
  onPair: (machine: StudioFleetMachine) => void;
  canManageWorkers?: boolean;
  workerDrafts?: Readonly<Record<string, WorkerDraft>>;
  /** A not-yet-allowed machine's draft before the user changes it: full access. */
  defaultWorkerDraft?: WorkerDraft;
  /** What the last change did that the user should know, such as a session left there. */
  notice?: string | null;
  /** What adding a machine just did. */
  added?: string | null;
  /** The machine just removed, which may still be registered on the Connect account. */
  removedLabel?: string | null;
  onWorkerDraftChange?: (id: string, draft: WorkerDraft) => void;
  onWorkers?: (machine: StudioFleetMachine, action: "allow" | "stop") => void;
  /** Removes a machine and gives up what this server holds on it. */
  onRemove?: (machine: StudioFleetMachine) => void;
  /** Why Remove machine is not offered, when this server predates it. */
  removeUnavailable?: string | null;
  /** The pasted `fleet invite` line, cleared once sent. */
  invitation?: string;
  onInvitationChange?: (invitation: string) => void;
  onAddMachine?: () => void;
  /** Opens the in-app `fleet invite` for this machine. */
  onInvite?: () => void;
  /** The invitation dialog is open, so the fold around its button stays open. */
  inviteOpen?: boolean;
  /** The invitation dialog `onInvite` opens. */
  inviteDialog?: ReactNode;
  /** "Add a device with a code", the third path, when this window may offer it. */
  deviceCodeRow?: ReactNode;
  /** This browser's own connection to each saved machine, keyed by environment id. */
  machineStatuses?: Readonly<Record<string, FleetMachineConnection>>;
  /** Offers each connected machine's sign-in and repository-access checklist. */
  canCheckReadiness?: boolean;
  /** Shown above the list, such as the Connect sign-in for machines that cannot be reached. */
  banner?: ReactNode;
}) {
  const tx = useTx();
  const [readinessFor, setReadinessFor] = useState<string | null>(null);
  const [terminalFor, setTerminalFor] = useState<string | null>(null);
  const closeMachineTerminal = useCloseMachineTerminal();
  const linkLock = teamRulesMachineLinkLock(teamRules);
  return (
    <SettingsSection
      id={renderMachine ? "machines" : "private-machines"}
      title={renderMachine ? "Other machines" : "Your private machines"}
      headerAction={
        <Button
          size="xs"
          variant="ghost-muted"
          onClick={onRefresh}
          disabled={loading || pending !== null}
        >
          <RefreshCwIcon className="size-3" />
          {loading ? tx("Checking…") : tx("Refresh")}
        </Button>
      }
    >
      {banner}
      {linkLock ? (
        <div className="px-3 py-2.5 sm:px-4">
          <TeamRulesLockNote lock={linkLock} />
        </div>
      ) : null}
      {additionalMachines ? (
        <ul className="divide-y divide-border/60">{additionalMachines}</ul>
      ) : null}
      {failed ? (
        <p role="status" className="px-3 py-2.5 text-sm text-muted-foreground sm:px-4">
          {tx("Private machines could not be checked. Refresh to retry.")}
        </p>
      ) : snapshot?.machines.length ? (
        <ul className="divide-y divide-border/60">
          {snapshot.machines.map((machine) => {
            const current = machine.environmentId === environmentId;
            const saved = savedEnvironmentIds.includes(machine.environmentId);
            const rejected = rejectedEnvironmentIds.includes(machine.environmentId);
            const reachable = machine.status === "reachable";
            // A machine this browser already uses reads the same as in the
            // machine picker and sidebar; others say whether their route answers.
            const own =
              current || saved || rejected ? machineStatuses[machine.environmentId] : undefined;
            const status = own
              ? own.text
              : machine.status === "identity-mismatch"
                ? "Address needs attention"
                : reachable
                  ? "Reachable"
                  : "Unreachable";
            const ok = own ? own.connected : reachable;
            const meta = [
              own?.lastSeen ?? null,
              current ? "This machine" : saved ? "Saved here" : null,
              fleetMachineAddress(machine, snapshot.machines),
              fleetMachineTransport(machine),
            ].filter(Boolean);
            const connected = current || (saved && own?.connected === true);
            const ready = canCheckReadiness && connected;
            const terminalOpen = connected && terminalFor === machine.id;
            const workersView = machine.workers
              ? fleetWorkersView(machine.workers, machine.pairingConfigured)
              : null;
            const busy = pending !== null || failed;
            const canStop = !current && onWorkers !== undefined && workersView?.action === "stop";
            const canRemove = !current && onRemove !== undefined && canManageWorkers;
            const readinessOpen = readinessFor === machine.id;
            // Why pairing is not offered reads as a note, not as a button that does nothing.
            // A Connect-only machine is saved over Connect: no pairing to set up.
            const pairNote = !fleetMachineHasTailnetAddress(machine)
              ? null
              : !machine.pairingConfigured
                ? "Pairing needs setup"
                : !canPair
                  ? "Pairing permission required"
                  : null;
            const reinvite = fleetMachineNeedsReinvite(machine);
            // Stop and Remove only take access away, so the rules leave them available.
            const machineLock = current
              ? null
              : reachable
                ? teamRulesMachineLock(teamRules, {
                    label: machine.label,
                    fingerprint: machine.teamRules?.fingerprint,
                  })
                : linkLock;
            const workersRow =
              !current && onWorkers && onWorkerDraftChange && machine.workers ? (
                <TeamRulesInert lock={machineLock}>
                  <FleetWorkersRow
                    machine={machine}
                    bare={renderMachine !== undefined}
                    disabled={busy}
                    canManage={canManageWorkers}
                    draft={fleetWorkerDraft(machine, workerDrafts, defaultWorkerDraft)}
                    onDraftChange={(draft) => onWorkerDraftChange(machine.id, draft)}
                    onAction={(action) => onWorkers(machine, action)}
                  />
                </TeamRulesInert>
              ) : null;
            // Stop workers and Remove machine. A composed card puts them in its own header.
            const actions =
              pending === `remove:${machine.id}` || canStop || canRemove ? (
                <>
                  {pending === `remove:${machine.id}` ? (
                    <span className="text-xs text-muted-foreground" role="status">
                      {tx("Removing…")}
                    </span>
                  ) : null}
                  {canStop || canRemove ? (
                    <Menu>
                      <MenuTrigger
                        render={
                          <Button
                            type="button"
                            variant="ghost-muted"
                            size="icon-xs"
                            aria-label={`More actions for ${machine.label}`}
                          />
                        }
                      >
                        <EllipsisIcon className="size-3.5" />
                      </MenuTrigger>
                      <MenuPopup align="end">
                        {canStop ? (
                          <MenuItem
                            disabled={busy || !canManageWorkers}
                            onClick={() => onWorkers?.(machine, "stop")}
                          >
                            {tx("Stop workers")}
                          </MenuItem>
                        ) : null}
                        {canStop ? (
                          <p className="max-w-64 px-2 pb-2 text-xs text-muted-foreground">
                            {renderRich(
                              tx(
                                "Coordinators on this machine can no longer start threads on {label}. Workers already running there keep running.",
                              ),
                              { label: machine.label },
                            )}
                          </p>
                        ) : null}
                        {canStop && canRemove ? <MenuSeparator /> : null}
                        {canRemove ? (
                          <MenuItem
                            variant="destructive"
                            disabled={busy}
                            onClick={() => onRemove?.(machine)}
                          >
                            {pending === `remove:${machine.id}`
                              ? tx("Removing…")
                              : tx("Remove machine")}
                          </MenuItem>
                        ) : null}
                      </MenuPopup>
                    </Menu>
                  ) : null}
                </>
              ) : null;
            // A machine that stopped answering was often wiped or reinstalled.
            const gone =
              canRemove && machine.status === "unreachable" ? (
                <p
                  role="status"
                  className="flex min-w-0 flex-wrap items-center gap-2 text-xs text-muted-foreground"
                >
                  <span>
                    {tx(
                      "No longer answers. If it was wiped or reinstalled, remove it here; a fresh install joins as a new machine.",
                    )}
                  </span>
                  <Button
                    size="xs"
                    variant="destructive-outline"
                    disabled={busy}
                    onClick={() => onRemove?.(machine)}
                  >
                    {pending === `remove:${machine.id}` ? tx("Removing…") : tx("Remove")}
                  </Button>
                </p>
              ) : null;
            const controls = (
              <li
                key={machine.id}
                className="flex min-w-0 flex-col gap-2 px-3 py-3 sm:px-4"
                aria-label={machine.label}
              >
                <div className="flex min-w-0 items-start gap-3">
                  <LaptopIcon aria-hidden className="mt-0.5 size-4 shrink-0 text-foreground/70" />
                  <div className="min-w-0 flex-1">
                    <h3 className="truncate text-sm font-medium">
                      {machine.label}
                      {machine.machineName && machine.machineName !== machine.label ? (
                        <span className="font-normal text-muted-foreground">
                          {" "}
                          · {machine.machineName}
                        </span>
                      ) : null}
                    </h3>
                    {/* Short facts that wrap rather than cut off; the reason gets its own line below. */}
                    <p className="text-xs break-words text-muted-foreground">
                      <span
                        aria-hidden
                        className={`me-1.5 inline-block size-1.5 rounded-full align-middle ${ok ? "bg-success" : "bg-warning"}`}
                      />
                      <span className="text-foreground/80">{status}</span>
                      {meta.map((part) => ` · ${part}`).join("")}
                    </p>
                    {reinvite ? (
                      <p className="text-xs text-warning-foreground">{reinvite}</p>
                    ) : null}
                    {machineLock && !linkLock ? (
                      <p className="text-xs text-muted-foreground">{machineLock.message}</p>
                    ) : null}
                    {own?.reason ? (
                      <ConnectionReason
                        environmentId={machine.environmentId}
                        reason={own.reason}
                        tone={own.tone}
                        retryable={own.retryable}
                      />
                    ) : null}
                  </div>
                  <div className="flex shrink-0 items-center gap-1">
                    {current || saved ? (
                      <CheckIcon
                        aria-label={
                          current ? tx("Current machine") : tx("Saved for the machine picker")
                        }
                        className="size-3.5 text-muted-foreground"
                      />
                    ) : machineLock ? (
                      <TeamRulesLabel>{machineLock.setBy}</TeamRulesLabel>
                    ) : pairNote && pending !== machine.id ? (
                      <span className="text-xs text-muted-foreground">{pairNote}</span>
                    ) : (
                      <Button
                        size="xs"
                        variant="default"
                        disabled={busy || !reachable || pairNote !== null}
                        onClick={() => onPair(machine)}
                      >
                        {pending === machine.id
                          ? tx("Connecting…")
                          : rejected
                            ? tx("Approve again")
                            : tx("Connect machine")}
                      </Button>
                    )}
                    {renderMachine ? null : actions}
                  </div>
                </div>
                {gone && !renderMachine ? <div className="pl-7">{gone}</div> : null}
                {workersRow && !renderMachine ? <div className="pl-7">{workersRow}</div> : null}
                {connected ? (
                  <div className="flex flex-wrap items-center gap-1.5 pl-7 empty:hidden">
                    {ready ? (
                      <>
                        <ProvisionMachineButton
                          environmentId={machine.environmentId}
                          environmentLabel={machine.label}
                        />
                        <Button
                          size="xs"
                          variant="outline"
                          aria-expanded={readinessOpen}
                          onClick={() => setReadinessFor(readinessOpen ? null : machine.id)}
                        >
                          <ListChecksIcon aria-hidden />
                          {readinessOpen ? tx("Hide readiness") : tx("Check readiness")}
                        </Button>
                      </>
                    ) : null}
                    <MachineTerminalButton
                      environmentId={machine.environmentId}
                      environmentLabel={machine.label}
                      open={terminalOpen}
                      onOpenChange={(next) => {
                        if (!next) closeMachineTerminal(machine.environmentId);
                        setTerminalFor(next ? machine.id : null);
                      }}
                    />
                  </div>
                ) : null}
                {terminalOpen ? (
                  <div className="ms-7">
                    <MachineTerminal
                      key={machine.environmentId}
                      environmentId={machine.environmentId}
                      environmentLabel={machine.label}
                      onClose={() => {
                        closeMachineTerminal(machine.environmentId);
                        setTerminalFor(null);
                      }}
                    />
                  </div>
                ) : null}
                {ready && readinessOpen ? (
                  <div className="ms-7 rounded-lg border bg-muted/30 px-3 py-2.5">
                    <MachineReadinessChecklist
                      environmentId={machine.environmentId}
                      environmentLabel={machine.label}
                    />
                  </div>
                ) : null}
              </li>
            );
            return renderMachine
              ? renderMachine(machine.environmentId, controls, workersRow, { actions, gone })
              : controls;
          })}
        </ul>
      ) : renderMachine ? null : (
        <p className="px-3 py-2.5 text-sm text-muted-foreground sm:px-4">
          {loading
            ? tx("Checking your private machines…")
            : tx("No other machines yet. Add another computer or a server you rent below.")}
        </p>
      )}
      {!failed && snapshot?.invalidEntries?.length ? (
        // Skipped lines of the fleet file; every other machine above still loaded.
        <ul className="divide-y divide-border/60 border-t border-border/60">
          {snapshot.invalidEntries.map((entry) => (
            <li
              key={`invalid-${entry.index}`}
              className="flex min-w-0 items-start gap-3 px-3 py-2.5 sm:px-4"
            >
              <LaptopIcon aria-hidden className="size-4 shrink-0 text-foreground/70" />
              <div className="min-w-0 flex-1">
                <h3 className="truncate text-sm">
                  {entry.label ?? `Machine ${entry.index + 1} in the fleet file`}
                </h3>
                <p role="alert" className="text-xs break-words text-muted-foreground">
                  <span
                    aria-hidden
                    className="me-1.5 inline-block size-1.5 rounded-full bg-warning align-middle"
                  />
                  {`Invalid entry in fleet config: ${entry.reason}`}
                </p>
              </div>
            </li>
          ))}
        </ul>
      ) : null}
      {snapshot?.machines.length && onAutoConnectChange ? (
        <label
          id={searchableSetting("private-machines-auto-connect").id}
          className="flex items-center justify-between gap-4 border-t border-border/60 px-3 py-2.5 sm:px-4"
        >
          <span className="min-w-0">
            <span className="block text-sm">{tx("Connect automatically")}</span>
            <span className="block text-xs text-muted-foreground">
              {tx(
                "When this app opens, connect it to your machines that answer, so their projects show here. Turn off and you connect each one yourself with Connect machine. It changes no agent permissions. Saved on this device.",
              )}
            </span>
          </span>
          <TeamRulesInert lock={linkLock}>
            <Switch
              checked={autoConnect}
              onCheckedChange={onAutoConnectChange}
              aria-label={tx("Connect private machines automatically")}
            />
          </TeamRulesInert>
        </label>
      ) : null}
      {(onAddMachine && onInvitationChange) || onInvite || deviceCodeRow ? (
        <OtherAccountJoinFold
          // A typed line, a running add and the open dialog all live inside; a build without
          // SpecWithCode Connect has no other way to join machines.
          openFor={
            invitation.trim() !== "" ||
            pending === "add-machine" ||
            inviteOpen ||
            !hasCloudPublicConfig()
          }
          targetIds={[
            searchableSetting("private-machines-add").id,
            searchableSetting("private-machines-invite").id,
            ...(deviceCodeRow ? [ADD_DEVICE_WITH_CODE_ROW_ID] : []),
          ]}
        >
          {onAddMachine && onInvitationChange ? (
            <form
              id={searchableSetting("private-machines-add").id}
              tabIndex={-1}
              className="flex min-w-0 flex-col gap-3 border-t border-border/60 px-3 py-3 sm:px-4"
              onSubmit={(event) => {
                event.preventDefault();
                onAddMachine();
              }}
            >
              <div className="min-w-0">
                <span className="block text-sm">{tx("Add a machine")}</span>
                <span className="mt-0.5 block text-xs text-muted-foreground">
                  {tx("Let agents on this machine start work on another computer.")}
                </span>
              </div>
              <p className="text-xs text-muted-foreground">
                {renderRich(
                  tx(
                    "Already connected to it? Open {link} and choose Add on its card. There is nothing to copy. Otherwise, follow these steps:",
                  ),
                  {
                    link: (
                      <Link to="/settings/machines" className="underline underline-offset-2">
                        Settings &gt; Machines
                      </Link>
                    ),
                  },
                )}
              </p>
              <ol className="list-decimal space-y-2.5 ps-4 marker:text-xs marker:text-muted-foreground">
                <AddMachineStep title={tx("Link SpecWithCode Connect on the other machine")}>
                  <p>
                    {tx(
                      "Open Settings > Machines > SpecWithCode Connect there, or run this command. Any Connect account works. This machine does not need to be signed in.",
                    )}
                  </p>
                  <CopyableCode value="specwithcode connect link" label={tx("Connect command")} />
                </AddMachineStep>
                <AddMachineStep title={tx("Make a join line there")}>
                  <p>
                    {tx(
                      "There, choose Join a main machine under Settings > Machines and enter this machine’s ID:",
                    )}
                  </p>
                  <CopyableCode value={environmentId} label={tx("this machine's ID")} />
                  <p>{tx("Without its window, run this command on that machine instead:")}</p>
                  <CopyableCode
                    value={fleetInviteCommand(environmentId)}
                    label={tx("join line command")}
                  />
                </AddMachineStep>
                <AddMachineStep title={tx("Paste the join line here")}>
                  <p>{tx("It works once, within an hour.")}</p>
                  <TeamRulesInert lock={linkLock}>
                    <div className="flex min-w-0 gap-2">
                      <input
                        aria-label={tx("Invitation from the other machine")}
                        className="h-7 min-w-0 flex-1 rounded-md border border-input bg-background px-2 font-mono text-xs dark:bg-input/32"
                        placeholder={tx("swc-machine-…")}
                        autoComplete="off"
                        spellCheck={false}
                        value={invitation}
                        disabled={pending !== null || !canManageWorkers}
                        onChange={(event) => onInvitationChange(event.target.value)}
                      />
                      <Button
                        type="submit"
                        size="xs"
                        disabled={pending !== null || !canManageWorkers || !invitation.trim()}
                      >
                        {pending === "add-machine"
                          ? tx("Adding…")
                          : canManageWorkers
                            ? tx("Add machine")
                            : tx("Manage access required")}
                      </Button>
                    </div>
                  </TeamRulesInert>
                </AddMachineStep>
                <AddMachineStep title={tx("Allow workers")}>
                  <p>
                    {tx(
                      "Choose Allow on its card above, on the line about agents here starting work on it.",
                    )}
                  </p>
                </AddMachineStep>
              </ol>
              <p className="text-xs text-muted-foreground">
                {renderRich(tx("Adding a Linux server you rent? Start with the {a}."), {
                  a: (
                    <a
                      className="underline underline-offset-2"
                      href="https://github.com/anton-abyzov/specwithcode/blob/main/docs/user/linux-worker.md"
                      target="_blank"
                      rel="noreferrer noopener"
                    >
                      {tx("Linux worker guide")}
                    </a>
                  ),
                })}
              </p>
            </form>
          ) : null}
          {onInvite ? (
            <div
              id={searchableSetting("private-machines-invite").id}
              tabIndex={-1}
              className="flex min-w-0 flex-col gap-2 border-t border-border/60 px-3 py-2.5 sm:px-4"
            >
              <div className="flex min-w-0 flex-col gap-2 sm:flex-row sm:items-center sm:justify-between sm:gap-4">
                <span className="min-w-0">
                  <span className="block text-sm">{tx("Join a main machine")}</span>
                  <span className="block text-xs text-muted-foreground">
                    {tx(
                      "Link SpecWithCode Connect here first, then make a line to paste on your main machine.",
                    )}
                  </span>
                </span>
                <TeamRulesInert lock={linkLock}>
                  <Button
                    className="shrink-0 self-start sm:self-auto"
                    size="xs"
                    variant="outline"
                    disabled={pending !== null || !canManageWorkers}
                    onClick={onInvite}
                  >
                    {canManageWorkers ? tx("Make a join line") : tx("Manage access required")}
                  </Button>
                </TeamRulesInert>
              </div>
              {inviteDialog}
            </div>
          ) : null}
          {deviceCodeRow}
        </OtherAccountJoinFold>
      ) : null}
      {!canPair &&
      snapshot?.machines.some(
        (machine) =>
          machine.environmentId !== environmentId &&
          !savedEnvironmentIds.includes(machine.environmentId),
      ) ? (
        <p className="border-t border-border/60 px-3 py-2 text-xs text-muted-foreground sm:px-4">
          {renderRich(
            tx(
              "To connect one, open a pairing link from this server’s owner with {value}, or use Add connection with that machine’s own link.",
            ),
            {
              value:
                snapshot?.connectPermission === "orchestration:operate"
                  ? "Operate threads"
                  : "Manage access",
            },
          )}
        </p>
      ) : null}
      {removeUnavailable &&
      canManageWorkers &&
      snapshot?.machines.some((machine) => machine.environmentId !== environmentId) ? (
        <p className="border-t border-border/60 px-3 py-2 text-xs text-muted-foreground sm:px-4">
          {removeUnavailable}
        </p>
      ) : null}
      {added || notice || error || removedLabel ? (
        <div className="space-y-1 border-t border-border/60 px-3 py-2 text-xs sm:px-4">
          {added ? (
            <p role="status" className="text-muted-foreground">
              {added}
            </p>
          ) : null}
          {notice ? (
            <p role="status" className="text-warning-foreground">
              {notice}
            </p>
          ) : null}
          {removedLabel ? <ConnectDeregisterHint label={removedLabel} /> : null}
          {error ? (
            <p role="alert" className="text-destructive-foreground">
              {tx(error)}
            </p>
          ) : null}
        </div>
      ) : null}
    </SettingsSection>
  );
}
