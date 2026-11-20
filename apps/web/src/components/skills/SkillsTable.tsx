import { type ProjectSkillPresence, type ProjectSkillRow } from "@specweave-studio/contracts";
import { BadgeCheckIcon, ExternalLinkIcon, PinIcon } from "lucide-react";
import type { ReactNode } from "react";

import { renderRich } from "../../i18n/rich";
import { useTx } from "../../i18n";
import type { ProviderInstanceEntry } from "../../providerInstances";
import { cn } from "~/lib/utils";
import { ProviderInstanceIcon } from "../chat/ProviderInstanceIcon";
import { ProjectSkillRowMenu, type SkillSheetFocus } from "../settings/ProjectSkillRowMenu";
import {
  projectSkillProviderBadges,
  projectSkillScopeChips,
  projectSkillSourceLinks,
  projectSkillStatusBadge,
  projectSkillVersions,
} from "../settings/ProjectSkillsSettings.logic";
import { Badge } from "../ui/badge";
import { TableCell, TableRow } from "../ui/table";
import { Tooltip, TooltipPopup, TooltipTrigger } from "../ui/tooltip";

/**
 * The rows and cells of the Settings > Skills table: one skill per row, with
 * the agents that load it, where its copies sit, its version and where it
 * came from.
 */

/** Text with a hover hint; the hint lists what does not fit in the cell. */
export function Hinted({
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

export function ExternalLink({
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

export function TierCell({ row }: { row: ProjectSkillRow }) {
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

/** Every level a copy sits at; a level only a lower-priority copy has reads "also found". */
function ScopeCell({ row }: { row: ProjectSkillRow }) {
  const tx = useTx();
  const chips = projectSkillScopeChips(row);
  if (chips.length === 0)
    return (
      <span className="text-muted-foreground" data-testid="skill-scope">
        {tx("Not known")}
      </span>
    );
  return (
    <span className="flex flex-wrap gap-1" data-testid="skill-scope">
      {chips.map((chip) => (
        <Badge
          key={`${chip.level}:${chip.alsoFound}`}
          size="sm"
          variant="outline"
          className={chip.alsoFound ? "border-dashed text-muted-foreground" : undefined}
          data-scope={chip.level}
          data-also-found={chip.alsoFound ? "true" : "false"}
        >
          {chip.alsoFound ? tx("{scope}, also found", { scope: chip.label }) : chip.label}
        </Badge>
      ))}
    </span>
  );
}

function SourceCell({ row }: { row: ProjectSkillRow }) {
  const tx = useTx();
  const source = row.lock?.source;
  // No dash: a dash reads as "nothing here", and the fact is that no lock that was read lists the skill.
  if (!row.lock)
    return (
      <Hinted
        hint={tx(
          "No vskill lockfile read here lists this skill, so where it came from is not known. It may have been copied in by hand or installed by another tool.",
        )}
        className="text-muted-foreground"
      >
        <span data-testid="skill-source-none">{tx("No lock entry found")}</span>
      </Hinted>
    );
  if (!source)
    return (
      <span className="text-muted-foreground" data-testid="skill-source-none">
        {tx("Lock names no source")}
      </span>
    );
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

export type ProviderEntries = ReadonlyMap<string, ProviderInstanceEntry>;

/** The provider's own mark, the same one the model picker and thread headers draw. */
export function SkillProviderMark({
  presence,
  entries,
  dimmed = false,
}: {
  presence: Pick<ProjectSkillPresence, "instanceId" | "driver" | "label">;
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
export function VersionCell({ row, update }: { row: ProjectSkillRow; update?: string | null }) {
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

export function SkillRow({
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
                  {badge.folderScan ? (
                    <span className="text-muted-foreground" data-testid="skill-folder-scan">
                      {tx("folder scan")}
                    </span>
                  ) : null}
                </Badge>
              </Hinted>
            ))}
          </div>
        )}
      </TableCell>
      <TableCell>
        <ScopeCell row={row} />
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
