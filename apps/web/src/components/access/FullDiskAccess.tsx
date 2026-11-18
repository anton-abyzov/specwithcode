import { useCallback, useEffect, useRef, useState } from "react";
import { CheckIcon, CircleAlertIcon, RotateCwIcon, ShieldAlertIcon } from "lucide-react";
import {
  FULL_DISK_ACCESS_UNLOCKS,
  fullDiskAccessRiskLine,
  type EnvironmentId,
  type PrivacyAccess,
} from "@specweave-studio/contracts";
import { squashAtomCommandFailure } from "@specweave-studio/client-runtime/state/runtime";

import { useTx } from "../../i18n";
import { readLocalApi } from "../../localApi";
import { usePrimaryEnvironment, usePrimaryEnvironmentId } from "../../state/environments";
import { useAtomCommand } from "../../state/use-atom-command";
import { machineHandoff } from "../../studio/machineHandoff";
import { Button } from "../ui/button";

export const FULL_DISK_ACCESS_DOCS_URL =
  "https://github.com/anton-abyzov/specwithcode/blob/main/docs/user/full-disk-access.md";

/** After Open System Settings, the row rechecks this often, for this long, and on focus. */
const WATCH_INTERVAL_MS = 2_000;
const WATCH_FOR_MS = 120_000;

/** Whether this window can open System Settings on that machine (it is this Mac). */
export function useCanOpenSettingsFor(environmentId: EnvironmentId | null): boolean {
  const primary = usePrimaryEnvironmentId();
  return (
    environmentId !== null &&
    environmentId === primary &&
    typeof window !== "undefined" &&
    window.desktopBridge?.openSystemSettings !== undefined
  );
}

/** What System Settings should offer to drag: the agents' launchd executable, else the app. */
export function settingsRequestFor(access: PrivacyAccess | null) {
  const host = access?.agentHost;
  return host?.kind === "executable"
    ? { pane: "full-disk-access" as const, agentHost: { path: host.path, name: host.name } }
    : ("full-disk-access" as const);
}

/**
 * The agents' Full Disk Access on one machine, probed there by its service.
 * `watch()` starts the recheck loop that follows Open System Settings and
 * closes the drag helper once the grant shows up.
 */
export function useFullDiskAccess(environmentId: EnvironmentId, enabled = true) {
  const check = useAtomCommand(machineHandoff.privacyAccess, { reportFailure: false });
  const [access, setAccess] = useState<PrivacyAccess | null>(null);
  const [error, setError] = useState<string | null>(null);
  const watchUntil = useRef(0);

  const refresh = useCallback(async () => {
    const result = await check({ environmentId, input: {} });
    if (result._tag === "Failure") {
      const cause = squashAtomCommandFailure(result);
      setError(cause instanceof Error && cause.message ? cause.message : "unavailable");
      return null;
    }
    setError(null);
    setAccess(result.value);
    if (result.value.fullDiskAccess === "allowed" && watchUntil.current > 0) {
      watchUntil.current = 0;
      void window.desktopBridge?.closeSystemSettingsHelper?.();
    }
    return result.value;
  }, [check, environmentId]);

  useEffect(() => {
    if (!enabled) return;
    void refresh();
    const onFocus = () => void refresh();
    window.addEventListener("focus", onFocus);
    const timer = window.setInterval(() => {
      if (watchUntil.current > Date.now()) void refresh();
    }, WATCH_INTERVAL_MS);
    return () => {
      window.removeEventListener("focus", onFocus);
      window.clearInterval(timer);
    };
  }, [enabled, refresh]);

  const openSettings = useCallback(async () => {
    watchUntil.current = Date.now() + WATCH_FOR_MS;
    await readLocalApi()?.shell.openSystemSettings(settingsRequestFor(access));
  }, [access]);

  return { access, error, refresh, openSettings };
}

/** What it unlocks, the risk, and why some tasks need it. Shared by Settings, first run and the card. */
export function FullDiskAccessExplanation({
  machine,
  access,
}: {
  readonly machine: string;
  readonly access: PrivacyAccess | null;
}) {
  const tx = useTx();
  const host = access?.agentHost;
  return (
    <div className="space-y-2 text-xs text-muted-foreground" data-slot="fda-explanation">
      <p>
        {tx(
          "Some tasks need it: listing Chrome profiles, reading Mail or Messages, searching Safari history, or working with another app's files. macOS blocks these for every app until you allow it.",
        )}
      </p>
      <ul className="flex flex-wrap gap-1.5" aria-label={tx("What it unlocks")}>
        {FULL_DISK_ACCESS_UNLOCKS.map((item) => (
          <li key={item} className="rounded-full border border-border bg-secondary px-2 py-0.5">
            {tx(item)}
          </li>
        ))}
      </ul>
      <p
        role="note"
        className="flex items-start gap-1.5 rounded-md border-l-2 border-warning bg-warning/10 px-2 py-1.5 text-foreground"
      >
        <ShieldAlertIcon aria-hidden className="mt-0.5 size-3.5 shrink-0 text-warning-foreground" />
        <span>
          {fullDiskAccessRiskLine(machine)}{" "}
          {tx(
            "A prompt hidden in a web page or file could ask an agent to read your mail. Turn it on only if you need it.",
          )}
        </span>
      </p>
      {host ? (
        <p>
          {host.kind === "app"
            ? tx("In System Settings › Privacy & Security › Full Disk Access, turn on SpecWithCode.")
            : `${tx("Agents here run under a background service, so macOS asks about it, not the app. In System Settings › Privacy & Security › Full Disk Access, add")} ${host.path}.`}
        </p>
      ) : null}
      <p>
        <a
          className="underline underline-offset-2"
          href={FULL_DISK_ACCESS_DOCS_URL}
          target="_blank"
          rel="noreferrer"
        >
          {tx("How Full Disk Access works and how to turn it off")}
        </a>
      </p>
    </div>
  );
}

/**
 * The "Full Disk Access for agents" row of a Mac's readiness checklist. Off a
 * Mac it renders nothing. Only this Mac's own window gets the deep link; another
 * machine's card names the step to take there.
 */
export function FullDiskAccessRow({
  environmentId,
  environmentLabel,
}: {
  readonly environmentId: EnvironmentId;
  readonly environmentLabel: string;
}) {
  const tx = useTx();
  const { access, error, refresh, openSettings } = useFullDiskAccess(environmentId);
  const local = useCanOpenSettingsFor(environmentId);
  const [opening, setOpening] = useState(false);
  if (error !== null || access === null || access.fullDiskAccess === "not-applicable") return null;
  const allowed = access.fullDiskAccess === "allowed";
  const title = allowed
    ? access.runningAgentsNeedRestart
      ? tx("Full Disk Access for agents: allowed, restart running threads")
      : tx("Full Disk Access for agents: allowed")
    : access.fullDiskAccess === "unknown"
      ? tx("Full Disk Access for agents: could not be checked")
      : tx("Full Disk Access for agents: off");
  return (
    <div data-slot="machine-readiness-privacy" className="space-y-1">
      <h4 className="text-xs font-medium text-muted-foreground">{tx("Privacy access")}</h4>
      <div className="flex min-w-0 items-start gap-2" data-slot="fda-row" data-state={access.fullDiskAccess}>
        {allowed && !access.runningAgentsNeedRestart ? (
          <CheckIcon aria-label={tx("Ready")} className="mt-0.5 size-3.5 shrink-0 text-success-foreground" />
        ) : access.runningAgentsNeedRestart ? (
          <RotateCwIcon aria-label={tx("Restart needed")} className="mt-0.5 size-3.5 shrink-0 text-warning-foreground" />
        ) : (
          <CircleAlertIcon aria-label={tx("Optional")} className="mt-0.5 size-3.5 shrink-0 text-muted-foreground" />
        )}
        <div className="min-w-0 flex-1 space-y-1">
          <p className="wrap-anywhere">{title}</p>
          {allowed ? (
            <p className="text-xs text-muted-foreground">
              {access.runningAgentsNeedRestart
                ? tx("New agent runs have it. Threads that were already running get it after they restart.")
                : `${fullDiskAccessRiskLine(environmentLabel)}`}
            </p>
          ) : (
            <p className="text-xs text-muted-foreground">
              {`${tx("Optional. Agents on")} ${environmentLabel} ${tx("can't read Chrome or Safari profiles, Mail, Messages, Notes or other apps' data.")}`}
            </p>
          )}
          {!allowed ? (
            <details className="text-xs">
              <summary className="cursor-pointer text-muted-foreground">{tx("What this allows")}</summary>
              <div className="mt-2">
                <FullDiskAccessExplanation machine={environmentLabel} access={access} />
              </div>
            </details>
          ) : null}
          <div className="flex flex-wrap gap-2">
            {!allowed && local ? (
              <Button
                size="xs"
                variant="outline"
                disabled={opening}
                onClick={() => {
                  setOpening(true);
                  void openSettings().finally(() => setOpening(false));
                }}
              >
                {tx("Open System Settings")}
              </Button>
            ) : null}
            {!allowed && !local ? (
              <span className="text-xs text-muted-foreground">
                {`${tx("Open SpecWithCode on")} ${environmentLabel} ${tx("to allow it there.")}`}
              </span>
            ) : null}
            <Button size="xs" variant="outline" onClick={() => void refresh()}>
              {tx("Check again")}
            </Button>
          </div>
        </div>
      </div>
    </div>
  );
}

/**
 * First run's optional mention, inside the Access step: closed by default and
 * never part of what Continue needs, so people learn the option exists without
 * being pushed into it. Shown only in the desktop app on a Mac.
 */
export function FirstRunFullDiskAccess() {
  const tx = useTx();
  const primary = usePrimaryEnvironment();
  const local = useCanOpenSettingsFor(primary?.environmentId ?? null);
  if (!local || primary === null) return null;
  return <FirstRunFullDiskAccessBody environmentId={primary.environmentId} machine={primary.label} tx={tx} />;
}

function FirstRunFullDiskAccessBody({
  environmentId,
  machine,
  tx,
}: {
  readonly environmentId: EnvironmentId;
  readonly machine: string;
  readonly tx: ReturnType<typeof useTx>;
}) {
  const [open, setOpen] = useState(false);
  const { access, openSettings } = useFullDiskAccess(environmentId, open);
  if (access?.fullDiskAccess === "not-applicable") return null;
  return (
    <details
      data-slot="first-run-fda"
      className="mt-3 rounded-xl border border-border bg-card p-4 text-sm"
      onToggle={(event) => setOpen((event.currentTarget as HTMLDetailsElement).open)}
    >
      <summary className="cursor-pointer font-semibold text-foreground">
        {tx("Full Disk Access for agents (optional)")}
      </summary>
      <div className="mt-2 space-y-2">
        <FullDiskAccessExplanation machine={machine} access={access} />
        {access?.fullDiskAccess === "allowed" ? (
          <p className="text-xs text-success-foreground">{tx("Already allowed on this Mac.")}</p>
        ) : (
          <Button size="xs" variant="outline" onClick={() => void openSettings()}>
            {tx("Open System Settings")}
          </Button>
        )}
        <p className="text-xs text-muted-foreground">
          {tx("You can skip this. It is also in Settings › Machines, and agents ask when a task needs it.")}
        </p>
      </div>
    </details>
  );
}
