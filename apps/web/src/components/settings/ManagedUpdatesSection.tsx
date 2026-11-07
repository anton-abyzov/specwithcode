import { renderRich } from "../../i18n/rich";
import { useTx } from "../../i18n";
import type { ServerUpdateState } from "@specweave-studio/client-runtime/state/server";
import { useState } from "react";
import { type EnvironmentId, type ManagedUpdateStatus } from "@specweave-studio/contracts";
import { managedUpdates } from "../../state/managedUpdates";
import { useEnvironmentQuery } from "../../state/query";
import { useEnvironmentScope } from "../../state/session";
import { useAtomCommand } from "../../state/use-atom-command";
import { requestConfirmDialog } from "../../confirmDialog";
import { ServerUpdateProgress } from "../ServerUpdateAction";
import { Button } from "../ui/button";
import type { EnvironmentPresentation } from "../../state/environments";
import { formatRelativeTimeLabel } from "../../timestampFormat";
import { useMachineNickname } from "../../studio/machineNickname";

const consentLabels = {
  "not-enrolled": "Update permission: Not granted.",
  enrolled: "Update permission: Granted to this connection.",
  "other-controller": "Update permission: Granted to another connection.",
  revoked: "Update permission: Revoked.",
};
/**
 * Why the update agent's saved state may be frozen, from what launchd reports
 * now; null when it is running (or an older service did not say).
 */
export function updateAgentProblem(status: ManagedUpdateStatus): string | null {
  if (status.agentDisabled === true) return "Update agent is turned off in launchd.";
  if (status.agentLoaded === false || status.stale === true) {
    const checked = status.checkedAt ? formatRelativeTimeLabel(status.checkedAt) : "";
    return `Update agent not running · last check ${checked || "never"}.`;
  }
  return null;
}

export function ManagedUpdatesView(props: {
  label: string;
  reachable: boolean;
  status: ManagedUpdateStatus | null;
  error: boolean;
  canManage: boolean;
  canCheck: boolean;
  pending: boolean;
  /** This Mac's own service: its updater manages it, no connection permission needed. */
  local?: boolean;
  onAllow: () => void;
  onRevoke: () => void;
  onCheck: () => void;
  onRefresh: () => void;
  /** Present only where this Mac's desktop can repair its update agent. */
  onRepair?: () => void;
}) {
  const tx = useTx();
  const { status } = props;
  const valid = props.reachable && !props.error && status?.support === "supported";
  // A local service is managed by this Mac's updater; asking this connection for
  // permission over it is only noise. An existing enrollment can still be revoked.
  const managedHere = valid && props.local === true && status.remoteConsent !== "enrolled";
  const problem = valid ? updateAgentProblem(status) : null;
  return (
    <section
      aria-label={`Updates for ${props.label}`}
      className="mt-3 flex max-w-xl flex-col gap-2 rounded-lg border border-border/60 p-3 text-xs [--disabled-opacity:0.45]"
    >
      <div className="flex flex-wrap justify-between gap-2">
        <span className="font-medium">{tx("Updates")}</span>
        {status?.currentVersion && (
          <span className="text-muted-foreground">
            {renderRich(tx("Service {currentVersion}"), { currentVersion: status.currentVersion })}
          </span>
        )}
      </div>
      {!props.reachable ? (
        <p>{tx("Machine unreachable. Saved update permission has not changed.")}</p>
      ) : props.error ? (
        <p role="status">{tx("Update status unavailable. Permission has not been changed.")}</p>
      ) : !status ? (
        <p>{tx("Reading update status…")}</p>
      ) : status.support !== "supported" ? (
        <p>
          {status.support === "unmanaged"
            ? tx("This machine does not have a managed service installation.")
            : tx("Managed updates are unavailable on this installation.")}
        </p>
      ) : (
        <>
          <p className="font-medium">
            {managedHere
              ? tx("Managed by this machine's updater.")
              : consentLabels[status.remoteConsent]}
          </p>
          <p>
            {renderRich(
              tx(
                "Automatic updates on {label}: {value}. Permission changes preserve this setting.",
              ),
              {
                label: props.label,
                value:
                  status.localAutomation === "unavailable"
                    ? "updater not installed"
                    : status.localAutomation === "enabled"
                      ? "enabled"
                      : "disabled",
              },
            )}
          </p>
          <p>
            {renderRich(tx("Last result: {value}{value2}. Last check: {value3}."), {
              value: status.operation.replaceAll("-", " "),
              value2: status.availableVersion
                ? tx(" · {version} available", { version: status.availableVersion })
                : "",
              value3: status.checkedAt ? new Date(status.checkedAt).toLocaleString() : tx("never"),
            })}
          </p>
          {problem && (
            <p role="status" className="text-destructive-foreground">
              {problem}
            </p>
          )}
        </>
      )}
      <p className="text-muted-foreground">
        {tx("Update permission is separate from connection and agent work access.")}
      </p>
      <div className="flex flex-wrap gap-2">
        <Button
          size="sm"
          variant="outline"
          disabled={!props.reachable || props.pending}
          onClick={props.onRefresh}
        >
          {tx("Refresh status")}
        </Button>
        {problem && props.onRepair && (
          <Button size="sm" variant="outline" disabled={props.pending} onClick={props.onRepair}>
            {tx("Repair")}
          </Button>
        )}
        {valid && !managedHere && (
          <>
            {props.canManage && (
              <Button
                size="sm"
                variant="outline"
                disabled={props.pending}
                onClick={status.remoteConsent === "enrolled" ? props.onRevoke : props.onAllow}
              >
                {status.remoteConsent === "enrolled"
                  ? tx("Revoke update permission")
                  : tx("Grant update permission")}
              </Button>
            )}
            {props.canCheck && status.remoteConsent === "enrolled" && (
              <Button size="sm" variant="outline" disabled={props.pending} onClick={props.onCheck}>
                {tx("Check for updates")}
              </Button>
            )}
          </>
        )}
      </div>
      {valid && !managedHere && !props.canManage && (
        <p className="border-l-2 border-border pl-2 text-muted-foreground">
          {status.remoteConsent === "enrolled"
            ? `A machine administrator must change update permission on ${props.label}.`
            : `A machine administrator must approve update permission for this connection on ${props.label}.`}
          {props.local
            ? tx(" Use the installed app on this machine.")
            : tx(" Being connected does not grant update permission.")}
        </p>
      )}
      {valid && !managedHere && (
        <p className="text-muted-foreground">
          {status.remoteConsent !== "enrolled"
            ? tx("Checking for updates requires permission for this connection.")
            : !props.canCheck
              ? tx("This connection does not have maintenance access to check for updates.")
              : tx("Check for updates finds releases; it does not download or install them.")}
        </p>
      )}
    </section>
  );
}

export function ManagedUpdatesSection({
  environmentId,
  label: hostLabel,
  reachable,
  local = false,
}: {
  environmentId: EnvironmentId;
  label: string;
  reachable: boolean;
  local?: boolean;
}) {
  const tx = useTx();
  const label = useMachineNickname(environmentId, hostLabel);
  const query = useEnvironmentQuery(
    reachable ? managedUpdates.status({ environmentId, input: {} }) : null,
  );
  const canAdmin = useEnvironmentScope(environmentId, "access:write");
  const canMaintain = useEnvironmentScope(environmentId, "environment:maintain");
  const enroll = useAtomCommand(managedUpdates.enroll, { reportFailure: false });
  const revoke = useAtomCommand(managedUpdates.revoke, { reportFailure: false });
  const check = useAtomCommand(managedUpdates.check, { reportFailure: false });
  const [pending, setPending] = useState(false);
  const [failed, setFailed] = useState(false);
  const [repairFailure, setRepairFailure] = useState<string | null>(null);
  const bridge = typeof window !== "undefined" ? window.desktopBridge : undefined;
  const unsupported =
    query.failure &&
    typeof query.failure === "object" &&
    "code" in query.failure &&
    query.failure.code === "unsupported";
  const shownStatus = unsupported
    ? ({
        environmentId,
        installationId: null,
        support: "unsupported",
        localAutomation: "unavailable",
        remoteConsent: "not-enrolled",
        revision: 0,
        operation: "idle",
        currentVersion: null,
        availableVersion: null,
        checkedAt: null,
      } as const)
    : query.data;
  const native = local && typeof bridge?.requestManagedUpdateConsent === "function";
  const repairServiceUpdateAgent = local ? bridge?.repairServiceUpdateAgent : undefined;
  // Repair runs launchctl enable, bootstrap and kickstart on this Mac, and only
  // on this click: whoever turned the agent off may have meant it.
  const repair = async () => {
    if (pending || typeof repairServiceUpdateAgent !== "function") return;
    setPending(true);
    setRepairFailure(null);
    try {
      const state = await repairServiceUpdateAgent();
      if (state.status === "error") {
        setRepairFailure(state.message ?? "The update agent could not be repaired.");
      }
    } catch {
      setRepairFailure("The update agent could not be repaired.");
    } finally {
      setPending(false);
      query.refresh();
    }
  };
  const run = async (action: "enroll" | "revoke" | "check") => {
    const status = query.data;
    if (
      pending ||
      !reachable ||
      query.error ||
      !status?.installationId ||
      status.support !== "supported"
    )
      return;
    setPending(true);
    setFailed(false);
    const input = {
      installationId: status.installationId,
      environmentId,
      expectedRevision: status.revision,
    };
    try {
      if (action !== "check" && native) {
        await bridge!.requestManagedUpdateConsent!({ ...input, action });
      } else {
        if (
          action !== "check" &&
          !(await requestConfirmDialog(
            action === "enroll"
              ? `Allow this connection to manage updates on ${label}? Existing automatic update settings stay unchanged.`
              : `Revoke this connection's update permission on ${label}? Existing local automatic updates stay unchanged.`,
          ))
        )
          return;
        const result =
          action === "enroll"
            ? await enroll({ environmentId, input: { ...input, consent: true } })
            : action === "revoke"
              ? await revoke({ environmentId, input })
              : await check({
                  environmentId,
                  input: { environmentId, installationId: status.installationId },
                });
        if (result._tag === "Failure") setFailed(true);
      }
    } catch {
      setFailed(true);
    } finally {
      setPending(false);
      query.refresh();
    }
  };
  return (
    <>
      <ManagedUpdatesView
        label={label}
        reachable={reachable}
        status={shownStatus}
        error={query.error !== null && !unsupported}
        canManage={canMaintain && (canAdmin || native)}
        canCheck={canMaintain}
        pending={pending}
        local={local}
        onAllow={() => void run("enroll")}
        onRevoke={() => void run("revoke")}
        onCheck={() => void run("check")}
        onRefresh={() => {
          setFailed(false);
          setRepairFailure(null);
          query.refresh();
        }}
        {...(typeof repairServiceUpdateAgent === "function"
          ? { onRepair: () => void repair() }
          : {})}
      />
      {repairFailure && (
        <p role="alert" className="mt-1 text-xs text-destructive-foreground">
          {repairFailure}
        </p>
      )}
      {failed && (
        <p role="alert" className="mt-1 text-xs text-destructive-foreground">
          {tx(
            "Update request was refused or failed. Refresh status and try again; changed permissions require fresh approval.",
          )}
        </p>
      )}
    </>
  );
}

/** Retains existing row progress while exposing destination-specific update permission. */
export function ManagedConnectionUpdates({
  environment,
  state,
}: {
  environment: EnvironmentPresentation;
  state: ServerUpdateState;
}) {
  return (
    <>
      {state.status !== "idle" && (
        <div className="mt-1 max-w-md">
          <ServerUpdateProgress state={state} />
        </div>
      )}
      <ManagedUpdatesSection
        environmentId={environment.environmentId}
        label={environment.label}
        reachable={environment.connection.phase === "connected"}
        local={environment.entry.target._tag === "PrimaryConnectionTarget"}
      />
    </>
  );
}
