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
  defaultFleetWorkerAccess,
  FLEET_WORKER_ACCESS_CHOICES,
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
import { isThisMachineCatchingUp, lastSeenLabel, machineStatus } from "../../lib/machineStatus";
import { isThisMachineTarget } from "../../connection/desktopLocal";
import {
  useClientSettings,
  useEnvironmentSettings,
  useUpdateClientSettings,
} from "../../hooks/useSettings";
import { Switch } from "../ui/switch";
import { useEnvironmentScope } from "../../state/session";
import { useAtomCommand } from "../../state/use-atom-command";
import { connectPairing } from "../../connection/onboarding";
import { machineHandoff } from "../../studio/machineHandoff";
import { requestConfirmDialog } from "../../confirmDialog";
import { unreachableMachines } from "../../cloud/connectRoutePlan";
import { ConnectReachBanner } from "./ConnectReachBanner";
import { FleetInviteArea } from "./FleetInvite";
import { MachineReadinessChecklist } from "./MachineReadinessChecklist";
import { ConnectionReason } from "./ConnectionReason";
import { ProvisionMachineButton } from "./ProvisionMachineSheet";
import { SettingsRow, SettingsSection } from "./settingsLayout";
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
}: {
  machine: StudioFleetMachine;
  disabled: boolean;
  canManage: boolean;
  draft: WorkerDraft;
  onDraftChange: (draft: WorkerDraft) => void;
  onAction: (action: "allow" | "stop") => void;
}) {
  const workers = machine.workers;
  if (!workers) return null;
  const view = fleetWorkersView(workers);
  const busy = disabled || !canManage;
  return (
    <div className="min-w-0 space-y-1.5" aria-label={`Workers on ${machine.label}`}>
      <p className="text-xs text-muted-foreground">
        <span className="text-foreground/80">Workers</span> · {view.summary}
        {view.action === "allow" && !canManage ? " Allowing them needs Manage access." : null}
      </p>
      {view.problem ? <p className="text-xs text-warning-foreground">{view.problem}</p> : null}
      {view.action === "allow" && canManage ? (
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
                <SelectGroupLabel>Most access a worker gets</SelectGroupLabel>
                {FLEET_WORKER_ACCESS_CHOICES.map((choice) => (
                  <SelectItem key={choice.value} value={choice.value}>
                    {choice.label}
                  </SelectItem>
                ))}
              </SelectGroup>
            </SelectPopup>
          </Select>
          {view.codeNeeded ? (
            <input
              aria-label={`Pairing code made on ${machine.label}`}
              className="h-7 min-w-0 flex-1 rounded-md border border-input bg-background px-2 font-mono text-xs dark:bg-input/32"
              placeholder={`Pairing code from ${machine.label} (Operate threads)`}
              autoComplete="off"
              spellCheck={false}
              value={draft.pairingCode}
              disabled={busy}
              onChange={(e) => onDraftChange({ ...draft, pairingCode: e.target.value })}
            />
          ) : null}
          <Button
            size="xs"
            disabled={busy || (view.codeNeeded && !draft.pairingCode.trim())}
            onClick={() => onAction("allow")}
          >
            Allow workers
          </Button>
        </div>
      ) : null}
    </div>
  );
}

interface Props {
  environmentId: EnvironmentId;
  savedEnvironmentIds: ReadonlyArray<EnvironmentId>;
}
export function StudioFleetConnections({ environmentId, savedEnvironmentIds }: Props) {
  const { snapshot, loading, failed, refresh } = useStudioFleet(environmentId);
  const canPair = useEnvironmentScope(
    environmentId,
    snapshot?.connectPermission ?? AuthAccessWriteScope,
  );
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
  const defaultRuntimeMode = useEnvironmentSettings(
    environmentId,
    (settings) => settings.defaultRuntimeMode,
  );
  const emptyWorkerDraft: WorkerDraft = {
    access: defaultFleetWorkerAccess(defaultRuntimeMode),
    pairingCode: "",
  };
  const [workerDrafts, setWorkerDrafts] = useState<Readonly<Record<string, WorkerDraft>>>({});
  const [invitation, setInvitation] = useState("");
  const [inviteOpen, setInviteOpen] = useState(false);
  const { environments } = useEnvironments();
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
      reason: quiet ? null : status.reason,
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
    try {
      const result = await addStudioFleetMachine(environmentId, invitation.trim());
      // The line holds a management token: never keep it once sent.
      setInvitation("");
      setAdded(
        result.change === "added"
          ? `Added ${result.label}. ${autoConnect ? "This browser connects to it on its own." : "Choose Connect machine to use it here."} Choose Allow workers on it to let coordinators start work there.`
          : result.previousUrl
            ? `${result.label} now answers at its new address. Workers allowed there carry over.`
            : `Renewed ${result.label}.`,
      );
    } catch (failure) {
      setError(failure instanceof Error ? failure.message : "Could not add this machine.");
    } finally {
      setPending(null);
    }
  }
  async function changeWorkers(machine: StudioFleetMachine, action: "allow" | "stop") {
    if (pending || !canManageWorkers) return;
    const draft = workerDrafts[machine.id] ?? emptyWorkerDraft;
    setPending(`workers:${machine.id}`);
    setError(null);
    setNotice(null);
    try {
      if (action === "stop") {
        const stopped = await stopStudioFleetWorkers(environmentId, machine.id);
        if (stopped.remoteSessionKept)
          setNotice(
            `Workers are stopped here. ${machine.label} could not be told, so its access stays listed there until it expires; revoke it in that machine's Settings > Connections.`,
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
      `Remove ${machine.label} from this machine's list?\nThis machine gives up its worker access and management token on ${machine.label}. Threads already running there keep running.${secretsWarning ? `\n${secretsWarning}` : ""}`,
      { variant: "destructive" },
    );
    if (confirmed !== true) return;
    setPending(`remove:${machine.id}`);
    setError(null);
    setNotice(null);
    setAdded(null);
    try {
      const removed = await removeStudioFleetMachine(environmentId, machine.id);
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
    if (pending || !canPair) return;
    setPending(machine.id);
    setError(null);
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
    };
  });
  return (
    <StudioFleetRoster
      banner={<ConnectReachBanner machines={unreachable} />}
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
      defaultWorkerDraft={emptyWorkerDraft}
      notice={notice}
      added={added}
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
export function fleetMachineAddress(
  machine: Pick<StudioFleetMachine, "id" | "url" | "connectUrl" | "transport">,
  machines: ReadonlyArray<Pick<StudioFleetMachine, "id" | "label" | "url">>,
): string {
  // The address that answered: its SpecWithCode Connect one when that is it.
  if (machine.transport === "connect" && machine.connectUrl)
    return new URL(machine.connectUrl).host;
  const url = new URL(machine.url);
  const relay = url.port
    ? machines.find((other) => {
        if (other.id === machine.id) return false;
        const otherUrl = new URL(other.url);
        return otherUrl.hostname === url.hostname && !otherUrl.port;
      })
    : undefined;
  return relay ? `Through ${relay.label}, port ${url.port}` : url.host;
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
    ? "Invite this machine again to use SpecWithCode Connect."
    : null;
}

export function StudioFleetRoster({
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
  defaultWorkerDraft = { access: "auto", pairingCode: "" },
  notice = null,
  added = null,
  onWorkerDraftChange,
  onWorkers,
  onRemove,
  removeUnavailable = null,
  invitation = "",
  onInvitationChange,
  onAddMachine,
  onInvite,
  inviteDialog = null,
  machineStatuses = NO_MACHINE_STATUSES,
  canCheckReadiness = false,
  banner = null,
}: {
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
  /** A machine's draft before the user changes it: this server's default access. */
  defaultWorkerDraft?: WorkerDraft;
  /** What the last change did that the user should know, such as a session left there. */
  notice?: string | null;
  /** What adding a machine just did. */
  added?: string | null;
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
  /** The invitation dialog `onInvite` opens. */
  inviteDialog?: ReactNode;
  /** This browser's own connection to each saved machine, keyed by environment id. */
  machineStatuses?: Readonly<Record<string, FleetMachineConnection>>;
  /** Offers each connected machine's sign-in and repository-access checklist. */
  canCheckReadiness?: boolean;
  /** Shown above the list, such as the Connect sign-in for machines that cannot be reached. */
  banner?: ReactNode;
}) {
  const [readinessFor, setReadinessFor] = useState<string | null>(null);
  return (
    <SettingsSection
      id="private-machines"
      title="Your private machines"
      headerAction={
        <Button
          size="xs"
          variant="ghost-muted"
          onClick={onRefresh}
          disabled={loading || pending !== null}
        >
          <RefreshCwIcon className="size-3" />
          {loading ? "Checking…" : "Refresh"}
        </Button>
      }
    >
      {banner}
      {failed ? (
        <p role="status" className="px-3 py-2.5 text-sm text-muted-foreground sm:px-4">
          Private machines could not be checked. Refresh to retry.
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
            const ready = canCheckReadiness && (current || (saved && own?.connected));
            const workersView = machine.workers ? fleetWorkersView(machine.workers) : null;
            const busy = pending !== null || failed;
            const canStop = !current && onWorkers !== undefined && workersView?.action === "stop";
            const canRemove = !current && onRemove !== undefined && canManageWorkers;
            const readinessOpen = readinessFor === machine.id;
            // Why pairing is not offered reads as a note, not as a button that does nothing.
            const pairNote = !machine.pairingConfigured
              ? "Pairing needs setup"
              : !canPair
                ? "Pairing permission required"
                : null;
            const reinvite = fleetMachineNeedsReinvite(machine);
            return (
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
                          current ? "Current environment" : "Saved for the machine picker"
                        }
                        className="size-3.5 text-muted-foreground"
                      />
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
                          ? "Connecting…"
                          : rejected
                            ? "Approve again"
                            : "Connect machine"}
                      </Button>
                    )}
                    {pending === `remove:${machine.id}` ? (
                      <span className="text-xs text-muted-foreground" role="status">
                        Removing…
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
                              Stop workers
                            </MenuItem>
                          ) : null}
                          {canStop && canRemove ? <MenuSeparator /> : null}
                          {canRemove ? (
                            <MenuItem
                              variant="destructive"
                              disabled={busy}
                              onClick={() => onRemove?.(machine)}
                            >
                              {pending === `remove:${machine.id}` ? "Removing…" : "Remove machine"}
                            </MenuItem>
                          ) : null}
                        </MenuPopup>
                      </Menu>
                    ) : null}
                  </div>
                </div>
                {!current && onWorkers && onWorkerDraftChange && machine.workers ? (
                  <div className="pl-7">
                    <FleetWorkersRow
                      machine={machine}
                      disabled={busy}
                      canManage={canManageWorkers}
                      draft={workerDrafts[machine.id] ?? defaultWorkerDraft}
                      onDraftChange={(draft) => onWorkerDraftChange(machine.id, draft)}
                      onAction={(action) => onWorkers(machine, action)}
                    />
                  </div>
                ) : null}
                {ready ? (
                  <div className="flex flex-wrap items-center gap-1.5 pl-7">
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
                      {readinessOpen ? "Hide readiness" : "Check readiness"}
                    </Button>
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
          })}
        </ul>
      ) : (
        <p className="px-3 py-2.5 text-sm text-muted-foreground sm:px-4">
          {loading
            ? "Checking your private machines…"
            : "No private machines yet. Add a second Mac or your own Linux VPS below."}
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
            <span className="block text-sm">Connect automatically</span>
            <span className="block text-xs text-muted-foreground">
              Pair with reachable machines when SpecWithCode opens. Saved on this device.
            </span>
          </span>
          <Switch
            checked={autoConnect}
            onCheckedChange={onAutoConnectChange}
            aria-label="Connect private machines automatically"
          />
        </label>
      ) : null}
      {onAddMachine && onInvitationChange ? (
        <form
          id={searchableSetting("private-machines-add").id}
          className="flex min-w-0 flex-col gap-2 border-t border-border/60 px-3 py-2.5 sm:flex-row sm:items-center sm:gap-4 sm:px-4"
          onSubmit={(event) => {
            event.preventDefault();
            onAddMachine();
          }}
        >
          <span className="min-w-0 sm:flex-1">
            <span className="block text-sm">Add a machine</span>
            <span className="block text-xs text-muted-foreground">
              On that machine, choose Invite this machine under Settings &gt; Connections (or run{" "}
              <code className="font-mono">
                {"specwithcode fleet invite --coordinator '<main-machine-environment-id>'"}
              </code>
              ) and paste the line.
            </span>
            <span className="block text-xs text-muted-foreground">
              {
                "Replace <main-machine-environment-id> with the environment ID from Settings > Connections on your main machine to approve it to manage access on the other machine."
              }
            </span>
            <span className="block text-xs text-muted-foreground">
              For a Linux server you rent (a VPS), set it up with the{" "}
              <a
                className="underline underline-offset-2"
                href="https://github.com/anton-abyzov/specwithcode/blob/main/docs/user/linux-worker.md"
                target="_blank"
                rel="noreferrer noopener"
              >
                Linux worker guide
              </a>
              , then run{" "}
              <code className="font-mono">
                {"specwithcode fleet invite --coordinator '<main-machine-environment-id>'"}
              </code>{" "}
              there and paste the line here.
            </span>
          </span>
          <div className="flex min-w-0 gap-2 sm:w-96 sm:shrink-0">
            <input
              aria-label="Invitation from the other machine"
              className="h-7 min-w-0 flex-1 rounded-md border border-input bg-background px-2 font-mono text-xs dark:bg-input/32"
              placeholder="swc-machine-…"
              autoComplete="off"
              spellCheck={false}
              value={invitation}
              disabled={pending !== null || !canManageWorkers}
              onChange={(event) => onInvitationChange(event.target.value)}
            />
            <Button
              type="submit"
              size="xs"
              variant="outline"
              disabled={pending !== null || !canManageWorkers || !invitation.trim()}
            >
              {pending === "add-machine"
                ? "Adding…"
                : canManageWorkers
                  ? "Add machine"
                  : "Manage access required"}
            </Button>
          </div>
        </form>
      ) : null}
      {onInvite ? (
        <div
          id={searchableSetting("private-machines-invite").id}
          className="flex min-w-0 flex-col gap-2 border-t border-border/60 px-3 py-2.5 sm:px-4"
        >
          <div className="flex min-w-0 flex-col gap-2 sm:flex-row sm:items-center sm:justify-between sm:gap-4">
            <span className="min-w-0">
              <span className="block text-sm">Add this machine to another one</span>
              <span className="block text-xs text-muted-foreground">
                Make a line to paste on your main machine. It works over Tailscale or SpecWithCode
                Connect.
              </span>
            </span>
            <Button
              className="shrink-0 self-start sm:self-auto"
              size="xs"
              variant="outline"
              disabled={pending !== null || !canManageWorkers}
              onClick={onInvite}
            >
              {canManageWorkers ? "Invite this machine" : "Manage access required"}
            </Button>
          </div>
          {inviteDialog}
        </div>
      ) : null}
      {!canPair &&
      snapshot?.machines.some(
        (machine) =>
          machine.environmentId !== environmentId &&
          !savedEnvironmentIds.includes(machine.environmentId),
      ) ? (
        <p className="border-t border-border/60 px-3 py-2 text-xs text-muted-foreground sm:px-4">
          To connect one, open a pairing link from this server’s owner with{" "}
          {snapshot?.connectPermission === "orchestration:operate"
            ? "Operate threads"
            : "Manage access"}
          , or use Add environment with that machine’s own link.
        </p>
      ) : null}
      {removeUnavailable &&
      canManageWorkers &&
      snapshot?.machines.some((machine) => machine.environmentId !== environmentId) ? (
        <p className="border-t border-border/60 px-3 py-2 text-xs text-muted-foreground sm:px-4">
          {removeUnavailable}
        </p>
      ) : null}
      {added || notice || error ? (
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
          {error ? (
            <p role="alert" className="text-destructive-foreground">
              {error}
            </p>
          ) : null}
        </div>
      ) : null}
    </SettingsSection>
  );
}
