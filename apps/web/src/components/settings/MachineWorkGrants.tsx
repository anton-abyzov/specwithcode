import { useState } from "react";
import { RefreshCwIcon } from "lucide-react";
import {
  AuthAccessWriteScope,
  type EnvironmentId,
  type ProjectId,
  type ProviderInstanceId,
} from "@specweave-studio/contracts";
import {
  type StudioWorkGrant,
  type StudioWorkGrantAccounts,
  type StudioWorkGrantOwner,
  type StudioWorkGrantProjects,
  type StudioWorkGrantsSnapshot,
  type StudioWorkGrantUpdateInput,
} from "@specweave-studio/contracts/studioFleet";
import { requestConfirmDialog } from "../../confirmDialog";
import { changeMachineWorkGrant, useMachineWorkGrants } from "../../studio/fleet";
import { FLEET_WORKER_ACCESS_CHOICES } from "../../studio/fleetWorkers";
import { useEnvironmentScope } from "../../state/session";
import { SettingsSection } from "./settingsLayout";
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

type GrantChange =
  | { readonly action: "update"; readonly input: StudioWorkGrantUpdateInput }
  | {
      readonly action: "revoke" | "restore";
      readonly input: { readonly coordinatorEnvironmentId: EnvironmentId };
    };

const OWNER_LABELS: Record<StudioWorkGrantOwner, string> = {
  self: "My machine",
  other: "Someone else's machine",
};

function formatTime(value: string): string {
  return new Date(value).toLocaleString(undefined, {
    month: "short",
    day: "numeric",
    hour: "numeric",
    minute: "2-digit",
  });
}

/** One line on which projects a coordinator may run work in. */
export function workGrantProjectsSummary(
  grant: Pick<StudioWorkGrant, "projects" | "coordinatorEnvironmentId" | "machineLabel">,
  projects: StudioWorkGrantsSnapshot["projects"],
): string {
  switch (grant.projects.kind) {
    case "all":
      return "All projects";
    case "linked": {
      const linked = projects.filter((project) =>
        project.linkedTo.includes(grant.coordinatorEnvironmentId),
      );
      return linked.length === 0
        ? `Projects linked to ${grant.machineLabel} (none yet)`
        : `Projects linked to ${grant.machineLabel}: ${linked.map((project) => project.title).join(", ")}`;
    }
    case "listed": {
      const titles = grant.projects.projectIds.map(
        (id) => projects.find((project) => project.id === id)?.title ?? id,
      );
      return titles.length === 0 ? "No projects" : titles.join(", ");
    }
  }
}

/** One line on which of this machine's sign-ins its work may use. */
export function workGrantAccountsSummary(
  accounts: StudioWorkGrantAccounts,
  available: StudioWorkGrantsSnapshot["accounts"],
): string {
  switch (accounts.kind) {
    case "all":
      return "All sign-ins on this machine";
    case "none":
      return "No sign-ins: every launch is refused";
    case "listed": {
      const labels = accounts.instanceIds.map((id) => {
        const account = available.find((candidate) => candidate.instanceId === id);
        return account ? accountLabel(account) : id;
      });
      return labels.length === 0 ? "No sign-ins: every launch is refused" : labels.join(", ");
    }
  }
}

function accountLabel(account: StudioWorkGrantsSnapshot["accounts"][number]): string {
  return account.account ? `${account.label} (${account.account})` : account.label;
}

/** The status line: active until a date, revoked with its grace, or lapsed. */
export function workGrantStatus(grant: StudioWorkGrant): string {
  const running =
    grant.runningThreads === 0
      ? null
      : `${grant.runningThreads} running thread${grant.runningThreads === 1 ? "" : "s"}`;
  if (grant.status === "revoked")
    return [
      `Revoked${grant.revokedAt ? ` ${formatTime(grant.revokedAt)}` : ""}. New work is refused`,
      grant.interruptAt && running ? `${running} stop at ${formatTime(grant.interruptAt)}` : null,
    ]
      .filter(Boolean)
      .join(" · ");
  const parts = [
    grant.status === "expired"
      ? "Expired: that machine must allow workers here again"
      : grant.expiresAt
        ? `Active until ${formatTime(grant.expiresAt)}`
        : "Active",
    running,
  ];
  return parts.filter(Boolean).join(" · ");
}

function runtimeCapLabel(grant: StudioWorkGrant): string {
  if (grant.runtimeCap === null) return "Set by that machine when it next starts work";
  return (
    FLEET_WORKER_ACCESS_CHOICES.find((choice) => choice.value === grant.runtimeCap)?.label ??
    grant.runtimeCap
  );
}

function CheckList<Id extends string>({
  label,
  items,
  selected,
  disabled,
  onChange,
}: {
  label: string;
  items: ReadonlyArray<{ readonly id: Id; readonly title: string }>;
  selected: ReadonlyArray<Id>;
  disabled: boolean;
  onChange: (next: ReadonlyArray<Id>) => void;
}) {
  if (items.length === 0)
    return <p className="text-xs text-muted-foreground">Nothing to choose on this machine yet.</p>;
  return (
    <fieldset className="flex min-w-0 flex-wrap gap-x-4 gap-y-1" aria-label={label}>
      {items.map((item) => (
        <label key={item.id} className="flex min-w-0 items-center gap-1.5 text-xs">
          <input
            type="checkbox"
            checked={selected.includes(item.id)}
            disabled={disabled}
            onChange={(event) =>
              onChange(
                event.target.checked
                  ? [...selected, item.id]
                  : selected.filter((id) => id !== item.id),
              )
            }
          />
          <span className="truncate">{item.title}</span>
        </label>
      ))}
    </fieldset>
  );
}

function ChoiceSelect<Value extends string>({
  label,
  heading,
  value,
  choices,
  disabled,
  onChange,
}: {
  label: string;
  heading: string;
  value: Value;
  choices: ReadonlyArray<{ readonly value: Value; readonly label: string }>;
  disabled: boolean;
  onChange: (value: Value) => void;
}) {
  return (
    <Select
      value={value}
      disabled={disabled}
      onValueChange={(next) => {
        if (next) onChange(next as Value);
      }}
    >
      <SelectTrigger size="xs" className="w-auto min-w-0" aria-label={label}>
        <SelectValue>
          {choices.find((choice) => choice.value === value)?.label ?? value}
        </SelectValue>
      </SelectTrigger>
      <SelectPopup align="start" alignItemWithTrigger={false}>
        <SelectGroup>
          <SelectGroupLabel>{heading}</SelectGroupLabel>
          {choices.map((choice) => (
            <SelectItem key={choice.value} value={choice.value}>
              {choice.label}
            </SelectItem>
          ))}
        </SelectGroup>
      </SelectPopup>
    </Select>
  );
}

export function MachineWorkGrantRow({
  grant,
  snapshot,
  canManage,
  pending,
  onChange,
}: {
  grant: StudioWorkGrant;
  snapshot: StudioWorkGrantsSnapshot;
  canManage: boolean;
  pending: boolean;
  onChange: (change: GrantChange) => void;
}) {
  const coordinatorEnvironmentId = grant.coordinatorEnvironmentId;
  const revoked = grant.status === "revoked";
  const busy = pending || !canManage || revoked;
  const update = (input: Omit<StudioWorkGrantUpdateInput, "coordinatorEnvironmentId">) =>
    onChange({ action: "update", input: { coordinatorEnvironmentId, ...input } });
  const listedProjects = grant.projects.kind === "listed" ? grant.projects.projectIds : [];
  const listedAccounts = grant.accounts.kind === "listed" ? grant.accounts.instanceIds : [];
  return (
    <li
      className="flex min-w-0 flex-col gap-2 px-3 py-2.5 sm:px-4"
      aria-label={`Work from ${grant.machineLabel}`}
    >
      <div className="flex min-w-0 items-start gap-3">
        <div className="min-w-0 flex-1">
          <h3 className="truncate text-sm">{grant.machineLabel}</h3>
          <p className={`text-xs ${revoked ? "text-warning-foreground" : "text-muted-foreground"}`}>
            {workGrantStatus(grant)}
          </p>
        </div>
        {revoked ? (
          <Button
            className="shrink-0"
            size="xs"
            variant="outline"
            disabled={pending || !canManage}
            onClick={() => onChange({ action: "restore", input: { coordinatorEnvironmentId } })}
          >
            Allow again
          </Button>
        ) : (
          <Button
            className="shrink-0"
            size="xs"
            variant="destructive-outline"
            disabled={pending || !canManage}
            onClick={() => onChange({ action: "revoke", input: { coordinatorEnvironmentId } })}
          >
            Revoke
          </Button>
        )}
      </div>
      {grant.legacy ? (
        <p className="text-xs text-muted-foreground">
          Allowed before work could be limited, so it may use every project and sign-in here until
          you change it.
        </p>
      ) : null}
      <dl className="grid min-w-0 grid-cols-[max-content_minmax(0,1fr)] items-center gap-x-3 gap-y-1.5 text-xs">
        <dt className="text-muted-foreground">Whose machine</dt>
        <dd className="flex min-w-0 flex-wrap items-center gap-2">
          <ChoiceSelect
            label={`Whose machine ${grant.machineLabel} is`}
            heading="Whose machine is it"
            value={grant.owner}
            choices={(["self", "other"] as const).map((value) => ({
              value,
              label: OWNER_LABELS[value],
            }))}
            disabled={busy}
            onChange={(owner) => update({ owner })}
          />
          <span className="text-muted-foreground">
            Work from it may pass through {grant.hopLimit} machine{grant.hopLimit === 1 ? "" : "s"}
          </span>
        </dd>
        <dt className="text-muted-foreground">Projects</dt>
        <dd className="flex min-w-0 flex-col gap-1.5">
          <div className="flex min-w-0 flex-wrap items-center gap-2">
            <ChoiceSelect<StudioWorkGrantProjects["kind"]>
              label={`Projects ${grant.machineLabel} may use`}
              heading="Projects it may run work in"
              value={grant.projects.kind}
              choices={[
                { value: "linked", label: "Linked to it" },
                { value: "listed", label: "Chosen projects" },
                { value: "all", label: "All projects" },
              ]}
              disabled={busy}
              onChange={(kind) =>
                update({
                  projects: kind === "listed" ? { kind, projectIds: listedProjects } : { kind },
                })
              }
            />
            <span className="min-w-0 truncate text-muted-foreground">
              {workGrantProjectsSummary(grant, snapshot.projects)}
            </span>
          </div>
          {grant.projects.kind === "listed" ? (
            <CheckList<ProjectId>
              label={`Projects ${grant.machineLabel} may use`}
              items={snapshot.projects.map((project) => ({ id: project.id, title: project.title }))}
              selected={listedProjects}
              disabled={busy}
              onChange={(projectIds) => update({ projects: { kind: "listed", projectIds } })}
            />
          ) : null}
        </dd>
        <dt className="text-muted-foreground">Sign-ins</dt>
        <dd className="flex min-w-0 flex-col gap-1.5">
          <div className="flex min-w-0 flex-wrap items-center gap-2">
            <ChoiceSelect<StudioWorkGrantAccounts["kind"]>
              label={`Sign-ins ${grant.machineLabel} may use`}
              heading="Sign-ins its work may use"
              value={grant.accounts.kind}
              choices={[
                { value: "all", label: "All sign-ins" },
                { value: "listed", label: "Chosen sign-ins" },
                { value: "none", label: "None" },
              ]}
              disabled={busy}
              onChange={(kind) =>
                update({
                  accounts: kind === "listed" ? { kind, instanceIds: listedAccounts } : { kind },
                })
              }
            />
            <span className="min-w-0 truncate text-muted-foreground">
              {workGrantAccountsSummary(grant.accounts, snapshot.accounts)}
            </span>
          </div>
          {grant.accounts.kind === "listed" ? (
            <CheckList<ProviderInstanceId>
              label={`Sign-ins ${grant.machineLabel} may use`}
              items={snapshot.accounts.map((account) => ({
                id: account.instanceId,
                title: accountLabel(account),
              }))}
              selected={listedAccounts}
              disabled={busy}
              onChange={(instanceIds) => update({ accounts: { kind: "listed", instanceIds } })}
            />
          ) : null}
        </dd>
        <dt className="text-muted-foreground">Most access</dt>
        <dd className="text-muted-foreground">{runtimeCapLabel(grant)}</dd>
      </dl>
    </li>
  );
}

export function MachineWorkGrantsList({
  snapshot,
  loading,
  failed,
  canManage,
  pending,
  error,
  notice,
  onRefresh,
  onChange,
}: {
  snapshot: StudioWorkGrantsSnapshot | null;
  loading: boolean;
  failed: boolean;
  canManage: boolean;
  /** The coordinator whose change is being saved. */
  pending: EnvironmentId | null;
  error: string | null;
  notice: string | null;
  onRefresh: () => void;
  onChange: (change: GrantChange) => void;
}) {
  return (
    <SettingsSection
      {...searchableSetting("machine-work-grants")}
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
      {failed ? (
        <p role="status" className="px-3 py-2.5 text-sm text-muted-foreground sm:px-4">
          Could not read who can run work here. Refresh to retry.
        </p>
      ) : snapshot?.grants.length ? (
        <ul className="divide-y divide-border/60">
          {snapshot.grants.map((grant) => (
            <MachineWorkGrantRow
              key={grant.coordinatorEnvironmentId}
              grant={grant}
              snapshot={snapshot}
              canManage={canManage}
              pending={pending !== null}
              onChange={onChange}
            />
          ))}
        </ul>
      ) : (
        <p className="px-3 py-2.5 text-sm text-muted-foreground sm:px-4">
          {loading
            ? "Checking who can run work here…"
            : "No other machine can start work here. A machine gets access when you choose Allow workers for this Mac on it."}
        </p>
      )}
      {snapshot?.grants.length ? (
        <p className="border-t border-border/60 px-3 py-2 text-xs text-muted-foreground sm:px-4">
          Revoke refuses new work at once. Threads it started here keep running for 2 minutes, then
          stop; their worktrees and changes stay.
          {canManage ? null : " Changing this needs Manage access on this machine."}
        </p>
      ) : null}
      {notice || error ? (
        <div className="space-y-1 border-t border-border/60 px-3 py-2 text-xs sm:px-4">
          {notice ? (
            <p role="status" className="text-muted-foreground">
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

/**
 * "Who can run work on this Mac": every coordinator machine with a worker
 * grant on this server's machine, what it may use, and Revoke. This machine
 * owns and enforces these grants.
 */
export function MachineWorkGrants({ environmentId }: { environmentId: EnvironmentId }) {
  const { snapshot, loading, failed, refresh } = useMachineWorkGrants(environmentId);
  const canManage = useEnvironmentScope(environmentId, AuthAccessWriteScope);
  const [pending, setPending] = useState<EnvironmentId | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  // A server from before scoped grants has no such list; show nothing for it.
  if (!snapshot && !loading) return null;
  async function change(next: GrantChange) {
    if (pending || !canManage) return;
    if (next.action === "revoke") {
      const grant = snapshot?.grants.find(
        (candidate) => candidate.coordinatorEnvironmentId === next.input.coordinatorEnvironmentId,
      );
      const label = grant?.machineLabel ?? "this machine";
      // Fail closed: no mounted confirm host means no revoke.
      const confirmed = await requestConfirmDialog(
        `Revoke ${label}?\n${label} can no longer start work here. Threads it started here stop in 2 minutes; their worktrees and changes stay. To undo, choose Allow again here, then Allow workers on ${label}.`,
        { variant: "destructive" },
      );
      if (confirmed !== true) return;
    }
    setPending(next.input.coordinatorEnvironmentId);
    setError(null);
    setNotice(null);
    try {
      const grant = await changeMachineWorkGrant(environmentId, next);
      if (next.action === "revoke")
        setNotice(
          grant.runningThreads > 0 && grant.interruptAt
            ? `${grant.machineLabel} can no longer start work here. Its ${grant.runningThreads} running thread${grant.runningThreads === 1 ? "" : "s"} stop at ${formatTime(grant.interruptAt)}.`
            : `${grant.machineLabel} can no longer start work here.`,
        );
      else if (next.action === "restore")
        setNotice(
          `${grant.machineLabel} may be allowed again. On ${grant.machineLabel}, choose Allow workers for this Mac.`,
        );
    } catch (failure) {
      setError(failure instanceof Error ? failure.message : "Could not save this change.");
    } finally {
      setPending(null);
    }
  }
  return (
    <MachineWorkGrantsList
      snapshot={snapshot}
      loading={loading}
      failed={failed}
      canManage={canManage}
      pending={pending}
      error={error}
      notice={notice}
      onRefresh={refresh}
      onChange={(next) => void change(next)}
    />
  );
}
