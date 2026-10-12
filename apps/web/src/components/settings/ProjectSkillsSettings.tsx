import {
  EnvironmentId,
  summarizeProjectSkills,
  type ProjectId,
  type ProjectSkillRow,
  type ProjectSkillsSnapshot,
} from "@specweave-studio/contracts";
import { CheckIcon, CopyIcon, RefreshCwIcon, SearchIcon } from "lucide-react";
import { type ReactNode, useMemo, useRef, useState } from "react";

import { useCopyToClipboard } from "~/hooks/useCopyToClipboard";
import { useEnvironmentQuery } from "../../state/query";
import { projectWorkspace } from "../../studio/projectWorkspace";
import { Badge } from "../ui/badge";
import { Button } from "../ui/button";
import { Input } from "../ui/input";
import { Spinner } from "../ui/spinner";
import { Switch } from "../ui/switch";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "../ui/table";
import { Tooltip, TooltipPopup, TooltipTrigger } from "../ui/tooltip";
import {
  filterProjectSkillRows,
  projectSkillAttentionCount,
  projectSkillProviderBadges,
  projectSkillStatusBadge,
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

function SkillRow({ row }: { row: ProjectSkillRow }) {
  const status = projectSkillStatusBadge(row);
  const issue = row.issues[0];
  return (
    <TableRow data-skill={row.name} data-status={row.status}>
      <TableCell className="max-w-64 whitespace-normal">
        <div className="truncate font-medium text-foreground">{row.name}</div>
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
      <TableCell>{row.lock?.tier ?? "—"}</TableCell>
      <TableCell className="max-w-56">
        {row.lock?.source ? (
          <Hinted hint={row.lock.source} className="block truncate text-muted-foreground">
            {row.lock.source}
          </Hinted>
        ) : (
          <span className="text-muted-foreground">—</span>
        )}
      </TableCell>
      <TableCell>
        {row.issues.length > 0 ? (
          <Hinted hint={row.issues.join("\n")}>
            <Badge size="sm" variant={status.variant}>
              {status.label}
            </Badge>
          </Hinted>
        ) : (
          <Badge size="sm" variant={status.variant}>
            {status.label}
          </Badge>
        )}
      </TableCell>
      <TableCell className="w-8 text-right">
        <CopyPathButton row={row} />
      </TableCell>
    </TableRow>
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
  // The first Rescan switches the query key; keep showing the last result while it scans.
  const lastSnapshot = useRef(query.data);
  if (query.data) lastSnapshot.current = query.data;
  const snapshot = query.data ?? lastSnapshot.current;
  const rows = useMemo(
    () => (snapshot ? filterProjectSkillRows(snapshot.rows, { query: search, problemsOnly }) : []),
    [snapshot, search, problemsOnly],
  );
  const attention = snapshot ? projectSkillAttentionCount(snapshot.rows) : 0;

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
          still matches the version vskill installed.
        </p>
        {snapshot ? (
          <p className="text-sm text-foreground" role="status" data-testid="skills-summary">
            {summarizeProjectSkills(snapshot.rows)}
            {search.trim() || problemsOnly ? (
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
                        {problemsOnly && !search.trim()
                          ? "Nothing needs attention."
                          : "No skills match this search."}
                      </p>
                    </TableCell>
                  </TableRow>
                ) : (
                  rows.map((row) => <SkillRow key={row.name} row={row} />)
                )}
              </TableBody>
            </Table>
          </div>
          <SkillsFootnotes snapshot={snapshot} />
        </>
      )}
    </SettingsSection>
  );
}
