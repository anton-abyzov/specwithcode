import type {
  EnvironmentId,
  ProjectId,
  ServerProviderSkill,
  ThreadId,
} from "@specweave-studio/contracts";
import { Link } from "@tanstack/react-router";
import { RefreshCwIcon, SearchIcon, SparklesIcon, TriangleAlertIcon } from "lucide-react";
import { memo, useMemo, useRef, useState } from "react";

import type { ProviderInstanceEntry } from "../../providerInstances";
import type { TimelineEntry } from "../../session-logic";
import { useEnvironmentQuery } from "../../state/query";
import { serverEnvironment } from "../../state/server";
import { useAtomCommand } from "../../state/use-atom-command";
import { projectWorkspace } from "../../studio/projectWorkspace";
import { cn } from "~/lib/utils";
import { Badge } from "../ui/badge";
import { Button } from "../ui/button";
import { Input } from "../ui/input";
import { Popover, PopoverPopup, PopoverTrigger } from "../ui/popover";
import { Spinner } from "../ui/spinner";
import { composerFloatingLayerProps } from "./composerEventScope";
import {
  buildComposerSkillGroups,
  collectSessionSkillUses,
  COMPOSER_SKILLS_SEARCH_THRESHOLD,
  composerSkillsDiscoveryError,
  composerSkillsFailureReason,
  composerSkillsHeading,
  composerSkillsRescanPlan,
  composerSkillsVersionsNote,
  countSessionSkillsUsed,
  type ComposerSkillItem,
  type SessionSkillUse,
  sessionSkillUsesKey,
} from "./ComposerSkillsPopover.logic";

/** Skills a thread's loaded timeline used, kept equal between renders when nothing new was used. */
export function useSessionSkillUses(
  entries: ReadonlyArray<TimelineEntry>,
): ReadonlyArray<SessionSkillUse> {
  const uses = useMemo(() => collectSessionSkillUses(entries), [entries]);
  const last = useRef<{ key: string; uses: ReadonlyArray<SessionSkillUse> } | null>(null);
  const key = sessionSkillUsesKey(uses);
  if (last.current?.key !== key) last.current = { key, uses };
  return last.current.uses;
}

const EMPTY_USES: ReadonlyArray<SessionSkillUse> = [];

export interface ComposerSkillsPopoverProps {
  readonly environmentId: EnvironmentId;
  readonly projectId: ProjectId | null;
  /** The thread's folder: its worktree, else the project root. */
  readonly cwd: string | null;
  /** The server thread `cwd` belongs to, so the server checks only that thread. */
  readonly threadId?: ThreadId | null | undefined;
  readonly provider: ProviderInstanceEntry | undefined;
  readonly machineLabel: string;
  readonly skills: ReadonlyArray<ServerProviderSkill>;
  readonly uses?: ReadonlyArray<SessionSkillUse> | undefined;
}

export const ComposerSkillsPopover = memo(function ComposerSkillsPopover(
  props: ComposerSkillsPopoverProps,
) {
  const [open, setOpen] = useState(false);
  const count = props.skills.filter((skill) => skill.enabled).length;
  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger
        render={
          <Button
            type="button"
            size="xs"
            variant="ghost-muted"
            className="shrink-0"
            data-testid="composer-skills-trigger"
            aria-label={`Skills: ${count} available`}
          >
            <SparklesIcon aria-hidden="true" />
            <span className="hidden sm:inline">Skills</span>
            <span className="tabular-nums">{count}</span>
          </Button>
        }
      />
      <PopoverPopup
        {...composerFloatingLayerProps}
        side="top"
        align="end"
        padding="none"
        width="md"
        className="text-left whitespace-normal"
      >
        {open ? <ComposerSkillsPanel {...props} /> : null}
      </PopoverPopup>
    </Popover>
  );
});

function ComposerSkillsPanel(props: ComposerSkillsPopoverProps) {
  const [rescan, setRescan] = useState(false);
  const [search, setSearch] = useState("");
  const query = useEnvironmentQuery(
    props.projectId
      ? projectWorkspace.skills({
          environmentId: props.environmentId,
          input: {
            projectId: props.projectId,
            ...(props.cwd ? { cwd: props.cwd } : {}),
            ...(props.cwd && props.threadId ? { threadId: props.threadId } : {}),
            ...(rescan ? { refresh: true } : {}),
          },
        })
      : null,
  );
  // The first Rescan switches the query key; keep the last answer while it scans.
  const lastSnapshot = useRef(query.data);
  if (query.data) lastSnapshot.current = query.data;
  const snapshot = query.data ?? lastSnapshot.current;
  const refreshProviders = useAtomCommand(serverEnvironment.refreshProviders, {
    reportFailure: false,
  });
  const [refreshing, setRefreshing] = useState(false);
  // A repeat Rescan revalidates a key that already has data, which the query
  // may not report as pending; stay busy until an answer newer than the click.
  const [awaitingSince, setAwaitingSince] = useState<number | null>(null);
  const awaitingServer =
    awaitingSince !== null && query.error === null && query.dataUpdatedAt < awaitingSince;
  const failureReason = composerSkillsFailureReason(query.failure);

  const instanceId = props.provider?.instanceId ?? null;
  const agent = props.provider?.displayName ?? "Agent";
  const uses = props.uses ?? EMPTY_USES;
  const groups = useMemo(
    () =>
      buildComposerSkillGroups({
        skills: props.skills,
        instanceId,
        snapshot: snapshot ?? null,
        uses,
        query: search,
      }),
    [instanceId, props.skills, search, snapshot, uses],
  );
  const discoveryError = composerSkillsDiscoveryError({
    providerStatus: props.provider?.snapshot.status ?? null,
    providerMessage: props.provider?.snapshot.message ?? null,
    instanceId,
    snapshot: snapshot ?? null,
  });
  const busy = query.isPending || refreshing || awaitingServer;
  const plan = composerSkillsRescanPlan({
    projectId: props.projectId,
    failureReason,
    hasSnapshot: snapshot != null,
    instanceId,
    cwd: props.cwd,
  });
  const onRescan = () => {
    if (plan.server) {
      // The server's Rescan asks every agent for a fresh folder scan, which
      // also refreshes the composer's own list.
      if (rescan) {
        setAwaitingSince(Date.now());
        query.refresh();
      } else setRescan(true);
    } else if (props.projectId) {
      // The folder may be recorded by now; asking again is one thread lookup.
      query.refresh();
    }
    if (plan.providers && instanceId && props.cwd) {
      setRefreshing(true);
      void refreshProviders({
        environmentId: props.environmentId,
        input: { instanceId, cwd: props.cwd, fresh: true },
      }).finally(() => setRefreshing(false));
    }
  };
  const usedCount = countSessionSkillsUsed(props.skills, uses);
  const heading = composerSkillsHeading({
    agent,
    machine: props.machineLabel.trim() || null,
    cwd: props.cwd,
  });
  const showSearch = props.skills.length > COMPOSER_SKILLS_SEARCH_THRESHOLD;
  const empty = groups.length === 0;

  return (
    <div className="flex max-h-[min(28rem,70vh)] flex-col" data-testid="composer-skills-popover">
      <div className="flex flex-col gap-0.5 border-b px-3 pt-2.5 pb-2">
        <div className="truncate font-medium text-xs">{heading}</div>
        <div className="text-2xs text-muted-foreground tabular-nums">
          {props.skills.length} skill{props.skills.length === 1 ? "" : "s"}
          {usedCount > 0 ? ` · ${usedCount} used` : ""}
        </div>
      </div>
      {showSearch ? (
        <div className="relative border-b px-2 py-1.5">
          <SearchIcon className="pointer-events-none absolute top-1/2 left-4 z-10 size-3.5 -translate-y-1/2 text-muted-foreground" />
          <Input
            size="sm"
            value={search}
            onChange={(event) => setSearch(event.currentTarget.value)}
            placeholder="Search skills"
            aria-label="Search skills"
            className="w-full"
            style={{ paddingLeft: "1.75rem" }}
          />
        </div>
      ) : null}
      {discoveryError ? (
        <div
          role="alert"
          className="flex items-start gap-1.5 border-b bg-destructive/6 px-3 py-2 text-2xs text-destructive-foreground"
        >
          <TriangleAlertIcon className="mt-px size-3.5 shrink-0" aria-hidden="true" />
          <span className="min-w-0 text-pretty">
            {props.skills.length === 0
              ? `Skills could not be listed. ${discoveryError}`
              : `The list may be out of date. ${discoveryError}`}
          </span>
        </div>
      ) : null}
      <div className="min-h-0 flex-1 overflow-y-auto py-1">
        {empty && !(discoveryError && props.skills.length === 0) ? (
          <p className="px-3 py-3 text-xs text-muted-foreground">
            {search.trim() ? "No skills match." : `${agent} lists no skills in this folder.`}
          </p>
        ) : null}
        {groups.map((group) => (
          <section key={group.id} aria-label={group.label} className="py-1">
            <h3 className="px-3 pb-0.5 font-medium text-2xs text-muted-foreground uppercase tracking-wide">
              {group.label}
              <span className="ms-1 tabular-nums">{group.items.length}</span>
            </h3>
            <ul>
              {group.items.map((item) => (
                <ComposerSkillRow key={`${group.id}:${item.name}:${item.path ?? ""}`} item={item} />
              ))}
            </ul>
          </section>
        ))}
      </div>
      {query.error && !snapshot ? (
        <div className="border-t px-3 py-1.5 text-2xs text-muted-foreground">
          {composerSkillsVersionsNote({ reason: failureReason, error: query.error })}
        </div>
      ) : null}
      <div className="flex items-center justify-between gap-2 border-t px-2 py-1.5">
        <Button
          type="button"
          size="xs"
          variant="ghost"
          disabled={busy || (!plan.server && !plan.providers)}
          onClick={onRescan}
        >
          {busy ? <Spinner className="size-3.5" /> : <RefreshCwIcon aria-hidden="true" />}
          Rescan
        </Button>
        <Link
          to="/settings/skills"
          className="rounded-sm px-1.5 text-xs text-muted-foreground underline-offset-2 hover:text-foreground hover:underline"
        >
          Open Skills settings
        </Link>
      </div>
    </div>
  );
}

function ComposerSkillRow({ item }: { item: ComposerSkillItem }) {
  const versionText = item.version
    ? item.version.value
      ? `v${item.version.value.replace(/^v/i, "")}`
      : "untracked"
    : "";
  return (
    <li
      className="flex min-w-0 items-center gap-2 px-3 py-1 text-xs"
      data-skill-name={item.name}
      data-skill-enabled={item.enabled ? "true" : "false"}
    >
      {/* Only the name greys out, so the Manage link keeps full contrast. */}
      <span
        className={cn("min-w-0 flex-1 truncate", !item.enabled && "opacity-50")}
        data-testid="composer-skill-label"
      >
        <span className={cn("font-medium", !item.enabled && "line-through decoration-1")}>
          {item.displayName}
        </span>
        {item.version ? (
          <span
            className={cn(
              "ms-1.5 text-2xs tabular-nums text-muted-foreground",
              !item.version.value && "italic",
            )}
            data-version-source={item.version.source ?? "none"}
          >
            {versionText}
            {item.version.note ? ` · ${item.version.note}` : null}
          </span>
        ) : null}
      </span>
      {!item.enabled ? (
        <>
          <span className="shrink-0 text-2xs text-muted-foreground">off</span>
          <Link
            to="/settings/skills"
            search={{ skill: item.name }}
            className="shrink-0 rounded-sm text-2xs text-muted-foreground underline underline-offset-2 outline-none hover:text-foreground focus-visible:text-foreground focus-visible:ring-2 focus-visible:ring-ring"
            aria-label={`Manage ${item.displayName} in Skills settings`}
            data-testid="composer-skill-manage"
          >
            Manage
          </Link>
        </>
      ) : null}
      <Badge variant={item.missing ? "warning" : "outline"} className="shrink-0">
        {item.levelLabel}
      </Badge>
    </li>
  );
}
