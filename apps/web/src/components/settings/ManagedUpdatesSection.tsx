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

const consentLabels = {
  "not-enrolled": "This connection has no update permission.",
  enrolled: "This connection can manage updates.",
  "other-controller": "Update permission belongs to another connection.",
  revoked: "Update permission was revoked.",
};
export function ManagedUpdatesView(props: {
  label: string;
  reachable: boolean;
  status: ManagedUpdateStatus | null;
  error: boolean;
  canManage: boolean;
  canCheck: boolean;
  pending: boolean;
  onAllow: () => void;
  onRevoke: () => void;
  onCheck: () => void;
  onRefresh: () => void;
}) {
  const { status } = props;
  const valid = props.reachable && !props.error && status?.support === "supported";
  return (
    <section
      aria-label={`Updates for ${props.label}`}
      className="mt-2 flex max-w-xl flex-col gap-2 rounded-lg border border-border/60 p-3 text-xs"
    >
      <div className="flex flex-wrap justify-between gap-2">
        <span className="font-medium">Updates · {props.label}</span>
        {status && <span>Installed {status.currentVersion ?? "unknown"}</span>}
      </div>
      {!props.reachable ? (
        <p>Machine unreachable. Saved update permission has not changed.</p>
      ) : props.error ? (
        <p role="status">Update status unavailable. Permission has not been changed.</p>
      ) : !status ? (
        <p>Reading update status…</p>
      ) : status.support !== "supported" ? (
        <p>
          {status.support === "unmanaged"
            ? "This machine does not have a managed service installation."
            : "Managed updates are not supported on this installation."}
        </p>
      ) : (
        <>
          <p>{consentLabels[status.remoteConsent]}</p>
          <p>
            Automatic updates:{" "}
            {status.localAutomation === "unavailable"
              ? "updater not installed"
              : status.localAutomation === "enabled"
                ? "enabled"
                : "disabled"}
            . Permission changes preserve this setting.
          </p>
          <p>
            Last result: {status.operation.replaceAll("-", " ")}
            {status.availableVersion ? ` · ${status.availableVersion} available` : ""}. Last check:{" "}
            {status.checkedAt ? new Date(status.checkedAt).toLocaleString() : "never"}.
          </p>
        </>
      )}
      <div className="flex flex-wrap gap-2">
        <Button
          size="sm"
          variant="outline"
          disabled={!props.reachable || props.pending}
          onClick={props.onRefresh}
        >
          Refresh status
        </Button>
        {valid && (
          <>
            <Button
              size="sm"
              variant="outline"
              disabled={!props.canManage || props.pending}
              onClick={status.remoteConsent === "enrolled" ? props.onRevoke : props.onAllow}
            >
              {status.remoteConsent === "enrolled" ? "Revoke permission" : "Allow this connection"}
            </Button>
            <Button
              size="sm"
              variant="outline"
              disabled={!props.canCheck || status.remoteConsent !== "enrolled" || props.pending}
              onClick={props.onCheck}
            >
              Check only
            </Button>
          </>
        )}
      </div>
      {valid && !props.canManage && (
        <p>
          A machine administrator must approve update permission. On this Mac, use the installed app
          to approve it.
        </p>
      )}
      {valid && <p>Check only finds releases; it does not download or install them.</p>}
    </section>
  );
}

export function ManagedUpdatesSection({
  environmentId,
  label,
  reachable,
  local = false,
}: {
  environmentId: EnvironmentId;
  label: string;
  reachable: boolean;
  local?: boolean;
}) {
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
        onAllow={() => void run("enroll")}
        onRevoke={() => void run("revoke")}
        onCheck={() => void run("check")}
        onRefresh={() => {
          setFailed(false);
          query.refresh();
        }}
      />
      {failed && (
        <p role="alert" className="mt-1 text-xs text-destructive-foreground">
          Update request was refused or failed. Refresh status and try again; changed permissions
          require fresh approval.
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
