import { useTx } from "../../i18n";
import { useState, type ReactNode } from "react";
import { ArrowRightIcon, ChevronRightIcon, InfoIcon, RefreshCwIcon, RouteIcon } from "lucide-react";
import {
  AuthAccessWriteScope,
  type EnvironmentId,
  type ProjectId,
} from "@specweave-studio/contracts";
import {
  type StudioWorkGrant,
  type StudioWorkGrantOwner,
  type StudioWorkGrantProjects,
  type StudioWorkGrantsSnapshot,
  type StudioWorkGrantUpdateInput,
} from "@specweave-studio/contracts/studioFleet";
import { requestConfirmDialog } from "../../confirmDialog";
import {
  formatTime,
  workGrantAccessName,
  workGrantAccessNote,
  workGrantAllowsNoProject,
  workGrantHopPath,
  workGrantRoutinesNote,
  workGrantMachineLabel,
  workGrantProjectsSummary,
  workGrantSummary,
  workGrantUnavailableNote,
} from "./machineWorkGrants.logic";
import { changeMachineWorkGrant, type useMachineWorkGrants } from "../../studio/fleet";
import { machineNickname } from "../../studio/machineNickname";
import { useEnvironmentScope } from "../../state/session";
import { SettingsSection } from "./settingsLayout";
import { searchableSetting } from "./settingsSearch";
import { Badge } from "../ui/badge";
import { Button } from "../ui/button";
import { Tooltip, TooltipPopup, TooltipTrigger } from "../ui/tooltip";
import { GrantSignInPicker } from "./GrantSignInPicker";
import { Switch } from "../ui/switch";
import {
  Select,
  SelectGroup,
  SelectGroupLabel,
  SelectItem,
  SelectPopup,
  SelectTrigger,
  SelectValue,
} from "../ui/select";

export {
  workGrantAccountsSummary,
  workGrantProjectsSummary,
  workGrantStatus,
} from "./machineWorkGrants.logic";

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

/** Above this many choices the list gets a filter box. */
const FILTER_FROM = 9;

function CheckList<Id extends string>({
  label,
  items,
  selected,
  disabled,
  onChange,
  empty,
  nothingChosen,
}: {
  label: string;
  /** What shows when there is nothing to choose. */
  empty?: string;
  /** What shows under the list while nothing is ticked. */
  nothingChosen?: string;
  /**
   * An item with `unavailable` is kept only while chosen: it can be cleared, never chosen.
   * `note` is said beside an item that can still be chosen ("not signed in").
   */
  items: ReadonlyArray<{
    readonly id: Id;
    readonly title: string;
    readonly unavailable?: string;
    readonly note?: string | undefined;
    readonly icon?: ReactNode;
  }>;
  selected: ReadonlyArray<Id>;
  disabled: boolean;
  onChange: (next: ReadonlyArray<Id>) => void;
}) {
  const tx = useTx();
  const [filter, setFilter] = useState("");
  if (items.length === 0)
    return (
      <p className="text-xs text-muted-foreground">
        {empty ?? tx("Nothing to choose on this machine yet.")}
      </p>
    );
  const needle = filter.trim().toLowerCase();
  // A chosen item stays visible under any filter, so it can always be cleared.
  const shown = needle
    ? items.filter(
        (item) => selected.includes(item.id) || item.title.toLowerCase().includes(needle),
      )
    : items;
  return (
    <div className="flex min-w-0 flex-col gap-1.5">
      {items.length >= FILTER_FROM ? (
        <input
          type="search"
          value={filter}
          onChange={(event) => setFilter(event.target.value)}
          placeholder={tx("Filter")}
          aria-label={tx("Filter: {label}", { label })}
          className="w-40 max-w-full rounded-md border border-input bg-background px-2 py-1 text-xs"
        />
      ) : null}
      <fieldset className="flex min-w-0 flex-wrap gap-1.5" aria-label={label}>
        {shown.map((item) => {
          const checked = selected.includes(item.id);
          const locked = disabled || (item.unavailable !== undefined && !checked);
          return (
            <label
              key={item.id}
              data-slot="grant-choice"
              className={`flex min-w-0 max-w-full items-center gap-1.5 rounded-md border px-2 py-1 text-xs transition-colors has-[:focus-visible]:ring-2 has-[:focus-visible]:ring-ring ${
                checked ? "border-primary bg-accent/40" : "border-border"
              } ${locked ? "opacity-60" : "cursor-pointer hover:bg-accent/40"} ${
                item.unavailable || item.note ? "text-muted-foreground" : ""
              }`}
            >
              <input
                type="checkbox"
                className="shrink-0"
                checked={checked}
                disabled={locked}
                onChange={(event) =>
                  onChange(
                    event.target.checked
                      ? [...selected, item.id]
                      : selected.filter((id) => id !== item.id),
                  )
                }
              />
              {item.icon}
              <span className="truncate">{item.title}</span>
              {item.unavailable ? <span className="shrink-0">({item.unavailable})</span> : null}
              {item.note ? <span className="shrink-0">· {item.note}</span> : null}
            </label>
          );
        })}
        {shown.length === 0 ? (
          <p className="text-xs text-muted-foreground">{tx("Nothing matches.")}</p>
        ) : null}
      </fieldset>
      {nothingChosen && selected.length === 0 ? (
        <p className="text-xs text-warning-foreground">{nothingChosen}</p>
      ) : null}
    </div>
  );
}

/**
 * The path a launch from this machine may take, drawn as it runs: the sender,
 * this machine, and whether it may go one machine further. It sits in a
 * tooltip on the route icon beside the machine's name.
 */
function HopPath({ grant }: { grant: StudioWorkGrant }) {
  const tx = useTx();
  const path = workGrantHopPath(grant, tx);
  return (
    <Tooltip>
      <TooltipTrigger
        render={
          <button
            type="button"
            className="inline-flex shrink-0 items-center text-muted-foreground hover:text-foreground"
            aria-label={path.text}
            data-slot="grant-hop-path"
          />
        }
      >
        <RouteIcon aria-hidden className="size-3.5" />
      </TooltipTrigger>
      <TooltipPopup side="top">
        <span className="flex flex-col gap-1">
          <span className="flex flex-wrap items-center gap-1" aria-hidden>
            {path.stops.map((stop, index) => (
              <span key={stop.label} className="flex items-center gap-1">
                {index > 0 ? <ArrowRightIcon className="size-3 shrink-0" /> : null}
                <span className={stop.kind === "blocked" ? "line-through opacity-70" : ""}>
                  {stop.label}
                </span>
              </span>
            ))}
          </span>
          <span>{path.text}</span>
        </span>
      </TooltipPopup>
    </Tooltip>
  );
}

/** A short label with its longer explanation in a tooltip. */
function Hint({ label, hint }: { label: string; hint: string }) {
  return (
    <Tooltip>
      <TooltipTrigger
        render={
          <span className="inline-flex min-w-0 cursor-help items-center gap-1 text-muted-foreground" />
        }
      >
        <span className="truncate">{label}</span>
        <InfoIcon aria-hidden className="size-3 shrink-0" />
      </TooltipTrigger>
      <TooltipPopup side="top">{hint}</TooltipPopup>
    </Tooltip>
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

/**
 * One machine that may start work here: its name, one summary line
 * ("All projects, All sign-ins, up to Full access, renews automatically"),
 * Revoke, and the limits folded under Limits.
 */
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
  const tx = useTx();
  const coordinatorEnvironmentId = grant.coordinatorEnvironmentId;
  const machine = grant.machineLabel;
  const revoked = grant.status === "revoked";
  const busy = pending || !canManage || revoked;
  const update = (input: Omit<StudioWorkGrantUpdateInput, "coordinatorEnvironmentId">) =>
    onChange({ action: "update", input: { coordinatorEnvironmentId, ...input } });
  // Only ids the snapshot lists: one it no longer lists (a deleted project, the assistant)
  // has no row to clear, so the next change drops it instead of carrying it forever.
  // When the machine could not read its projects, every id is kept.
  const listedProjects =
    grant.projects.kind === "listed"
      ? grant.projects.projectIds.filter(
          (id) =>
            snapshot.projectsUnreadable === true ||
            snapshot.projects.some((project) => project.id === id),
        )
      : [];
  const noProject = workGrantAllowsNoProject(grant, snapshot);
  const access = workGrantAccessName(grant, tx);
  return (
    <li
      className="flex min-w-0 flex-col gap-1.5 px-3 py-2.5 sm:px-4"
      aria-label={tx("Work from {machine}", { machine })}
    >
      <div className="flex min-w-0 items-start gap-3">
        <div className="min-w-0 flex-1">
          <h3 className="flex min-w-0 items-center gap-1.5 text-sm">
            <span className="truncate">{machine}</span>
            {grant.kind === "own" ? null : (
              <span className="shrink-0 rounded-full border border-border px-1.5 text-2xs text-muted-foreground">
                {tx("Shared")}
              </span>
            )}
            <HopPath grant={grant} />
          </h3>
          <p
            className={`text-xs ${revoked ? "text-warning-foreground" : "text-muted-foreground"}`}
            data-slot="grant-summary"
          >
            {workGrantSummary(grant, snapshot, tx)}
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
            {tx("Allow again")}
          </Button>
        ) : (
          <Tooltip>
            <TooltipTrigger
              render={
                <Button
                  className="shrink-0"
                  size="xs"
                  variant="destructive-outline"
                  disabled={pending || !canManage}
                  onClick={() =>
                    onChange({ action: "revoke", input: { coordinatorEnvironmentId } })
                  }
                />
              }
            >
              {tx("Revoke")}
            </TooltipTrigger>
            <TooltipPopup side="top">
              {tx(
                "Refuses new work at once. Threads it started here stop in 2 minutes; their worktrees and changes stay.",
              )}
            </TooltipPopup>
          </Tooltip>
        )}
      </div>
      {noProject ? (
        <div className="flex min-w-0 flex-wrap items-center gap-2" data-slot="grant-no-projects">
          <Badge size="sm" variant="warning">
            {tx("No projects allowed")}
          </Badge>
          <Button
            size="xs"
            variant="outline"
            disabled={busy}
            onClick={() => update({ projects: { kind: "all" } })}
          >
            {tx("Allow all projects")}
          </Button>
        </div>
      ) : null}
      {grant.legacy ? (
        <p className="text-xs text-muted-foreground">
          {tx(
            "Allowed before work could be limited, so it may use every project and sign-in here until you change it.",
          )}
        </p>
      ) : null}
      <details className="group text-xs" data-slot="limits">
        <summary className="flex w-fit cursor-pointer list-none items-center gap-1 rounded text-muted-foreground hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring [&::-webkit-details-marker]:hidden">
          <ChevronRightIcon
            aria-hidden
            className="size-3 transition-transform group-open:rotate-90"
          />
          {tx("Limits")}
        </summary>
        <dl className="mt-2 grid min-w-0 grid-cols-[max-content_minmax(0,1fr)] items-center gap-x-3 gap-y-2">
          {grant.kind === "own" ? null : (
            <>
              <dt className="text-muted-foreground">{tx("Who is it for")}</dt>
              <dd className="min-w-0">
                <ChoiceSelect
                  label={tx("Whose machine {machine} is", { machine })}
                  heading={tx("Whose machine is it")}
                  value={grant.owner}
                  choices={(["self", "other"] as const).map((value) => ({
                    value,
                    label: tx(OWNER_LABELS[value]),
                  }))}
                  disabled={busy}
                  onChange={(owner) => update({ owner })}
                />
              </dd>
            </>
          )}
          <dt className="self-start pt-0.5 text-muted-foreground">{tx("Projects")}</dt>
          <dd className="flex min-w-0 flex-col gap-1.5">
            <div className="flex min-w-0 flex-wrap items-center gap-2">
              <ChoiceSelect<StudioWorkGrantProjects["kind"]>
                label={tx("Projects {machine} may use", { machine })}
                heading={tx("Projects it may run work in")}
                value={grant.projects.kind}
                choices={[
                  { value: "all", label: tx("All projects") },
                  { value: "listed", label: tx("Chosen projects") },
                  { value: "linked", label: tx("Linked to it") },
                ]}
                disabled={busy}
                onChange={(kind) =>
                  update({
                    projects: kind === "listed" ? { kind, projectIds: listedProjects } : { kind },
                  })
                }
              />
              {grant.projects.kind === "listed" ? null : (
                <span className="min-w-0 truncate text-muted-foreground">
                  {workGrantProjectsSummary(
                    grant,
                    snapshot.projects,
                    snapshot.projectsUnreadable === true,
                    tx,
                  )}
                </span>
              )}
            </div>
            {grant.projects.kind === "listed" ? (
              <CheckList<ProjectId>
                label={tx("Projects {machine} may use", { machine })}
                empty={
                  snapshot.projectsUnreadable === true
                    ? tx("Could not read this machine's projects. The grant keeps its choices.")
                    : tx(
                        "This machine has no projects yet. Add a project folder here, or hand a project off to it, then tick it.",
                      )
                }
                nothingChosen={tx("Nothing allowed yet: tick a project or pick All projects")}
                items={snapshot.projects.flatMap((project) =>
                  project.unavailable === undefined
                    ? [{ id: project.id, title: project.title }]
                    : listedProjects.includes(project.id)
                      ? [
                          {
                            id: project.id,
                            title: project.title,
                            unavailable: workGrantUnavailableNote(project.unavailable, tx),
                          },
                        ]
                      : [],
                )}
                selected={listedProjects}
                disabled={busy}
                onChange={(projectIds) => update({ projects: { kind: "listed", projectIds } })}
              />
            ) : null}
          </dd>
          <dt className="text-muted-foreground">{tx("Sign-ins")}</dt>
          <dd className="min-w-0">
            <GrantSignInPicker
              machineLabel={machine}
              accounts={grant.accounts}
              available={snapshot.accounts}
              disabled={busy}
              onChange={(accounts) => update({ accounts })}
            />
          </dd>
          <dt className="text-muted-foreground">{tx("Routines")}</dt>
          <dd className="flex min-w-0 items-center gap-2">
            <Switch
              className="shrink-0"
              aria-label={tx("Let {machine} manage scheduled routines", { machine })}
              checked={grant.routines}
              disabled={busy}
              onCheckedChange={(checked) => update({ routines: Boolean(checked) })}
            />
            <Hint
              label={grant.routines ? tx("Can manage routines") : tx("Cannot manage routines")}
              hint={workGrantRoutinesNote(grant, tx)}
            />
          </dd>
          <dt className="text-muted-foreground">{tx("Access")}</dt>
          <dd className="min-w-0" data-slot="grant-access-limit">
            <Hint
              label={
                access ? tx("up to {access}", { access }) : tx("Set when it first starts work")
              }
              hint={workGrantAccessNote(grant, tx)}
            />
          </dd>
        </dl>
      </details>
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
  const tx = useTx();
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
          {loading ? tx("Checking…") : tx("Refresh")}
        </Button>
      }
    >
      {failed ? (
        <p role="status" className="px-3 py-2.5 text-sm text-muted-foreground sm:px-4">
          {tx("Could not read who can run work here. Refresh to retry.")}
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
            ? tx("Checking who can run work here…")
            : tx(
                "No other machine can start work here. To allow one, choose Allow on its card above, on the line that says its agents can start work on this machine.",
              )}
        </p>
      )}
      {snapshot?.grants.length && !canManage ? (
        <p className="border-t border-border/60 px-3 py-2 text-xs text-muted-foreground sm:px-4">
          {tx("Changing this needs Manage access on this machine.")}
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
 * "Who can run work here" in Settings > Machines: every coordinator
 * machine with a worker grant on this server's machine, what it may use, and
 * Revoke. This machine owns and enforces these grants; the page reads them
 * once for this section and its machine rows.
 */
export function MachineWorkGrants({
  environmentId,
  grants,
}: {
  environmentId: EnvironmentId;
  grants: ReturnType<typeof useMachineWorkGrants>;
}) {
  const { snapshot, loading, failed, refresh } = grants;
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
        `Revoke ${label}?\n${label} can no longer start work here. Threads it started here stop in 2 minutes; their worktrees and changes stay. To undo, choose Allow again here, then, on ${label}, choose Allow on this machine's card.`,
        { variant: "destructive" },
      );
      if (confirmed !== true) return;
    }
    setPending(next.input.coordinatorEnvironmentId);
    setError(null);
    setNotice(null);
    try {
      const changed = await changeMachineWorkGrant(environmentId, next);
      const grant = {
        ...changed,
        machineLabel:
          snapshot?.grants.find(
            (candidate) => candidate.coordinatorEnvironmentId === changed.coordinatorEnvironmentId,
          )?.machineLabel ?? workGrantMachineLabel(changed, (id) => machineNickname(id)),
      };
      if (next.action === "revoke")
        setNotice(
          grant.runningThreads > 0 && grant.interruptAt
            ? `${grant.machineLabel} can no longer start work here. Its ${grant.runningThreads} running thread${grant.runningThreads === 1 ? "" : "s"} stop at ${formatTime(grant.interruptAt)}.`
            : `${grant.machineLabel} can no longer start work here.`,
        );
      else if (next.action === "restore")
        setNotice(
          `${grant.machineLabel} may be allowed again. On ${grant.machineLabel}, open Settings > Machines and choose Allow on this machine's card.`,
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
