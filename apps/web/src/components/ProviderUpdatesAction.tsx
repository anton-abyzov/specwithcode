import { AuthProvidersManageScope, PROVIDER_DISPLAY_NAMES } from "@specweave-studio/contracts";
import {
  isAtomCommandInterrupted,
  squashAtomCommandFailure,
} from "@specweave-studio/client-runtime/state/runtime";
import { useMemo, useRef, useState } from "react";
import { useEnvironments } from "~/state/environments";
import { readEnvironmentScope } from "~/state/session";
import { serverEnvironment } from "~/state/server";
import { useAtomCommand } from "~/state/use-atom-command";
import {
  providerUpdateSkipReason,
  runProviderUpdateBatch,
  type ProviderUpdatePlanRow,
  type ProviderUpdateSelection,
} from "./ProviderUpdatesAction.logic";
import { Button } from "./ui/button";
import { Dialog, DialogPopup, DialogTitle, DialogDescription } from "./ui/dialog";

export function ProviderUpdatePlan({
  rows,
  initialSelection,
  run,
  onBusyChange,
}: {
  rows: readonly ProviderUpdatePlanRow[];
  initialSelection: readonly string[];
  run: (row: ProviderUpdatePlanRow) => Promise<string>;
  onBusyChange?: (busy: boolean) => void;
}) {
  const [selected, setSelected] = useState(() => new Set(initialSelection));
  const [results, setResults] = useState<Record<string, string>>({});
  const [busy, setBusy] = useState(false);
  const pending = useRef(false);
  const cancelled = useRef(false);
  const eligible = rows.filter((row) => !row.reason);
  const chosen = eligible.filter((row) => selected.has(row.key));
  const start = async () => {
    if (pending.current || chosen.length === 0) return;
    pending.current = true;
    cancelled.current = false;
    setBusy(true);
    onBusyChange?.(true);
    const snapshot = chosen;
    setResults(Object.fromEntries(snapshot.map((row) => [row.key, "Queued"])));
    try {
      await runProviderUpdateBatch(
        snapshot,
        async (row) => {
          setResults((old) => ({ ...old, [row.key]: "Updating…" }));
          try {
            const outcome = await run(row);
            setResults((old) => ({ ...old, [row.key]: outcome }));
          } catch (error) {
            setResults((old) => ({
              ...old,
              [row.key]: `Failed: ${error instanceof Error ? error.message : String(error)}`,
            }));
          }
        },
        () => cancelled.current,
      );
      if (cancelled.current)
        setResults((old) =>
          Object.fromEntries(
            Object.entries(old).map(([key, value]) => [
              key,
              value === "Queued" ? "Cancelled before starting" : value,
            ]),
          ),
        );
    } finally {
      pending.current = false;
      setBusy(false);
      onBusyChange?.(false);
    }
  };
  return (
    <div className="space-y-4">
      <p className="text-sm text-muted-foreground">
        Uses each configured CLI’s owning installer. Staged Codex installs preserve running
        sessions. Other installers wait until their CLI is idle. No app or service restart.
      </p>
      <Button
        size="sm"
        variant="outline"
        disabled={busy}
        onClick={() => setSelected(new Set(eligible.map((row) => row.key)))}
      >
        Select eligible connected machines
      </Button>
      <div className="max-h-[50vh] space-y-2 overflow-y-auto">
        {rows.map((row) => (
          <label key={row.key} className="flex items-start gap-3 rounded-lg border p-3">
            <input
              type="checkbox"
              aria-label={`${row.machineLabel}: ${PROVIDER_DISPLAY_NAMES[row.driver] ?? row.driver} (${row.instanceId})`}
              checked={selected.has(row.key) && !row.reason}
              disabled={busy || !!row.reason}
              onChange={(event) =>
                setSelected((old) => {
                  const next = new Set(old);
                  if (event.target.checked) next.add(row.key);
                  else next.delete(row.key);
                  return next;
                })
              }
            />
            <div className="min-w-0 flex-1 text-sm">
              <div className="font-medium">
                {row.machineLabel} · {PROVIDER_DISPLAY_NAMES[row.driver] ?? row.driver}
              </div>
              <div className="text-muted-foreground">
                {row.provider.version ?? "Unknown"} →{" "}
                {row.provider.versionAdvisory?.latestVersion ?? "Unknown"} · {row.instanceId}
              </div>
              <div className="break-words text-xs text-muted-foreground">
                {row.provider.versionAdvisory?.updateCommand ?? "External installer"}
              </div>
              <div role="status" className="mt-1 text-xs">
                {results[row.key] ?? row.reason ?? "Ready"}
              </div>
            </div>
          </label>
        ))}
        {rows.length === 0 && (
          <p className="text-sm">
            No matching provider snapshots. Connect the machine and refresh Providers.
          </p>
        )}
      </div>
      <p className="text-xs text-muted-foreground">
        Two updates at a time. Keep this page open until the batch finishes. Cancel stops queued
        items; an installer already running finishes normally. Retry by selecting failed items
        again.
      </p>
      <div className="flex justify-end gap-2">
        {busy && (
          <Button
            variant="outline"
            onClick={() => {
              cancelled.current = true;
            }}
          >
            Cancel queued
          </Button>
        )}
        <Button disabled={busy || chosen.length === 0} onClick={() => void start()}>
          {busy ? "Updating…" : `Update ${chosen.length} selected`}
        </Button>
      </div>
    </div>
  );
}

/** Shared entry point for fleet and selected-provider plans; destination RPC checks permissions again. */
export function ProviderUpdatesAction({
  target,
  open: controlledOpen,
  onOpenChange,
}: {
  target?: ProviderUpdateSelection;
  open?: boolean;
  onOpenChange?: (open: boolean) => void;
} = {}) {
  const { environments } = useEnvironments();
  const updateProvider = useAtomCommand(serverEnvironment.updateProvider, { reportFailure: false });
  const [localOpen, setLocalOpen] = useState(false);
  const [plan, setPlan] = useState<ProviderUpdatePlanRow[]>([]);
  const [busy, setBusy] = useState(false);
  const open = controlledOpen ?? localOpen;
  const rows = useMemo(
    () =>
      environments.flatMap((environment) =>
        (environment.serverConfig?.providers ?? [])
          .filter((provider) =>
            target
              ? provider.driver === target.driver
              : provider.versionAdvisory?.status === "behind_latest",
          )
          .map((provider) => ({
            environmentId: environment.environmentId,
            machineLabel: environment.label,
            instanceId: provider.instanceId,
            driver: provider.driver,
            provider,
            key: `${environment.environmentId}:${provider.instanceId}`,
            reason: providerUpdateSkipReason(
              provider,
              environment.connection.phase === "connected",
              readEnvironmentScope(environment.environmentId, AuthProvidersManageScope),
            ),
          })),
      ),
    [environments, target],
  );
  const changeOpen = (value: boolean) => {
    if (!value && busy) return;
    if (value) setPlan(rows);
    setLocalOpen(value);
    onOpenChange?.(value);
  };
  // Controlled selected-provider entry mounts only when the user opens its action.
  const [targetRows] = useState(rows);
  const displayedRows = target ? targetRows : plan;
  if (!target && rows.length === 0 && !open) return null;
  return (
    <>
      {!target && (
        <Button size="xs" variant="ghost-muted" onClick={() => changeOpen(true)}>
          Update CLIs…
        </Button>
      )}
      <Dialog open={open} onOpenChange={changeOpen}>
        <DialogPopup className="max-w-2xl" showCloseButton={!busy}>
          <DialogTitle>
            {target
              ? `Update ${PROVIDER_DISPLAY_NAMES[target.driver] ?? target.driver}`
              : "Update CLIs across machines"}
          </DialogTitle>
          <DialogDescription>
            Review machines and installer actions before updating.
          </DialogDescription>
          {environments
            .filter((environment) => !environment.serverConfig?.providers?.length)
            .map((environment) => (
              <p className="text-xs text-muted-foreground" key={environment.environmentId}>
                {environment.label}:{" "}
                {environment.connection.phase === "connected"
                  ? "No provider snapshot. Refresh Providers on this machine."
                  : "Offline. Connect this machine to inspect its CLIs."}
              </p>
            ))}
          {open && (
            <ProviderUpdatePlan
              rows={displayedRows}
              initialSelection={target ? [`${target.environmentId}:${target.instanceId}`] : []}
              onBusyChange={setBusy}
              run={async (row) => {
                if (!readEnvironmentScope(row.environmentId, AuthProvidersManageScope))
                  throw new Error(
                    "Provider-management permission is unavailable. No update was started.",
                  );
                const result = await updateProvider({
                  environmentId: row.environmentId,
                  input: { provider: row.driver, instanceId: row.instanceId },
                });
                if (result._tag === "Failure") {
                  if (isAtomCommandInterrupted(result))
                    return "Interrupted. Refresh Providers to check the outcome.";
                  throw squashAtomCommandFailure(result);
                }
                const provider = result.value.providers.find(
                  (provider) => provider.instanceId === row.instanceId,
                );
                return provider?.updateState?.status === "succeeded"
                  ? `Updated and verified: ${provider.version ?? "version unavailable"}`
                  : (provider?.updateState?.message ??
                      "Could not verify update. Refresh Providers.");
              }}
            />
          )}
        </DialogPopup>
      </Dialog>
    </>
  );
}
