import {
  AuthSettingsWriteScope,
  type EnvironmentId,
  type ExecutionEnvironmentPlatformOs,
} from "@specweave-studio/contracts";
import { updatesMayPauseWork } from "@specweave-studio/shared/updatePause";
import { useAtomValue } from "@effect/atom-react";
import { useEffect, useState } from "react";

import { useTx } from "../../i18n";
import { serverEnvironment } from "../../state/server";
import { type EnvironmentScopeAccess, useEnvironmentScopeAccess } from "../../state/session";
import { useAtomCommand } from "../../state/use-atom-command";
import { Switch } from "../ui/switch";
import { stackedThreadToast, toastManager } from "../ui/toast";
import { searchableSetting } from "./settingsSearch";

export interface UpdatePausePolicyViewProps {
  readonly machineLabel: string;
  /** This machine's own card: the one settings search lands on. */
  readonly local: boolean;
  readonly os: ExecutionEnvironmentPlatformOs | null;
  readonly checked: boolean;
  /** That machine has "Continue threads after restarts" off, so a pause could not continue. */
  readonly continuationOff: boolean;
  readonly reachable: boolean;
  /** Reachable but its settings have not arrived, or this connection may not change them. */
  readonly readOnly: boolean;
  /** This connection's settings access there; only "granted" enables the switch. */
  readonly writeAccess: EnvironmentScopeAccess;
  readonly onCheckedChange: (checked: boolean) => void;
}

/** Which wait the "on" description names: the Mac's own choice, Linux's fixed 30 minutes. */
function onDescription(os: ExecutionEnvironmentPlatformOs | null): string {
  if (os === "darwin") {
    return "After the wait set in “Pause running work after”, running turns pause, the update installs, and they continue where they left off.";
  }
  if (os === "linux") {
    return "After 30 minutes of waiting, running turns pause, the update installs, and they continue where they left off.";
  }
  return "After the wait, running turns pause, the update installs, and they continue where they left off. On a Mac the wait is “Pause running work after”; on Linux it is 30 minutes.";
}

/**
 * What "off" means differs by OS: a Mac's update agent tries again every 10
 * minutes for as long as it takes, a Linux service gives up after its
 * 30-minute wait and stays on its version until the next update request.
 */
function offDescription(os: ExecutionEnvironmentPlatformOs | null): string {
  if (os === "darwin") {
    return "An update waits until {machine} has no running work, however long that takes. Update now still installs right away.";
  }
  if (os === "linux") {
    return "An update waits up to 30 minutes for {machine} to have no running work. If it is still busy then, {machine} stays on its version until the next update. Update now still installs right away.";
  }
  return "An update waits for {machine} to have no running work. A Mac keeps waiting as long as that takes; a Linux machine waits up to 30 minutes and, if still busy, stays on its version until the next update. Update now still installs right away.";
}

export function UpdatePausePolicyView(props: UpdatePausePolicyViewProps) {
  const tx = useTx();
  const effective = updatesMayPauseWork({
    pauseWorkForUpdates: props.checked,
    continueThreadsAfterServerUpdate: !props.continuationOff,
  });
  const anchor = props.local ? searchableSetting("pause-work-for-updates") : null;
  return (
    <div
      {...(anchor ? { id: anchor.id } : {})}
      className="flex items-start justify-between gap-3 border-t border-border/60 pt-2"
    >
      <div className="flex min-w-0 flex-col gap-1">
        <span className="font-medium">{tx("Pause running work for updates")}</span>
        <p className="text-muted-foreground">
          {props.checked && effective
            ? tx(onDescription(props.os))
            : tx(offDescription(props.os), { machine: props.machineLabel })}
        </p>
        {props.continuationOff && (
          <p role="note" className="border-l-2 border-border pl-2 text-muted-foreground">
            {tx(
              "Has no effect on {machine} while “Continue threads after restarts” is off there: paused turns would not continue, so updates wait for quiet. Turn that on in Settings > General.",
              { machine: props.machineLabel },
            )}
          </p>
        )}
        {!props.reachable ? (
          <p className="text-muted-foreground">
            {tx("{machine} is unreachable, so this setting cannot be changed now.", {
              machine: props.machineLabel,
            })}
          </p>
        ) : props.writeAccess === "denied" ? (
          <p className="text-muted-foreground">
            {tx("This connection cannot change settings on {machine}.", {
              machine: props.machineLabel,
            })}
          </p>
        ) : null}
      </div>
      <Switch
        size="sm"
        checked={props.checked}
        disabled={!props.reachable || props.readOnly || props.writeAccess !== "granted"}
        onCheckedChange={(checked) => props.onCheckedChange(Boolean(checked))}
        aria-label={tx("Pause running work for updates")}
      />
    </div>
  );
}

/**
 * The machine's own update pause choice on its update card. The value lives in
 * that machine's server settings and is written to that machine only: each
 * machine's owner decides whether updates may pause work there, so the patch
 * never goes through the path that copies shared settings to every machine.
 */
export function UpdatePausePolicyRow({
  environmentId,
  label,
  reachable,
  local,
}: {
  environmentId: EnvironmentId;
  label: string;
  reachable: boolean;
  local: boolean;
}) {
  const tx = useTx();
  const config = useAtomValue(serverEnvironment.configValueAtom(environmentId));
  // Loading or signed out is not a missing permission: the switch stays
  // disabled, but the permission line is kept for a real denial.
  const writeAccess = useEnvironmentScopeAccess(environmentId, AuthSettingsWriteScope);
  const persist = useAtomCommand(serverEnvironment.updateSettings, { reportFailure: false });
  const settings = config?.settings ?? null;
  const saved = settings?.pauseWorkForUpdates === true;
  // Shows the new position while the save is under way; cleared once the
  // machine reports it, or put back when the save fails.
  const [shown, setShown] = useState<boolean | null>(null);
  const [saving, setSaving] = useState(false);
  useEffect(() => {
    if (shown !== null && !saving && shown === saved) setShown(null);
  }, [saved, saving, shown]);

  const change = async (checked: boolean) => {
    if (saving || !reachable || settings === null || writeAccess !== "granted") return;
    setShown(checked);
    setSaving(true);
    let failed = false;
    // A machine on a release older than the setting accepts the save and drops
    // the key: its answer then still reads off.
    let unknownThere = false;
    try {
      const result = await persist({
        environmentId,
        input: { patch: { pauseWorkForUpdates: checked } },
      });
      failed = result._tag === "Failure";
      unknownThere = result._tag === "Success" && result.value.pauseWorkForUpdates !== checked;
    } catch {
      failed = true;
    } finally {
      setSaving(false);
    }
    if (failed || unknownThere) {
      setShown(null);
      toastManager.add(
        stackedThreadToast({
          type: "error",
          title: tx("Could not save update settings"),
          description: unknownThere
            ? tx(
                "{machine} runs a SpecWithCode version without this setting. Update {machine} first.",
                { machine: label },
              )
            : // The machine may have applied it and only the reply was lost.
              tx(
                "The change could not be confirmed on {machine}. The switch shows what {machine} reports.",
                {
                  machine: label,
                },
              ),
        }),
      );
    }
  };

  return (
    <UpdatePausePolicyView
      machineLabel={label}
      local={local}
      os={config?.environment.platform.os ?? null}
      checked={shown ?? saved}
      continuationOff={settings?.continueThreadsAfterServerUpdate === false}
      reachable={reachable}
      readOnly={settings === null || saving}
      writeAccess={writeAccess}
      onCheckedChange={(checked) => void change(checked)}
    />
  );
}
