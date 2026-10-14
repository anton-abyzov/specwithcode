import { useState } from "react";
import { CheckIcon, LaptopIcon, LockKeyholeIcon, RefreshCwIcon } from "lucide-react";
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
  allowStudioFleetWorkers,
  pairStudioFleet,
  stopStudioFleetWorkers,
  useStudioFleet,
} from "../../studio/fleet";
import {
  defaultFleetWorkerAccess,
  FLEET_WORKER_ACCESS_CHOICES,
  fleetWorkersView,
} from "../../studio/fleetWorkers";
import { setFleetEnvironmentSkipped } from "../../studio/fleetAutoConnect";
import {
  useClientSettings,
  useEnvironmentSettings,
  useUpdateClientSettings,
} from "../../hooks/useSettings";
import { Switch } from "../ui/switch";
import { useEnvironmentScope } from "../../state/session";
import { useAtomCommand } from "../../state/use-atom-command";
import { connectPairing } from "../../connection/onboarding";
import { SettingsRow, SettingsSection } from "./settingsLayout";
import { searchableSetting } from "./settingsSearch";
import { Button } from "../ui/button";

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
    <div
      className="min-w-0 space-y-2 border-t border-border/60 pt-3"
      aria-label={`Workers on ${machine.label}`}
    >
      <p className="text-xs font-medium">Workers</p>
      <p className="text-xs text-muted-foreground">{view.summary}</p>
      {view.problem ? <p className="text-xs text-warning-foreground">{view.problem}</p> : null}
      {view.action === "allow" ? (
        <div className="flex min-w-0 flex-col gap-2">
          <label className="flex items-center justify-between gap-2 text-xs">
            Most access a worker gets
            <select
              aria-label={`Most access for workers on ${machine.label}`}
              className="rounded-md border border-border bg-background px-1.5 py-0.5 text-xs"
              value={draft.access}
              disabled={busy}
              onChange={(e) =>
                onDraftChange({ ...draft, access: e.target.value as StudioFleetWorkerAccess })
              }
            >
              {FLEET_WORKER_ACCESS_CHOICES.map((choice) => (
                <option key={choice.value} value={choice.value}>
                  {choice.label}
                </option>
              ))}
            </select>
          </label>
          {view.codeNeeded ? (
            <input
              aria-label={`Pairing code made on ${machine.label}`}
              className="rounded-md border border-border bg-background px-2 py-1 font-mono text-xs"
              placeholder={`Pairing code from ${machine.label} (Operate threads)`}
              autoComplete="off"
              spellCheck={false}
              value={draft.pairingCode}
              disabled={busy}
              onChange={(e) => onDraftChange({ ...draft, pairingCode: e.target.value })}
            />
          ) : null}
          <Button
            size="sm"
            variant="outline"
            disabled={busy || (view.codeNeeded && !draft.pairingCode.trim())}
            onClick={() => onAction("allow")}
          >
            {canManage ? "Allow workers" : "Manage access required"}
          </Button>
        </div>
      ) : (
        <Button size="sm" variant="ghost-muted" disabled={busy} onClick={() => onAction("stop")}>
          Stop workers
        </Button>
      )}
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
  const autoConnect = useClientSettings((settings) => settings.autoConnectPrivateMachines);
  const updateClientSettings = useUpdateClientSettings();
  const [pending, setPending] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const canManageWorkers = useEnvironmentScope(environmentId, AuthAccessWriteScope);
  const [notice, setNotice] = useState<string | null>(null);
  const defaultRuntimeMode = useEnvironmentSettings(
    environmentId,
    (settings) => settings.defaultRuntimeMode,
  );
  const emptyWorkerDraft: WorkerDraft = {
    access: defaultFleetWorkerAccess(defaultRuntimeMode),
    pairingCode: "",
  };
  const [workerDrafts, setWorkerDrafts] = useState<Readonly<Record<string, WorkerDraft>>>({});
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
  return (
    <StudioFleetRoster
      snapshot={snapshot}
      loading={loading}
      failed={failed}
      canPair={canPair}
      environmentId={environmentId}
      savedEnvironmentIds={savedEnvironmentIds}
      pending={pending}
      error={error}
      autoConnect={autoConnect}
      onAutoConnectChange={(checked) =>
        void updateClientSettings({ autoConnectPrivateMachines: checked })
      }
      onRefresh={refresh}
      onPair={(machine) => void pair(machine)}
      canManageWorkers={canManageWorkers}
      workerDrafts={workerDrafts}
      defaultWorkerDraft={emptyWorkerDraft}
      notice={notice}
      onWorkerDraftChange={(id, draft) =>
        setWorkerDrafts((current) => ({ ...current, [id]: draft }))
      }
      onWorkers={(machine, action) => void changeWorkers(machine, action)}
    />
  );
}
export function StudioFleetRoster({
  snapshot,
  loading,
  failed,
  canPair,
  environmentId,
  savedEnvironmentIds,
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
  onWorkerDraftChange,
  onWorkers,
}: {
  snapshot: StudioFleetSnapshot | null;
  loading: boolean;
  failed: boolean;
  canPair: boolean;
  environmentId: EnvironmentId;
  savedEnvironmentIds: ReadonlyArray<EnvironmentId>;
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
  onWorkerDraftChange?: (id: string, draft: WorkerDraft) => void;
  onWorkers?: (machine: StudioFleetMachine, action: "allow" | "stop") => void;
}) {
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
      <div className="px-4 pb-3 text-xs leading-relaxed text-muted-foreground">
        <LockKeyholeIcon className="mr-1.5 inline size-3" />
        {autoConnect
          ? "This browser connects to reachable machines on its own, then you choose a machine when starting work. Connections are saved on this device."
          : "Connect once in this browser, then choose a machine when starting work. Connections are saved on this device."}
      </div>
      {snapshot?.machines.length && onAutoConnectChange ? (
        <label
          id={searchableSetting("private-machines-auto-connect").id}
          className="mx-4 mb-3 flex items-center justify-between gap-4 rounded-lg border border-border/60 px-3 py-2"
        >
          <span className="min-w-0">
            <span className="block text-sm">Connect automatically</span>
            <span className="block text-xs text-muted-foreground">
              Pair with reachable machines when SpecWithCode opens, including after a restart. A
              machine you remove stays removed until you connect it again.
            </span>
          </span>
          <Switch
            checked={autoConnect}
            onCheckedChange={onAutoConnectChange}
            aria-label="Connect private machines automatically"
          />
        </label>
      ) : null}
      {failed ? (
        <p role="status" className="px-4 pb-4 text-sm text-muted-foreground">
          Private machines could not be checked. Refresh to retry.
        </p>
      ) : snapshot?.machines.length ? (
        <div className="grid gap-3 px-4 pb-4 sm:grid-cols-2 xl:grid-cols-3">
          {snapshot.machines.map((machine) => {
            const current = machine.environmentId === environmentId;
            const saved = savedEnvironmentIds.includes(machine.environmentId);
            const reachable = machine.status === "reachable";
            const status = failed
              ? "Connection unverified"
              : machine.status === "identity-mismatch"
                ? "Address needs attention"
                : reachable
                  ? "Private HTTPS reachable"
                  : "Private route unavailable";
            return (
              <article
                key={machine.id}
                className="flex min-w-0 flex-col gap-4 rounded-xl border border-border/70 bg-card p-4"
                aria-label={machine.label}
              >
                <div className="flex items-start gap-3">
                  <span className="flex size-9 shrink-0 items-center justify-center rounded-lg border border-border/60 bg-muted/50">
                    <LaptopIcon aria-hidden className="size-5 shrink-0 text-foreground/75" />
                  </span>
                  <div className="min-w-0">
                    <h3 className="truncate text-sm font-semibold">{machine.label}</h3>
                    <p className="mt-0.5 text-xs text-muted-foreground">
                      {current
                        ? "This machine"
                        : saved
                          ? "Saved in this browser"
                          : "Available to connect"}
                    </p>
                  </div>
                </div>
                <div className="min-w-0 space-y-1">
                  <p className="flex items-center gap-1.5 text-xs">
                    <span
                      className={`size-1.5 shrink-0 rounded-full ${reachable ? "bg-emerald-500" : "bg-amber-500"}`}
                    />
                    {status}
                  </p>
                  <p
                    className="truncate font-mono text-[10px] text-muted-foreground"
                    title={machine.url}
                  >
                    {new URL(machine.url).host}
                  </p>
                </div>
                {current || saved ? (
                  <div className="mt-auto flex min-h-7 items-center gap-1.5 text-xs text-muted-foreground">
                    <CheckIcon className="size-3.5" />
                    {current ? "Current environment" : "Saved for the machine picker"}
                  </div>
                ) : (
                  <Button
                    className="mt-auto w-full"
                    size="sm"
                    variant="outline"
                    disabled={
                      pending !== null ||
                      !reachable ||
                      !machine.pairingConfigured ||
                      !canPair ||
                      failed
                    }
                    onClick={() => onPair(machine)}
                  >
                    {pending === machine.id
                      ? "Connecting…"
                      : !machine.pairingConfigured
                        ? "Pairing needs setup"
                        : !canPair
                          ? "Pairing permission required"
                          : "Connect machine"}
                  </Button>
                )}
                {!current && onWorkers && onWorkerDraftChange ? (
                  <FleetWorkersRow
                    machine={machine}
                    disabled={pending !== null || failed}
                    canManage={canManageWorkers}
                    draft={workerDrafts[machine.id] ?? defaultWorkerDraft}
                    onDraftChange={(draft) => onWorkerDraftChange(machine.id, draft)}
                    onAction={(action) => onWorkers(machine, action)}
                  />
                ) : null}
              </article>
            );
          })}
        </div>
      ) : (
        <p className="px-4 pb-4 text-sm text-muted-foreground">
          {loading
            ? "Checking your private machines…"
            : "No private machines are configured on this server. You can still add an environment with a pairing link below."}
        </p>
      )}
      {snapshot?.machines.length ? (
        <p className="px-4 pb-4 text-[11px] leading-relaxed text-muted-foreground">
          Private routes checked from this server.{" "}
          {snapshot.listener === "loopback"
            ? "Its listener stays on loopback while private HTTPS remains independent."
            : "Its listener accepts network connections."}
        </p>
      ) : null}
      {!canPair &&
      snapshot?.machines.some(
        (machine) =>
          machine.environmentId !== environmentId &&
          !savedEnvironmentIds.includes(machine.environmentId),
      ) ? (
        <p className="px-4 pb-4 text-xs leading-relaxed text-muted-foreground">
          To connect a private machine, ask this server’s owner for a pairing link with{" "}
          {snapshot?.connectPermission === "orchestration:operate"
            ? "Operate threads"
            : "Manage access"}{" "}
          and open it in this browser. You can also use Add environment below with that machine’s
          own pairing link.
        </p>
      ) : null}
      {notice ? (
        <p role="status" className="px-4 pb-4 text-xs text-warning-foreground">
          {notice}
        </p>
      ) : null}
      {error ? (
        <p role="alert" className="px-4 pb-4 text-xs text-destructive">
          {error}
        </p>
      ) : null}
    </SettingsSection>
  );
}
