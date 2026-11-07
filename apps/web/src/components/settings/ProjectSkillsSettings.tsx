import { renderRich } from "../../i18n/rich";
import { useTx } from "../../i18n";
import {
  EnvironmentId,
  ThreadId,
  summarizeProjectSkills,
  type ProjectId,
  type ProjectSkillPresence,
  type ProjectSkillRow,
  type ProjectSkillsSnapshot,
} from "@specweave-studio/contracts";
import { useNavigate, useSearch } from "@tanstack/react-router";
import {
  BadgeCheckIcon,
  ExternalLinkIcon,
  PinIcon,
  RefreshCwIcon,
  SearchIcon,
  XIcon,
} from "lucide-react";
import { type ReactNode, useCallback, useEffect, useMemo, useRef, useState } from "react";

import { SkillDetailPanel } from "../skills/SkillDetailPanel";
import { groupSkillPresences } from "../skills/SkillDetail.logic";
import {
  skillAuthoringSeedFromMarkdown,
  type SkillAuthoringSeed,
} from "../skills/skillAuthoringSeed";
import { SkillAuthoringSheet } from "../skills/SkillAuthoringSheet";
import { cn } from "~/lib/utils";
import type { ProviderInstanceEntry } from "../../providerInstances";
import { useEnvironment, useEnvironments, usePrimaryEnvironmentId } from "../../state/environments";
import { useEnvironmentQuery } from "../../state/query";
import { useMachineNickname } from "../../studio/machineNickname";
import { projectWorkspace } from "../../studio/projectWorkspace";
import { ProviderInstanceIcon } from "../chat/ProviderInstanceIcon";
import { useProviderEntries } from "../studio/shell/ModelBadge";
import { Badge } from "../ui/badge";
import { Button } from "../ui/button";
import { Input } from "../ui/input";
import { Sheet, SheetDescription, SheetHeader, SheetPopup, SheetTitle } from "../ui/sheet";
import { Spinner } from "../ui/spinner";
import { Switch } from "../ui/switch";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "../ui/table";
import { Toggle, ToggleGroup } from "../ui/toggle-group";
import { Tooltip, TooltipPopup, TooltipTrigger } from "../ui/tooltip";
import { ProjectSkillAgentToggle, ProjectSkillPluginToggle } from "./ProjectSkillAgentToggles";
import { SkillControlsProvider, type SkillMemberProject } from "./ProjectSkillControls";
import { ProjectSkillSheetFooter } from "./ProjectSkillFleetPush";
import {
  ProjectSkillLinkButtons,
  ProjectSkillRowMenu,
  type SkillSheetFocus,
} from "./ProjectSkillRowMenu";
import { ProjectSkillVersionSection } from "./ProjectSkillVersionSection";
import {
  filterProjectSkillRows,
  projectSkillAttentionCount,
  projectSkillFacets,
  projectSkillLevel,
  projectSkillLevelLabel,
  projectSkillLevels,
  projectSkillProviderBadges,
  projectSkillSourceLinks,
  projectSkillStatusBadge,
  projectSkillVersions,
  pickSkillsMember,
  type ProjectSkillFacetOption,
} from "./ProjectSkillsSettings.logic";
import { useSettingsScope } from "./SettingsScopeContext";
import { SettingsScopeNotice } from "./SettingsScopeNotice";
import { SettingsPageContainer, SettingsSection } from "./settingsLayout";
import { searchableSetting } from "./settingsSearch";
import { useSettingsProjectGroups } from "./useSettingsProjectGroups";

/**
 * `/settings/skills`: which skills each agent loads in the selected project's
 * folder, or with no project picked, every agent's user-level skills on the
 * machine, switchable without touching any other agent.
 */
export function ProjectSkillsSettings() {
  const tx = useTx();
  const { search: value, scope } = useSettingsScope();
  const groups = useSettingsProjectGroups();
  const primaryEnvironmentId = usePrimaryEnvironmentId();
  const { presentationById } = useEnvironments();
  const projectScope = scope.kind === "project" || scope.kind === "checkout";
  const machine = value.machine ? EnvironmentId.make(value.machine) : null;
  const group = projectScope
    ? (groups.find((candidate) => candidate.projectKey === value.project) ?? null)
    : null;
  const member = pickSkillsMember(group?.memberProjects ?? [], {
    machine,
    checkout: value.checkout,
    primaryEnvironmentId,
    isConnected: (environmentId) =>
      presentationById.get(EnvironmentId.make(environmentId))?.connection.phase === "connected",
  });

  if (!projectScope) {
    // The machine view rides on any project of that machine; it scans the home folder, not the project.
    const machineId = machine ?? primaryEnvironmentId;
    const anchor =
      machineId === null
        ? null
        : (groups
            .flatMap((candidate) => candidate.memberProjects)
            .find((candidate) => candidate.environmentId === machineId) ?? null);
    if (scope.kind !== "unavailable" && anchor !== null)
      return (
        <div className="flex min-h-0 flex-1 flex-col">
          <SettingsPageContainer width="wide">
            <ProjectSkillsView
              key={`${anchor.environmentId}:user-level`}
              environmentId={anchor.environmentId}
              projectId={anchor.id}
              folder="~"
              userLevel
            />
          </SettingsPageContainer>
        </div>
      );
    return (
      <div className="flex min-h-0 flex-1 flex-col">
        {scope.kind === "unavailable" ? (
          <SettingsPageContainer>
            <p className="text-sm text-muted-foreground">{scope.message}</p>
          </SettingsPageContainer>
        ) : (
          <SettingsScopeNotice target="project">
            {tx("Choose a project to see which skills each agent loads in its folder.")}
          </SettingsScopeNotice>
        )}
      </div>
    );
  }
  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <SettingsPageContainer width="wide">
        {member ? (
          <ProjectSkillsView
            key={`${member.environmentId}:${member.id}`}
            environmentId={member.environmentId}
            projectId={member.id}
            folder={member.workspaceRoot}
            memberProjects={group?.memberProjects ?? []}
          />
        ) : (
          <p className="text-sm text-muted-foreground">
            {tx("This project is no longer available.")}
          </p>
        )}
      </SettingsPageContainer>
    </div>
  );
}

/** Text with a hover hint; the hint lists what does not fit in the cell. */
function Hinted({
  hint,
  className,
  children,
}: {
  hint: string;
  className?: string;
  children: ReactNode;
}) {
  return (
    <Tooltip>
      <TooltipTrigger render={<span tabIndex={0} className={className} />}>
        {children}
      </TooltipTrigger>
      <TooltipPopup side="top" className="max-w-96 whitespace-pre-line break-all">
        {hint}
      </TooltipPopup>
    </Tooltip>
  );
}

function ExternalLink({
  href,
  label,
  className,
  children,
}: {
  href: string;
  label: string;
  className?: string;
  children: ReactNode;
}) {
  return (
    <a
      href={href}
      target="_blank"
      rel="noreferrer noopener"
      aria-label={label}
      className={cn(
        "inline-flex min-w-0 items-center gap-1 rounded-sm underline-offset-2 hover:text-foreground hover:underline focus-visible:text-foreground focus-visible:underline focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring",
        className,
      )}
      onClick={(event) => event.stopPropagation()}
    >
      {children}
    </a>
  );
}

function TierCell({ row }: { row: ProjectSkillRow }) {
  const tier = row.lock?.tier;
  if (!tier) return <span className="text-muted-foreground">—</span>;
  const registryUrl = projectSkillSourceLinks(row)?.registryUrl ?? null;
  const verified = tier.toUpperCase() === "VERIFIED";
  const badge = (
    <Badge size="sm" variant={verified ? "success" : "outline"}>
      {verified ? <BadgeCheckIcon aria-hidden /> : null}
      {tier}
    </Badge>
  );
  return registryUrl ? (
    <ExternalLink href={registryUrl} label={`Open ${row.name} on verified-skill.com`}>
      {badge}
    </ExternalLink>
  ) : (
    badge
  );
}

function SourceCell({ row }: { row: ProjectSkillRow }) {
  const source = row.lock?.source;
  if (!source) return <span className="text-muted-foreground">—</span>;
  const links = projectSkillSourceLinks(row);
  if (!links?.repoUrl) {
    return (
      <Hinted hint={source} className="block truncate text-muted-foreground">
        {source}
      </Hinted>
    );
  }
  return (
    <div className="flex min-w-0 flex-col items-start gap-0.5">
      <ExternalLink
        href={links.repoUrl}
        label={`Open the source of ${row.name}: ${links.repoUrl}`}
        className="max-w-full text-muted-foreground"
      >
        <span className="truncate">{links.label}</span>
        <ExternalLinkIcon aria-hidden className="size-3 shrink-0" />
      </ExternalLink>
      {links.registryUrl ? (
        <ExternalLink
          href={links.registryUrl}
          label={`Open ${row.name} on verified-skill.com: ${links.registryUrl}`}
          className="max-w-full text-2xs text-muted-foreground"
        >
          <BadgeCheckIcon aria-hidden className="size-3 shrink-0 text-success-foreground" />
          <span className="truncate">verified-skill.com</span>
        </ExternalLink>
      ) : null}
    </div>
  );
}

type ProviderEntries = ReadonlyMap<string, ProviderInstanceEntry>;

/** The provider's own mark, the same one the model picker and thread headers draw. */
function SkillProviderMark({
  presence,
  entries,
  dimmed = false,
}: {
  presence: ProjectSkillPresence;
  entries: ProviderEntries;
  dimmed?: boolean;
}) {
  const entry = entries.get(presence.instanceId) ?? null;
  return (
    <ProviderInstanceIcon
      driverKind={entry?.driverKind ?? presence.driver}
      displayName={presence.label}
      acpRegistryAgentId={entry?.acpRegistryAgentId}
      acpRegistryIconUrl={entry?.acpRegistryIconUrl}
      className="z-auto"
      iconClassName={cn("size-3.5", dimmed ? "opacity-50" : "opacity-100")}
    />
  );
}

function StatusBadge({ row }: { row: ProjectSkillRow }) {
  const status = projectSkillStatusBadge(row);
  const badge = (
    <Badge size="sm" variant={status.variant}>
      {status.label}
    </Badge>
  );
  return row.issues.length > 0 ? <Hinted hint={row.issues.join("\n")}>{badge}</Hinted> : badge;
}

/**
 * The lock's version beside the versions the copies on disk report (the
 * plugin manifest for a plugin skill), with a hint when they disagree. Either
 * side can be stale: a registry version published without bumping the file's
 * `version:` leaves the lock ahead of the file.
 */
function VersionCell({ row, update }: { row: ProjectSkillRow; update?: string | null }) {
  const tx = useTx();
  const versions = projectSkillVersions(row);
  const pinned = row.lock?.pinnedVersion ?? null;
  const files = versions.files.map((file) => file.version);
  const lockOnly = versions.lock !== null && !versions.lockOutOfDate;
  if (versions.lock === null && files.length === 0) {
    return <span className="text-muted-foreground">—</span>;
  }
  const hint = [
    versions.lock ? `Lock: ${versions.lock}` : "Not in a vskill lock",
    ...versions.files.map((file) => `${file.labels.join(", ")}: ${file.version}`),
    ...(versions.lockOutOfDate ? ["The lock and the files on disk name different versions."] : []),
  ].join("\n");
  return (
    <Hinted hint={hint} className="block">
      <span className="font-mono">
        {lockOnly ? versions.lock : files.join(" / ") || versions.lock}
      </span>
      {versions.lockOutOfDate ? (
        <div className="text-xs text-warning-foreground">
          {renderRich(tx("lock says {lock}"), { lock: versions.lock })}
        </div>
      ) : null}
      {pinned || update ? (
        <span className="mt-0.5 flex flex-wrap gap-1">
          {pinned ? (
            <Badge size="sm" variant="outline" data-testid="version-pinned">
              <PinIcon aria-hidden />
              {tx("pinned")}
            </Badge>
          ) : null}
          {update ? (
            <Badge size="sm" variant="info" data-testid="version-update">
              ↑{update}
            </Badge>
          ) : null}
        </span>
      ) : null}
    </Hinted>
  );
}

function SkillRow({
  row,
  entries,
  update,
  onOpen,
}: {
  row: ProjectSkillRow;
  entries: ProviderEntries;
  update: string | null;
  onOpen: (name: string, focus?: SkillSheetFocus) => void;
}) {
  const tx = useTx();
  const issue = row.issues[0];
  return (
    <TableRow
      data-skill={row.name}
      data-status={row.status}
      className="cursor-pointer"
      onClick={(event) => {
        // React bubbles clicks out of portals: a row menu item would reopen the sheet unfocused.
        if (!event.currentTarget.contains(event.target as Node)) return;
        if ((event.target as HTMLElement).closest("a,button,[role=switch]")) return;
        onOpen(row.name);
      }}
    >
      <TableCell className="max-w-64 whitespace-normal">
        <button
          type="button"
          className="block max-w-full truncate text-left font-medium text-foreground hover:underline focus-visible:underline focus-visible:outline-none"
          aria-label={`Show details for ${row.name}`}
          onClick={() => onOpen(row.name)}
        >
          {row.name}
        </button>
        {row.attention && issue ? (
          <div className="line-clamp-2 text-muted-foreground">{issue}</div>
        ) : row.description ? (
          <div className="truncate text-muted-foreground">{row.description}</div>
        ) : null}
      </TableCell>
      <TableCell>
        {row.providers.length === 0 ? (
          <span className="text-muted-foreground">{tx("None")}</span>
        ) : (
          <div className="flex flex-wrap gap-1">
            {projectSkillProviderBadges(row).map((badge) => (
              <Hinted key={badge.key} hint={badge.title}>
                <Badge size="sm" variant={badge.enabled ? "outline" : "secondary"}>
                  <SkillProviderMark
                    presence={badge.presence}
                    entries={entries}
                    dimmed={!badge.enabled}
                  />
                  {badge.enabled ? badge.label : `${badge.label} (off)`}
                  {badge.enabled && badge.agentOnly ? (
                    <span className="text-muted-foreground">{tx("agent only")}</span>
                  ) : null}
                </Badge>
              </Hinted>
            ))}
          </div>
        )}
      </TableCell>
      <TableCell>
        <span className="text-muted-foreground">
          {projectSkillLevels(row).map(projectSkillLevelLabel).join(", ") || "—"}
        </span>
      </TableCell>
      <TableCell>
        <VersionCell row={row} update={update} />
      </TableCell>
      <TableCell>
        <TierCell row={row} />
      </TableCell>
      <TableCell className="max-w-56">
        <SourceCell row={row} />
      </TableCell>
      <TableCell>
        <StatusBadge row={row} />
      </TableCell>
      <TableCell className="w-8 text-right">
        <ProjectSkillRowMenu row={row} onOpen={onOpen} />
      </TableCell>
    </TableRow>
  );
}

function DetailItem({ term, children }: { term: string; children: ReactNode }) {
  return (
    <div className="grid grid-cols-[7.5rem_minmax(0,1fr)] gap-2 py-1">
      <dt className="text-muted-foreground">{term}</dt>
      <dd className="min-w-0 break-all text-foreground">{children}</dd>
    </div>
  );
}

const DRIFT_LABELS: Readonly<Record<ProjectSkillRow["drift"], string>> = {
  match: "Matches the locked version",
  drift: "Changed since vskill installed it",
  unknown: "Cannot compare with the lock",
  unlocked: "Not installed by vskill",
};

/** Everything known about one skill: where each agent loads it from, its lock and its problems. */
function SkillDetails({ row, entries }: { row: ProjectSkillRow; entries: ProviderEntries }) {
  const tx = useTx();
  const problems = [...new Set([...row.issues, ...row.doctor])];
  return (
    <div className="space-y-5 text-sm">
      <div className="flex flex-wrap items-center gap-2">
        <Badge variant="outline">
          {row.status === "ok"
            ? row.divergent
              ? "Copies differ"
              : "Discovered"
            : row.status === "missing"
              ? "Missing on disk"
              : "Needs attention"}
        </Badge>
        {row.lock?.tier ? <TierCell row={row} /> : null}
        {projectSkillLevels(row).map((level) => (
          <Badge key={level} size="sm" variant="outline">
            {projectSkillLevelLabel(level)}
          </Badge>
        ))}
      </div>
      {row.aliases?.length ? (
        <p className="text-muted-foreground">
          {renderRich(tx("Also listed as {value}."), { value: row.aliases.join(", ") })}
        </p>
      ) : null}
      <ProjectSkillLinkButtons row={row} />
      <ProjectSkillVersionSection />
      {!row.lock?.skillId ? (
        <p className="text-xs text-muted-foreground">
          File version:{" "}
          {[...new Set(row.providers.map((p) => p.fileVersion).filter(Boolean))].join(" / ") ||
            "Not declared"}
          . Publish a version to enable registry updates and distribution.
        </p>
      ) : null}
      {problems.length > 0 ? (
        <section aria-label={tx("Problems")} className="space-y-1">
          <h3 className="font-medium text-foreground">{tx("Needs attention")}</h3>
          <ul className="list-disc space-y-1 ps-5 text-muted-foreground">
            {problems.map((problem) => (
              <li key={problem}>{problem}</li>
            ))}
          </ul>
        </section>
      ) : null}
      <section aria-label={tx("Loaded by")} className="space-y-1">
        <h3 className="font-medium text-foreground">{tx("Loaded by")}</h3>
        {row.providers.length === 0 ? (
          <p className="text-muted-foreground">{tx("No agent loads this skill in this folder.")}</p>
        ) : (
          <ul className="space-y-2">
            {groupSkillPresences(row.providers).map((group) => (
              <li key={`${group.scope}:${group.path}`} className="space-y-2 rounded-md border p-3">
                <div className="break-all font-mono text-xs text-muted-foreground">
                  {group.path}
                </div>
                {group.presences.map((presence) => (
                  <div key={presence.instanceId} className="space-y-1">
                    <div className="flex flex-wrap items-center gap-1.5">
                      <SkillProviderMark presence={presence} entries={entries} />
                      <span className="font-medium text-foreground">{presence.label}</span>
                      <Badge size="sm" variant="outline">
                        {projectSkillLevelLabel(projectSkillLevel(presence.scope, presence.path))}
                      </Badge>
                      {(presence.pluginVersion ?? presence.fileVersion) ? (
                        <Badge size="sm" variant="outline">
                          {presence.pluginVersion ? tx("plugin ") : ""}
                          {presence.pluginVersion ?? presence.fileVersion}
                        </Badge>
                      ) : null}
                      {presence.name ? (
                        <span className="text-muted-foreground">
                          {renderRich(tx("as {name}"), { name: presence.name })}
                        </span>
                      ) : null}
                      {presence.enabled ? null : (
                        <Badge size="sm" variant="secondary">
                          {tx("off")}
                        </Badge>
                      )}
                      {presence.userInvocable === false ? (
                        <Badge size="sm" variant="secondary">
                          {tx("agent only")}
                        </Badge>
                      ) : null}
                      <ProjectSkillAgentToggle presence={presence} />
                    </div>
                    <ProjectSkillPluginToggle presence={presence} />
                  </div>
                ))}
              </li>
            ))}
          </ul>
        )}
        {row.copies > 1 ? (
          <p className="text-xs text-muted-foreground">
            {renderRich(tx("{copies} separate copies on disk{value}"), {
              copies: row.copies,
              value: row.divergent ? tx(", and their contents differ.") : tx(", all identical."),
            })}
          </p>
        ) : null}
      </section>
      <section aria-label={tx("Install")} className="space-y-1">
        <h3 className="font-medium text-foreground">{tx("Install")}</h3>
        <dl>
          {/* The link buttons and the Version section above cover links, version and pin. */}
          <DetailItem term="Source">{row.lock?.source ?? "—"}</DetailItem>
          {row.lock?.skillId ? null : (
            <DetailItem term="Version">
              <VersionCell row={row} />
            </DetailItem>
          )}
          <DetailItem term="Tier">{row.lock?.tier ?? "—"}</DetailItem>
          <DetailItem term="Installed">
            {row.lock?.installedAt ? new Date(row.lock.installedAt).toLocaleString() : "—"}
          </DetailItem>
          <DetailItem term="Lockfile">
            {row.lock ? `${row.lock.lockPath} (${row.lock.lockScope})` : "—"}
          </DetailItem>
          <DetailItem term="Locked sha">
            <span className="font-mono">{row.lock?.sha || "—"}</span>
          </DetailItem>
          <DetailItem term="On disk">{DRIFT_LABELS[row.drift]}</DetailItem>
        </dl>
      </section>
    </div>
  );
}

function FacetGroup({
  label,
  options,
  value,
  onChange,
  renderIcon,
}: {
  label: string;
  options: ReadonlyArray<ProjectSkillFacetOption>;
  value: ReadonlyArray<string>;
  onChange: (next: Array<string>) => void;
  renderIcon?: (value: string) => ReactNode;
}) {
  if (options.length < 2 && value.length === 0) return null;
  return (
    <div className="flex flex-wrap items-center gap-1.5">
      <span className="text-xs text-muted-foreground">{label}</span>
      <ToggleGroup
        aria-label={`Filter by ${label.toLowerCase()}`}
        variant="default"
        size="compact"
        multiple
        className="flex-wrap gap-1.5"
        value={[...value]}
        onValueChange={(next) => onChange(next as Array<string>)}
      >
        {options.map((option) => (
          <Toggle
            key={option.value}
            value={option.value}
            variant="outline"
            size="compact"
            data-facet={option.value}
          >
            {renderIcon?.(option.value)}
            {option.label}
            <span className="text-muted-foreground tabular-nums">{option.count}</span>
          </Toggle>
        ))}
      </ToggleGroup>
    </div>
  );
}

function SkillsFootnotes({ snapshot }: { snapshot: ProjectSkillsSnapshot }) {
  const tx = useTx();
  const notes = snapshot.providers.filter((provider) => provider.state !== "ok");
  return (
    <div className="space-y-1 px-3 pb-3 text-xs text-muted-foreground sm:px-4">
      <p>
        {renderRich(tx("Agents: {value}. Lockfiles: {value2}. {value3}"), {
          value:
            snapshot.providers
              .map((provider) => `${provider.label} ${provider.skills}`)
              .join(" · ") || "none enabled",
          value2:
            snapshot.locks.length === 0
              ? "none found"
              : snapshot.locks.map((lock) => `${lock.path} (${lock.scope})`).join(", "),
          value3:
            snapshot.doctor === "ok"
              ? "Includes vskill doctor findings."
              : snapshot.doctor === "failed"
                ? "vskill doctor did not answer; its findings are left out."
                : "vskill doctor is not available here, so its findings are left out.",
        })}
      </p>
      {notes.map((provider) => (
        <p key={provider.instanceId}>
          {provider.label}: {provider.message ?? provider.state}
        </p>
      ))}
    </div>
  );
}

const NO_MEMBERS: ReadonlyArray<SkillMemberProject> = [];

export function ProjectSkillsView(props: Parameters<typeof ScopedProjectSkillsView>[0]) {
  const linked = useSearch({ strict: false }) as {
    skill?: string;
    skillContext?: string;
    skillCwd?: string;
    skillThread?: string;
  };
  if (
    linked.skill &&
    linked.skillContext &&
    (linked.skillContext !== `${props.environmentId}:${props.projectId}` || props.userLevel)
  ) {
    return (
      <p role="alert" className="p-4 text-sm text-muted-foreground">
        This skill’s original project or machine is unavailable. Return to the conversation,
        reconnect that machine and open the skill again.
      </p>
    );
  }
  const threadFolder =
    !props.userLevel && linked.skillContext === `${props.environmentId}:${props.projectId}`
      ? `${linked.skillCwd ?? ""}:${linked.skillThread ?? ""}`
      : "";
  return (
    <ScopedProjectSkillsView
      key={`${props.environmentId}:${props.projectId}:${props.userLevel ?? false}:${threadFolder}`}
      {...props}
    />
  );
}

function ScopedProjectSkillsView({
  environmentId,
  projectId,
  folder,
  memberProjects = NO_MEMBERS,
  userLevel = false,
}: {
  environmentId: EnvironmentId;
  projectId: ProjectId;
  folder: string;
  /** This project on every machine, for installing it on the others. */
  memberProjects?: ReadonlyArray<SkillMemberProject>;
  /** The machine-wide view: user-level skills of every agent, read from the home folder. */
  userLevel?: boolean;
}) {
  const tx = useTx();
  const linked = useSearch({ strict: false }) as {
    readonly skill?: unknown;
    readonly skillView?: string;
    readonly agent?: string;
    readonly skillCwd?: string;
    readonly skillThread?: string;
    readonly skillContext?: string;
  };
  const threadFolder =
    !userLevel &&
    linked.skillContext === `${environmentId}:${projectId}` &&
    linked.skillCwd &&
    linked.skillThread
      ? { cwd: linked.skillCwd, threadId: ThreadId.make(linked.skillThread) }
      : {};
  const [authoringOpen, setAuthoringOpen] = useState(false);
  const [authoringSeed, setAuthoringSeed] = useState<SkillAuthoringSeed | undefined>();
  const [editError, setEditError] = useState<string | null>(null);
  const [rescan, setRescan] = useState(false);
  const environment = useEnvironment(environmentId);
  const machineName = useMachineNickname(environmentId, environment?.label);
  const machineOffline =
    environment !== null &&
    environment.connection.phase !== "connected" &&
    environment.connection.phase !== "available";
  const query = useEnvironmentQuery(
    projectWorkspace.skills({
      environmentId,
      input: {
        projectId,
        ...(rescan ? { refresh: true } : {}),
        ...(userLevel ? { userLevel: true } : {}),
        ...threadFolder,
      },
    }),
  );
  const [search, setSearch] = useState("");
  const [problemsOnly, setProblemsOnly] = useState(false);
  const [providers, setProviders] = useState<ReadonlyArray<string>>(
    linked.agent ? [linked.agent] : [],
  );
  useEffect(() => {
    setProviders((current) =>
      current.length === (linked.agent ? 1 : 0) && (!linked.agent || current[0] === linked.agent)
        ? current
        : linked.agent
          ? [linked.agent]
          : [],
    );
  }, [linked.agent]);
  const [levels, setLevels] = useState<ReadonlyArray<string>>([]);
  const [tiers, setTiers] = useState<ReadonlyArray<string>>([]);
  // `?skill=` from the composer's Manage link opens that skill's sheet once, then leaves the URL,
  // so closing the sheet, a reload or Back does not open it again.
  const linkedSkill = typeof linked.skill === "string" && linked.skill !== "" ? linked.skill : null;
  const navigate = useNavigate();
  const [openSkill, setOpenSkill] = useState<string | null>(linkedSkill);
  /** The skill the link named, until the sheet opens for it or the notice is dismissed. */
  const [linkedName, setLinkedName] = useState<string | null>(linkedSkill);
  useEffect(() => {
    if (linkedSkill === null) return;
    setEditError(null);
    setOpenSkill(linkedSkill);
    setLinkedName(linkedSkill);
    setSheetFocus(linked.skillView === "compare" ? "compare" : null);
    void navigate({
      to: ".",
      search: ({ skill: _skill, skillView: _view, ...rest }: Record<string, unknown>) => rest,
      replace: true,
    });
  }, [linkedSkill, linked.skillView, navigate]);
  const [sheetFocus, setSheetFocus] = useState<SkillSheetFocus | "compare" | null>(
    linked.skillView === "compare" ? "compare" : null,
  );
  const [updates, setUpdates] = useState<Readonly<Record<string, string | null>>>({});
  const openWith = useCallback((name: string, focus?: SkillSheetFocus) => {
    setEditError(null);
    setOpenSkill(name);
    setSheetFocus(focus ?? null);
  }, []);
  const noteLatest = useCallback(
    (skill: string, latest: string | null) =>
      setUpdates((current) =>
        current[skill] === latest ? current : { ...current, [skill]: latest },
      ),
    [],
  );
  // The first Rescan switches the query key; keep showing the last result while it scans.
  const lastSnapshot = useRef(query.data);
  if (query.data) lastSnapshot.current = query.data;
  const snapshot = query.data ?? lastSnapshot.current;
  const rows = useMemo(
    () =>
      snapshot
        ? filterProjectSkillRows(snapshot.rows, {
            query: search,
            problemsOnly,
            providers,
            levels,
            tiers,
          })
        : [],
    [snapshot, search, problemsOnly, providers, levels, tiers],
  );
  const facets = useMemo(() => projectSkillFacets(snapshot?.rows ?? []), [snapshot]);
  const chipsActive = providers.length + levels.length + tiers.length > 0;
  const filtered = chipsActive || problemsOnly || search.trim() !== "";
  const detailRow = openSkill
    ? (snapshot?.rows.find((candidate) => candidate.name === openSkill) ??
      snapshot?.rows.find((candidate) => candidate.aliases?.includes(openSkill)) ??
      null)
    : null;
  const linkedMissing =
    linkedName !== null &&
    openSkill === linkedName &&
    snapshot !== undefined &&
    snapshot !== null &&
    detailRow === null &&
    !query.isPending;
  const attention = snapshot ? projectSkillAttentionCount(snapshot.rows) : 0;
  const entries = useProviderEntries(environmentId);
  const presenceByLabel = useMemo(() => {
    const byLabel = new Map<string, ProjectSkillPresence>();
    for (const row of snapshot?.rows ?? [])
      for (const presence of row.providers)
        if (!byLabel.has(presence.instanceId)) byLabel.set(presence.instanceId, presence);
    return byLabel;
  }, [snapshot]);

  return (
    <SettingsSection
      {...searchableSetting("project-skills")}
      headerAction={
        <div className="flex gap-2">
          <Button
            type="button"
            size="xs"
            variant="outline"
            disabled={machineOffline}
            onClick={() => {
              setAuthoringSeed(undefined);
              setAuthoringOpen(true);
            }}
          >
            New skill
          </Button>
          <Button
            size="xs"
            variant="outline"
            type="button"
            disabled={query.isPending}
            onClick={() => {
              if (rescan) query.refresh();
              else setRescan(true);
            }}
          >
            {query.isPending ? <Spinner className="size-3.5" /> : <RefreshCwIcon />}
            {tx("Rescan")}
          </Button>
        </div>
      }
    >
      <SkillAuthoringSheet
        environmentId={environmentId}
        projectId={projectId}
        cwd={threadFolder.cwd ?? folder}
        threadId={threadFolder.threadId}
        userLevel={userLevel}
        machineLabel={environment?.label ?? environmentId}
        initialInstanceId={linked.agent}
        open={authoringOpen}
        onOpenChange={setAuthoringOpen}
        seed={authoringSeed}
      />
      <div className="space-y-3 px-3 pt-3 sm:px-4">
        {userLevel ? (
          <p className="text-xs text-muted-foreground" data-testid="skills-user-level">
            {tx(
              "Every skill each agent loads for you on this machine, in every project. Turning one off changes only that agent's own settings, so other agents keep it and nothing is deleted. Pick a project to see its project skills too. Click a skill for details.",
            )}
          </p>
        ) : (
          <p className="text-xs text-muted-foreground">
            {renderRich(
              tx(
                "Which skills each agent loads in {span}, and whether each still matches the version vskill installed. Filter by agent or by level: project skills live in this folder, user skills apply to every project. Click a skill for details.",
              ),
              {
                span: (
                  <span className="break-all font-mono text-foreground/80">
                    {snapshot?.cwd ?? folder}
                  </span>
                ),
              },
            )}
          </p>
        )}
        {linkedMissing ? (
          <p
            className="flex flex-wrap items-center gap-2 text-xs text-muted-foreground"
            role="status"
            data-testid="skills-linked-missing"
          >
            <span>
              {renderRich(tx("{span} is not loaded in this project."), {
                span: <span className="font-medium text-foreground">{linkedName}</span>,
              })}
            </span>
            <Button
              size="micro"
              variant="ghost-muted"
              type="button"
              onClick={() => {
                setLinkedName(null);
                setOpenSkill(null);
              }}
            >
              {tx("Dismiss")}
            </Button>
          </p>
        ) : null}
        {snapshot ? (
          <p className="text-sm text-foreground" role="status" data-testid="skills-summary">
            {summarizeProjectSkills(snapshot.rows)}
            {filtered ? (
              <span className="text-muted-foreground">
                {" "}
                {renderRich(tx("· showing {length}"), { length: rows.length })}
              </span>
            ) : null}
          </p>
        ) : null}
        <div className="flex flex-wrap items-center gap-3">
          <div className="relative min-w-0 flex-1 basis-56">
            <SearchIcon className="pointer-events-none absolute top-1/2 left-2.5 z-10 size-3.5 -translate-y-1/2 text-muted-foreground" />
            <Input
              size="sm"
              type="search"
              className="w-full"
              aria-label={tx("Search skills")}
              placeholder={tx("Search skills, agents, sources")}
              value={search}
              onChange={(event) => setSearch(event.currentTarget.value)}
              style={{ paddingLeft: "1.75rem" }}
            />
          </div>
          <label className="flex shrink-0 cursor-pointer items-center gap-2 text-xs text-foreground">
            {renderRich(tx("{switch}Only problems{value}"), {
              switch: (
                <Switch
                  size="sm"
                  checked={problemsOnly}
                  onCheckedChange={(checked) => setProblemsOnly(checked)}
                  aria-label={tx("Only problems")}
                />
              ),
              value: attention > 0 ? ` (${attention})` : "",
            })}
          </label>
        </div>
        {snapshot && snapshot.rows.length > 0 ? (
          <div className="flex flex-wrap items-center gap-x-4 gap-y-2" data-testid="skills-filters">
            <FacetGroup
              label={tx("Agent")}
              options={facets.providers}
              value={providers}
              onChange={setProviders}
              renderIcon={(label) => {
                const presence = presenceByLabel.get(label);
                return presence ? (
                  <SkillProviderMark presence={presence} entries={entries} />
                ) : null;
              }}
            />
            <FacetGroup
              label={tx("Level")}
              options={facets.levels}
              value={levels}
              onChange={setLevels}
            />
            <FacetGroup
              label={tx("Tier")}
              options={facets.tiers}
              value={tiers}
              onChange={setTiers}
            />
            {filtered ? (
              <Button
                size="xs"
                variant="ghost-muted"
                type="button"
                onClick={() => {
                  setSearch("");
                  setProblemsOnly(false);
                  setProviders([]);
                  setLevels([]);
                  setTiers([]);
                }}
              >
                <XIcon />
                {tx("Clear filters")}
              </Button>
            ) : null}
          </div>
        ) : null}
      </div>
      {query.error && !snapshot ? (
        <p role="alert" className="px-3 py-4 text-sm text-destructive-foreground sm:px-4">
          {machineOffline
            ? `${machineName} is not connected, so its skills cannot be read now. Pick another machine above, or open SpecWithCode on ${machineName}.`
            : `Could not read this project's skills${environment ? ` on ${machineName}` : ""}: ${query.error}`}
        </p>
      ) : !snapshot ? (
        <p
          role="status"
          className="flex items-center gap-2 px-3 py-4 text-sm text-muted-foreground sm:px-4"
        >
          <Spinner className="size-3.5" />
          {tx("Scanning skill folders and lockfiles…")}
        </p>
      ) : snapshot.rows.length === 0 ? (
        <p className="px-3 py-4 text-sm text-muted-foreground sm:px-4">
          {tx("No agent loads any skill in this folder, and no vskill lockfile lists one.")}
        </p>
      ) : (
        <>
          {query.error ? (
            <p role="alert" className="px-3 text-xs text-destructive-foreground sm:px-4">
              {renderRich(tx("The last rescan failed ({error}); showing the previous result."), {
                error: query.error,
              })}
            </p>
          ) : null}
          <div className="px-1 sm:px-2" data-testid="skills-table">
            <Table className="min-w-[44rem]" aria-label={tx("Project skills")}>
              <TableHeader>
                <TableRow>
                  <TableHead>{tx("Skill")}</TableHead>
                  <TableHead>{tx("Providers")}</TableHead>
                  <TableHead>{tx("Scope")}</TableHead>
                  <TableHead>{tx("Version")}</TableHead>
                  <TableHead>{tx("Tier")}</TableHead>
                  <TableHead>{tx("Source")}</TableHead>
                  <TableHead>{tx("Status")}</TableHead>
                  <TableHead>
                    <span className="sr-only">{tx("Actions")}</span>
                  </TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {rows.length === 0 ? (
                  <TableRow>
                    <TableCell colSpan={8}>
                      <p className="py-2 text-center text-muted-foreground">
                        {problemsOnly && !search.trim() && !chipsActive
                          ? tx("Nothing needs attention.")
                          : tx("No skills match these filters.")}
                      </p>
                    </TableCell>
                  </TableRow>
                ) : (
                  rows.map((row) => (
                    <SkillRow
                      key={row.name}
                      row={row}
                      entries={entries}
                      update={updates[row.name] ?? null}
                      onOpen={openWith}
                    />
                  ))
                )}
              </TableBody>
            </Table>
          </div>
          <SkillsFootnotes snapshot={snapshot} />
          <Sheet
            open={detailRow !== null}
            onOpenChange={(open) => {
              if (!open) setOpenSkill(null);
            }}
          >
            {/* The page also renders inside the Settings dialog; the sheet must cover it. */}
            <SheetPopup className="max-w-2xl" layer="dialog" data-testid="skill-details">
              {detailRow ? (
                <SkillControlsProvider
                  key={`${detailRow.name}:${threadFolder.cwd ?? ""}:${threadFolder.threadId ?? ""}`}
                  environmentId={environmentId}
                  projectId={projectId}
                  {...threadFolder}
                  row={detailRow}
                  memberProjects={memberProjects}
                  userLevel={userLevel}
                  initialPushOpen={sheetFocus === "push"}
                  onChanged={query.refresh}
                  onLatest={noteLatest}
                >
                  <SheetHeader>
                    <SheetTitle className="me-8 break-all">{detailRow.name}</SheetTitle>
                    <SheetDescription>Read, compare and manage this skill.</SheetDescription>
                  </SheetHeader>
                  <SkillDetailPanel
                    key={`${detailRow.name}:${sheetFocus ?? "overview"}`}
                    row={detailRow}
                    machineLabel={environment?.label ?? "This machine"}
                    initialView={sheetFocus === "compare" ? "compare" : "overview"}
                    editError={editError}
                    onChanged={query.refresh}
                    onEdit={(copy) => {
                      const parsed = skillAuthoringSeedFromMarkdown(copy.content, detailRow.name);
                      if ("error" in parsed) {
                        setEditError(parsed.error);
                        return;
                      }
                      setEditError(null);
                      setAuthoringSeed({
                        key: `${copy.id}:${copy.hash}`,
                        label: detailRow.name,
                        content: parsed.content,
                      });
                      setAuthoringOpen(true);
                    }}
                  >
                    <SkillDetails row={detailRow} entries={entries} />
                  </SkillDetailPanel>
                  <ProjectSkillSheetFooter />
                </SkillControlsProvider>
              ) : null}
            </SheetPopup>
          </Sheet>
        </>
      )}
    </SettingsSection>
  );
}
