import {
  EnvironmentId,
  summarizeProjectSkills,
  type ProjectId,
  type ProjectSkillPresence,
  type ProjectSkillRow,
  type ProjectSkillsSnapshot,
} from "@specweave-studio/contracts";
import {
  BadgeCheckIcon,
  CheckIcon,
  CopyIcon,
  ExternalLinkIcon,
  RefreshCwIcon,
  SearchIcon,
  XIcon,
} from "lucide-react";
import { type ReactNode, useMemo, useRef, useState } from "react";

import { useCopyToClipboard } from "~/hooks/useCopyToClipboard";
import { cn } from "~/lib/utils";
import type { ProviderInstanceEntry } from "../../providerInstances";
import { useEnvironmentQuery } from "../../state/query";
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
import {
  filterProjectSkillRows,
  projectSkillAttentionCount,
  projectSkillFacets,
  projectSkillLevel,
  projectSkillLevels,
  projectSkillProviderBadges,
  projectSkillSourceLinks,
  projectSkillStatusBadge,
  type ProjectSkillFacetOption,
} from "./ProjectSkillsSettings.logic";
import { useSettingsScope } from "./SettingsScopeContext";
import { SettingsScopeNotice } from "./SettingsScopeNotice";
import { SettingsPageContainer, SettingsSection } from "./settingsLayout";
import { searchableSetting } from "./settingsSearch";
import { useSettingsProjectGroups } from "./useSettingsProjectGroups";

/** `/settings/skills`: which skills each agent loads in the selected project's folder. */
export function ProjectSkillsSettings() {
  const { search: value, scope } = useSettingsScope();
  const groups = useSettingsProjectGroups();
  const projectScope = scope.kind === "project" || scope.kind === "checkout";
  const machine = value.machine ? EnvironmentId.make(value.machine) : null;
  const group = projectScope
    ? (groups.find((candidate) => candidate.projectKey === value.project) ?? null)
    : null;
  const member =
    group?.memberProjects.find(
      (candidate) =>
        (machine === null || candidate.environmentId === machine) &&
        (value.checkout === undefined || candidate.physicalProjectKey === value.checkout),
    ) ?? null;

  if (!projectScope) {
    return (
      <div className="flex min-h-0 flex-1 flex-col">
        {scope.kind === "unavailable" ? (
          <SettingsPageContainer>
            <p className="text-sm text-muted-foreground">{scope.message}</p>
          </SettingsPageContainer>
        ) : (
          <SettingsScopeNotice target="project">
            Choose a project to see which skills each agent loads in its folder.
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
          />
        ) : (
          <p className="text-sm text-muted-foreground">This project is no longer available.</p>
        )}
      </SettingsPageContainer>
    </div>
  );
}

function CopyPathButton({ row }: { row: ProjectSkillRow }) {
  const { copyToClipboard, isCopied } = useCopyToClipboard({ timeout: 1500, target: "path" });
  return (
    <Button
      size="icon-xs"
      variant="ghost-muted"
      type="button"
      disabled={row.path === null}
      aria-label={`Copy the SKILL.md path of ${row.name}`}
      onClick={() => {
        if (row.path) copyToClipboard(row.path, undefined);
      }}
    >
      {isCopied ? <CheckIcon /> : <CopyIcon />}
    </Button>
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

function SkillRow({
  row,
  entries,
  onOpen,
}: {
  row: ProjectSkillRow;
  entries: ProviderEntries;
  onOpen: (name: string) => void;
}) {
  const issue = row.issues[0];
  return (
    <TableRow
      data-skill={row.name}
      data-status={row.status}
      className="cursor-pointer"
      onClick={(event) => {
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
          <span className="text-muted-foreground">None</span>
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
                </Badge>
              </Hinted>
            ))}
          </div>
        )}
      </TableCell>
      <TableCell>
        <span className="text-muted-foreground">{row.scopes.join(", ") || "—"}</span>
      </TableCell>
      <TableCell>
        <span className="font-mono">{row.lock?.version ?? "—"}</span>
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
        <CopyPathButton row={row} />
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
  const links = projectSkillSourceLinks(row);
  const problems = [...new Set([...row.issues, ...row.doctor])];
  return (
    <div className="min-h-0 flex-1 space-y-5 overflow-y-auto px-6 pb-6 text-sm">
      <div className="flex flex-wrap items-center gap-2">
        <StatusBadge row={row} />
        {row.lock?.tier ? <TierCell row={row} /> : null}
        {projectSkillLevels(row).map((level) => (
          <Badge key={level} size="sm" variant="outline">
            {level}
          </Badge>
        ))}
      </div>
      {links?.registryUrl || links?.repoUrl ? (
        <div className="flex flex-wrap gap-2">
          {links.registryUrl ? (
            <Button
              size="xs"
              variant="outline"
              render={<a href={links.registryUrl} target="_blank" rel="noreferrer noopener" />}
            >
              <BadgeCheckIcon aria-hidden />
              View on verified-skill.com
            </Button>
          ) : null}
          {links.repoUrl ? (
            <Button
              size="xs"
              variant="outline"
              render={<a href={links.repoUrl} target="_blank" rel="noreferrer noopener" />}
            >
              <ExternalLinkIcon aria-hidden />
              Source repository
            </Button>
          ) : null}
        </div>
      ) : null}
      {problems.length > 0 ? (
        <section aria-label="Problems" className="space-y-1">
          <h3 className="font-medium text-foreground">Needs attention</h3>
          <ul className="list-disc space-y-1 ps-5 text-muted-foreground">
            {problems.map((problem) => (
              <li key={problem}>{problem}</li>
            ))}
          </ul>
        </section>
      ) : null}
      <section aria-label="Loaded by" className="space-y-1">
        <h3 className="font-medium text-foreground">Loaded by</h3>
        {row.providers.length === 0 ? (
          <p className="text-muted-foreground">No agent loads this skill in this folder.</p>
        ) : (
          <ul className="space-y-2">
            {row.providers.map((presence) => (
              <li key={`${presence.instanceId}:${presence.path}`} className="space-y-0.5">
                <div className="flex flex-wrap items-center gap-1.5">
                  <SkillProviderMark presence={presence} entries={entries} />
                  <span className="font-medium text-foreground">{presence.label}</span>
                  <Badge size="sm" variant="outline">
                    {projectSkillLevel(presence.scope)}
                  </Badge>
                  {presence.enabled ? null : (
                    <Badge size="sm" variant="secondary">
                      off
                    </Badge>
                  )}
                </div>
                <div className="break-all font-mono text-xs text-muted-foreground">
                  {presence.path}
                </div>
              </li>
            ))}
          </ul>
        )}
        {row.copies > 1 ? (
          <p className="text-xs text-muted-foreground">
            {row.copies} separate copies on disk
            {row.divergent ? ", and their contents differ." : ", all identical."}
          </p>
        ) : null}
      </section>
      <section aria-label="Install" className="space-y-1">
        <h3 className="font-medium text-foreground">Install</h3>
        <dl>
          <DetailItem term="Source">{row.lock?.source ?? "—"}</DetailItem>
          {links?.registryUrl ? (
            <DetailItem term="verified-skill.com">
              <ExternalLink
                href={links.registryUrl}
                label={`Open ${row.name} on verified-skill.com: ${links.registryUrl}`}
                className="break-all text-foreground underline"
              >
                {links.registryUrl}
              </ExternalLink>
            </DetailItem>
          ) : null}
          {links?.repoUrl ? (
            <DetailItem term="Repository">
              <ExternalLink
                href={links.repoUrl}
                label={`Open the source of ${row.name}: ${links.repoUrl}`}
                className="break-all text-foreground underline"
              >
                {links.repoUrl}
              </ExternalLink>
            </DetailItem>
          ) : null}
          <DetailItem term="Version">{row.lock?.version ?? "—"}</DetailItem>
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
        className="flex-wrap"
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
            <span className="ms-1 text-muted-foreground tabular-nums">{option.count}</span>
          </Toggle>
        ))}
      </ToggleGroup>
    </div>
  );
}

function SkillsFootnotes({ snapshot }: { snapshot: ProjectSkillsSnapshot }) {
  const notes = snapshot.providers.filter((provider) => provider.state !== "ok");
  return (
    <div className="space-y-1 px-3 pb-3 text-xs text-muted-foreground sm:px-4">
      <p>
        Agents:{" "}
        {snapshot.providers.map((provider) => `${provider.label} ${provider.skills}`).join(" · ") ||
          "none enabled"}
        . Lockfiles:{" "}
        {snapshot.locks.length === 0
          ? "none found"
          : snapshot.locks.map((lock) => `${lock.path} (${lock.scope})`).join(", ")}
        .{" "}
        {snapshot.doctor === "ok"
          ? "Includes vskill doctor findings."
          : snapshot.doctor === "failed"
            ? "vskill doctor did not answer; its findings are left out."
            : "vskill doctor is not available here, so its findings are left out."}
      </p>
      {notes.map((provider) => (
        <p key={provider.instanceId}>
          {provider.label}: {provider.message ?? provider.state}
        </p>
      ))}
    </div>
  );
}

export function ProjectSkillsView({
  environmentId,
  projectId,
  folder,
}: {
  environmentId: EnvironmentId;
  projectId: ProjectId;
  folder: string;
}) {
  const [rescan, setRescan] = useState(false);
  const query = useEnvironmentQuery(
    projectWorkspace.skills({
      environmentId,
      input: rescan ? { projectId, refresh: true } : { projectId },
    }),
  );
  const [search, setSearch] = useState("");
  const [problemsOnly, setProblemsOnly] = useState(false);
  const [providers, setProviders] = useState<ReadonlyArray<string>>([]);
  const [levels, setLevels] = useState<ReadonlyArray<string>>([]);
  const [tiers, setTiers] = useState<ReadonlyArray<string>>([]);
  const [openSkill, setOpenSkill] = useState<string | null>(null);
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
    ? (snapshot?.rows.find((candidate) => candidate.name === openSkill) ?? null)
    : null;
  const attention = snapshot ? projectSkillAttentionCount(snapshot.rows) : 0;
  const entries = useProviderEntries(environmentId);
  const presenceByLabel = useMemo(() => {
    const byLabel = new Map<string, ProjectSkillPresence>();
    for (const row of snapshot?.rows ?? [])
      for (const presence of row.providers)
        if (!byLabel.has(presence.label)) byLabel.set(presence.label, presence);
    return byLabel;
  }, [snapshot]);

  return (
    <SettingsSection
      {...searchableSetting("project-skills")}
      headerAction={
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
          Rescan
        </Button>
      }
    >
      <div className="space-y-3 px-3 pt-3 sm:px-4">
        <p className="text-xs text-muted-foreground">
          Which skills each agent loads in{" "}
          <span className="break-all font-mono text-foreground/80">{folder}</span>, and whether each
          still matches the version vskill installed. Filter by agent or by level: project skills
          live in this folder, user skills apply to every project. Click a skill for details.
        </p>
        {snapshot ? (
          <p className="text-sm text-foreground" role="status" data-testid="skills-summary">
            {summarizeProjectSkills(snapshot.rows)}
            {filtered ? (
              <span className="text-muted-foreground"> · showing {rows.length}</span>
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
              aria-label="Search skills"
              placeholder="Search skills, agents, sources"
              value={search}
              onChange={(event) => setSearch(event.currentTarget.value)}
              style={{ paddingLeft: "1.75rem" }}
            />
          </div>
          <label className="flex shrink-0 cursor-pointer items-center gap-2 text-xs text-foreground">
            <Switch
              size="sm"
              checked={problemsOnly}
              onCheckedChange={(checked) => setProblemsOnly(checked)}
              aria-label="Only problems"
            />
            Only problems{attention > 0 ? ` (${attention})` : ""}
          </label>
        </div>
        {snapshot && snapshot.rows.length > 0 ? (
          <div className="flex flex-wrap items-center gap-x-4 gap-y-2" data-testid="skills-filters">
            <FacetGroup
              label="Agent"
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
            <FacetGroup label="Level" options={facets.levels} value={levels} onChange={setLevels} />
            <FacetGroup label="Tier" options={facets.tiers} value={tiers} onChange={setTiers} />
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
                Clear filters
              </Button>
            ) : null}
          </div>
        ) : null}
      </div>
      {query.error && !snapshot ? (
        <p role="alert" className="px-3 py-4 text-sm text-destructive-foreground sm:px-4">
          Could not read this project's skills: {query.error}
        </p>
      ) : !snapshot ? (
        <p
          role="status"
          className="flex items-center gap-2 px-3 py-4 text-sm text-muted-foreground sm:px-4"
        >
          <Spinner className="size-3.5" />
          Scanning skill folders and lockfiles…
        </p>
      ) : snapshot.rows.length === 0 ? (
        <p className="px-3 py-4 text-sm text-muted-foreground sm:px-4">
          No agent loads any skill in this folder, and no vskill lockfile lists one.
        </p>
      ) : (
        <>
          {query.error ? (
            <p role="alert" className="px-3 text-xs text-destructive-foreground sm:px-4">
              The last rescan failed ({query.error}); showing the previous result.
            </p>
          ) : null}
          <div className="px-1 sm:px-2" data-testid="skills-table">
            <Table className="min-w-[44rem]" aria-label="Project skills">
              <TableHeader>
                <TableRow>
                  <TableHead>Skill</TableHead>
                  <TableHead>Providers</TableHead>
                  <TableHead>Scope</TableHead>
                  <TableHead>Version</TableHead>
                  <TableHead>Tier</TableHead>
                  <TableHead>Source</TableHead>
                  <TableHead>Status</TableHead>
                  <TableHead>
                    <span className="sr-only">Actions</span>
                  </TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {rows.length === 0 ? (
                  <TableRow>
                    <TableCell colSpan={8}>
                      <p className="py-2 text-center text-muted-foreground">
                        {problemsOnly && !search.trim() && !chipsActive
                          ? "Nothing needs attention."
                          : "No skills match these filters."}
                      </p>
                    </TableCell>
                  </TableRow>
                ) : (
                  rows.map((row) => (
                    <SkillRow key={row.name} row={row} entries={entries} onOpen={setOpenSkill} />
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
            <SheetPopup className="max-w-lg" layer="dialog" data-testid="skill-details">
              {detailRow ? (
                <>
                  <SheetHeader>
                    <SheetTitle className="me-8 break-all">{detailRow.name}</SheetTitle>
                    {detailRow.description ? (
                      <SheetDescription>{detailRow.description}</SheetDescription>
                    ) : null}
                  </SheetHeader>
                  <SkillDetails row={detailRow} entries={entries} />
                </>
              ) : null}
            </SheetPopup>
          </Sheet>
        </>
      )}
    </SettingsSection>
  );
}
