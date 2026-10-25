/**
 * Settings > Design systems, without data wiring: every system across the
 * Playground and projects, proposals waiting for review, and the ways to
 * start a new one.
 */
import type {
  DesignSystemProposalSummary,
  DesignSystemSummary,
  ThreadId,
} from "@specweave-studio/contracts";
import {
  ChevronDownIcon,
  EllipsisIcon,
  ExternalLinkIcon,
  FigmaIcon,
  FileCode2Icon,
  FileJsonIcon,
  MessageSquareTextIcon,
  PencilIcon,
  PlusIcon,
  RefreshCwIcon,
  SearchIcon,
  SparklesIcon,
  Trash2Icon,
} from "lucide-react";
import { useState, type ComponentType, type ReactNode } from "react";

import { SettingsGroup } from "../../settings/SettingsGroup";
import { Button } from "../../ui/button";
import { InputGroup, InputGroupAddon, InputGroupInput } from "../../ui/input-group";
import { Menu, MenuItem, MenuPopup, MenuSeparator, MenuTrigger } from "../../ui/menu";
import { problemKey, type OwnerProblem } from "../gallery/boardOwner";
import { editedAgo } from "../gallery/galleryModel";
import { offeredModes, type FigmaStatusView, type NewSystemMode } from "./NewDesignSystemDialog";
import {
  countsLabel,
  filterSystems,
  isRescannable,
  ownerName,
  proposalMeta,
  sourcesLabel,
  systemKey,
  type OwnerProject,
} from "./reviewModel";

export type RescanState =
  | { readonly status: "busy" }
  | { readonly status: "unchanged" }
  | { readonly status: "not-rescannable"; readonly detail: string }
  | { readonly status: "error"; readonly message: string };

export interface DesignSystemsSettingsViewProps {
  systems: readonly DesignSystemSummary[] | null;
  systemsError: string | null;
  problems: readonly OwnerProblem[];
  proposals: readonly DesignSystemProposalSummary[] | null;
  projects: readonly OwnerProject[];
  now: number;
  canWrite: boolean;
  rescans: Readonly<Record<string, RescanState>>;
  threadTitleFor: (threadId: ThreadId) => string | null;
  onRescan: (system: DesignSystemSummary) => void;
  onOpenProposal: (proposal: DesignSystemProposalSummary) => void;
  onNew: (mode: NewSystemMode) => void;
  /** Figma's local desktop MCP server; omitted where it is not checked. */
  figma?: FigmaStatusView;
  /** The server can start a system from scratch (`designSystemEditing`). */
  canStartFromScratch?: boolean;
  /** The system page's address, so a row name opens like a link. */
  systemHref?: (system: DesignSystemSummary) => string;
  onOpenSystem?: (system: DesignSystemSummary) => void;
  onRenameSystem?: (system: DesignSystemSummary) => void;
  onDeleteSystem?: (system: DesignSystemSummary) => void;
}

/** A row's name: a link to the system's page when the page is wired, plain text otherwise. */
function SystemName({
  system,
  href,
  onOpen,
}: {
  system: DesignSystemSummary;
  href: string | undefined;
  onOpen: ((system: DesignSystemSummary) => void) | undefined;
}) {
  if (onOpen === undefined) return <div className="truncate text-foreground">{system.name}</div>;
  return (
    <a
      href={href ?? "#"}
      data-testid="system-link"
      className="block truncate text-foreground underline-offset-4 hover:underline focus-visible:underline focus-visible:outline-none"
      onClick={(event) => {
        // Modified clicks keep the browser's own new tab or window.
        if (event.metaKey || event.ctrlKey || event.shiftKey || event.altKey || event.button !== 0)
          return;
        event.preventDefault();
        onOpen(system);
      }}
    >
      {system.name}
    </a>
  );
}

function SystemRowMenu({
  system,
  canWrite,
  onOpen,
  onRename,
  onDelete,
}: {
  system: DesignSystemSummary;
  canWrite: boolean;
  onOpen: ((system: DesignSystemSummary) => void) | undefined;
  onRename: ((system: DesignSystemSummary) => void) | undefined;
  onDelete: ((system: DesignSystemSummary) => void) | undefined;
}) {
  if (onOpen === undefined && onRename === undefined && onDelete === undefined) return null;
  return (
    <Menu>
      <MenuTrigger
        render={
          <Button
            variant="ghost"
            size="icon-xs"
            aria-label={`More for ${system.name}`}
            data-testid="system-row-menu"
          />
        }
      >
        <EllipsisIcon aria-hidden />
      </MenuTrigger>
      <MenuPopup align="end" className="min-w-44">
        {onOpen ? (
          <MenuItem onClick={() => onOpen(system)}>
            <ExternalLinkIcon aria-hidden />
            Open
          </MenuItem>
        ) : null}
        {onRename ? (
          <MenuItem disabled={!canWrite} onClick={() => onRename(system)}>
            <PencilIcon aria-hidden />
            Rename…
          </MenuItem>
        ) : null}
        {onDelete ? (
          <>
            <MenuSeparator />
            <MenuItem variant="destructive" disabled={!canWrite} onClick={() => onDelete(system)}>
              <Trash2Icon aria-hidden />
              Delete…
            </MenuItem>
          </>
        ) : null}
      </MenuPopup>
    </Menu>
  );
}

/** "Figma desktop: connected" and friends, from the last check (AC-09). */
export function figmaDesktopLabel(figma: FigmaStatusView): string {
  if (figma.error !== null) return "Figma desktop: could not check";
  const status = figma.status;
  if (status === null) return "Figma desktop: checking…";
  if (status.state === "off") return "Figma desktop: off";
  if (status.state === "error") return "Figma desktop: error";
  const tools = status.tools.length === 1 ? "1 tool" : `${status.tools.length} tools`;
  return `Figma desktop: connected, ${tools}`;
}

function FigmaDesktopRow({ figma }: { figma: FigmaStatusView }) {
  return (
    <div
      className="flex items-center justify-between gap-3 px-4 py-2.5"
      data-testid="figma-desktop"
    >
      <div className="flex min-w-0 items-center gap-2 text-sm text-foreground">
        <FigmaIcon aria-hidden className="size-4 shrink-0 text-muted-foreground" />
        <span data-state={figma.status?.state ?? "checking"}>{figmaDesktopLabel(figma)}</span>
      </div>
      <Button variant="ghost" size="xs" disabled={figma.checking} onClick={figma.onCheck}>
        <RefreshCwIcon aria-hidden className={figma.checking ? "animate-spin" : ""} />
        {figma.checking ? "Checking" : "Check again"}
      </Button>
    </div>
  );
}

const MODE_ICONS: Record<NewSystemMode, ComponentType<{ className?: string }>> = {
  scratch: SparklesIcon,
  code: FileCode2Icon,
  "tokens-file": FileJsonIcon,
  figma: FigmaIcon,
  describe: MessageSquareTextIcon,
};

function Section({
  title,
  action,
  children,
  testId,
}: {
  title: string;
  action?: ReactNode;
  children: ReactNode;
  testId: string;
}) {
  return (
    <section className="space-y-2.5" data-testid={testId}>
      <div className="flex min-h-7 flex-wrap items-center justify-between gap-2 px-3 sm:px-4">
        <h2 className="text-sm font-normal text-foreground/70">{title}</h2>
        <div className="flex min-w-0 flex-wrap items-center justify-end gap-2">{action}</div>
      </div>
      <SettingsGroup>{children}</SettingsGroup>
    </section>
  );
}

const updatedLabel = (updatedAt: string, now: number) => {
  const label = editedAgo(updatedAt, now).replace(/^Edited /, "");
  return label.charAt(0).toUpperCase() + label.slice(1);
};

function RescanCell({
  system,
  state,
  canWrite,
  onRescan,
}: {
  system: DesignSystemSummary;
  state: RescanState | undefined;
  canWrite: boolean;
  onRescan: () => void;
}) {
  if (!isRescannable(system)) return null;
  const note =
    state?.status === "unchanged"
      ? "No changes"
      : state?.status === "not-rescannable"
        ? state.detail
        : state?.status === "error"
          ? state.message
          : null;
  return (
    <div className="flex items-center justify-end gap-2">
      {note ? (
        <span
          data-testid="rescan-note"
          className={
            state?.status === "error"
              ? "text-destructive-foreground text-xs"
              : "text-muted-foreground text-xs"
          }
        >
          {note}
        </span>
      ) : null}
      <Button
        variant="ghost"
        size="xs"
        disabled={!canWrite || state?.status === "busy"}
        aria-label={`Rescan ${system.name}`}
        onClick={onRescan}
      >
        <RefreshCwIcon aria-hidden className={state?.status === "busy" ? "animate-spin" : ""} />
        {state?.status === "busy" ? "Rescanning" : "Rescan"}
      </Button>
    </div>
  );
}

export function DesignSystemsSettingsView(props: DesignSystemsSettingsViewProps) {
  const [query, setQuery] = useState("");
  const systems = props.systems === null ? null : filterSystems(props.systems, query);

  const newMenu = (
    <Menu>
      <MenuTrigger
        render={
          <Button size="sm" disabled={!props.canWrite} data-testid="new-design-system">
            <PlusIcon aria-hidden />
            New design system
            <ChevronDownIcon aria-hidden />
          </Button>
        }
      />
      <MenuPopup align="end" side="bottom" className="min-w-56">
        {offeredModes(props.canStartFromScratch === true).map(({ mode, label }) => {
          const Icon = MODE_ICONS[mode];
          return (
            <MenuItem key={mode} data-mode={mode} onClick={() => props.onNew(mode)}>
              <Icon aria-hidden />
              {label}
            </MenuItem>
          );
        })}
      </MenuPopup>
    </Menu>
  );

  const search = (
    <InputGroup className="w-44 sm:w-52">
      <InputGroupAddon>
        <SearchIcon aria-hidden />
      </InputGroupAddon>
      <InputGroupInput
        size="sm"
        type="search"
        aria-label="Search design systems"
        placeholder="Search by name"
        value={query}
        onChange={(event) => setQuery(event.target.value)}
      />
    </InputGroup>
  );

  // Proposals waiting for review come first; an empty list sits at the bottom.
  const pending = (props.proposals?.length ?? 0) > 0;
  const proposalsSection = (
    <Section title="Pending proposals" testId="design-system-proposals">
      {props.proposals === null ? (
        <p className="px-4 py-3 text-sm text-muted-foreground">Loading proposals…</p>
      ) : props.proposals.length === 0 ? (
        <p className="px-4 py-3 text-sm text-muted-foreground">
          No proposals are waiting for review.
        </p>
      ) : (
        props.proposals.map((proposal) => (
          <div
            key={proposal.id}
            data-testid="proposal-row"
            data-proposal={proposal.id}
            className="flex flex-wrap items-center gap-x-4 gap-y-1 px-4 py-3"
          >
            <div className="flex min-w-0 flex-1 flex-col gap-0.5">
              <span className="truncate text-sm text-foreground">
                {proposal.target === null ? "New: " : "Update: "}
                {proposal.name}
              </span>
              <span className="truncate text-xs text-muted-foreground">
                {proposalMeta(
                  proposal.origin,
                  ownerName(proposal.owner, props.projects),
                  proposal.createdBy,
                  proposal.createdBy.kind === "agent"
                    ? props.threadTitleFor(proposal.createdBy.threadId)
                    : null,
                )}
              </span>
            </div>
            <span className="text-xs text-muted-foreground">{countsLabel(proposal.counts)}</span>
            <Button size="xs" variant="outline" onClick={() => props.onOpenProposal(proposal)}>
              Review
            </Button>
          </div>
        ))
      )}
    </Section>
  );

  return (
    <div className="flex flex-col gap-8" data-testid="design-systems-settings">
      <p className="px-3 text-sm text-muted-foreground sm:px-4">
        Design systems give designs in SpecWithCode your real tokens and components. A project's
        systems are saved in its folder and travel with the repository; Playground systems stay on
        this machine.
      </p>

      {pending ? proposalsSection : null}

      <Section
        title="Design systems"
        testId="design-system-list"
        action={
          <>
            {search}
            {newMenu}
          </>
        }
      >
        {props.systemsError ? (
          <p role="alert" className="px-4 py-3 text-sm text-destructive-foreground">
            {props.systemsError}
          </p>
        ) : systems === null ? (
          <p className="px-4 py-3 text-sm text-muted-foreground">Loading design systems…</p>
        ) : systems.length === 0 ? (
          <p className="px-4 py-3 text-sm text-muted-foreground">
            {query.trim() === ""
              ? "No design systems yet. Start one with New design system."
              : `No design system is named like "${query.trim()}".`}
          </p>
        ) : (
          // Narrow cards fold Owner, Sources and Updated into the name cell.
          <div className="@container/systems overflow-x-auto">
            <table className="w-full text-sm">
              <thead>
                <tr className="text-left text-xs text-muted-foreground">
                  <th className="px-4 py-2 font-normal">Name</th>
                  <th className="hidden px-2 py-2 font-normal @lg/systems:table-cell">Owner</th>
                  <th className="hidden px-2 py-2 font-normal @xl/systems:table-cell">Sources</th>
                  <th className="hidden px-2 py-2 font-normal @xl/systems:table-cell">Updated</th>
                  <th className="px-4 py-2 font-normal">
                    <span className="sr-only">Actions</span>
                  </th>
                </tr>
              </thead>
              <tbody className="divide-y divide-border/50 border-t border-border/50">
                {systems.map((system) => (
                  <tr
                    key={systemKey(system)}
                    data-testid="system-row"
                    data-system={system.ref.systemId}
                  >
                    <td className="max-w-56 px-4 py-2.5">
                      <SystemName
                        system={system}
                        href={props.systemHref?.(system)}
                        onOpen={props.onOpenSystem}
                      />
                      <div className="truncate text-xs text-muted-foreground">
                        {system.tokenCount} tokens · {system.componentCount} components
                      </div>
                      <div
                        className="truncate text-xs text-muted-foreground @xl/systems:hidden"
                        data-testid="system-row-folded"
                      >
                        <span className="@lg/systems:hidden">{system.ownerLabel} · </span>
                        {editedAgo(system.updatedAt, props.now)}
                      </div>
                      {system.sources.length > 0 ? (
                        <div className="truncate text-xs text-muted-foreground @xl/systems:hidden">
                          {sourcesLabel(system.sources)}
                        </div>
                      ) : null}
                    </td>
                    <td className="hidden max-w-40 truncate px-2 py-2.5 text-foreground/90 @lg/systems:table-cell">
                      {system.ownerLabel}
                    </td>
                    <td
                      className="hidden px-2 py-2.5 text-muted-foreground @xl/systems:table-cell"
                      data-testid="system-sources"
                    >
                      {sourcesLabel(system.sources)}
                    </td>
                    <td className="hidden whitespace-nowrap px-2 py-2.5 text-muted-foreground @xl/systems:table-cell">
                      {updatedLabel(system.updatedAt, props.now)}
                    </td>
                    <td className="px-4 py-2.5">
                      <div className="flex items-center justify-end gap-1">
                        <RescanCell
                          system={system}
                          state={props.rescans[systemKey(system)]}
                          canWrite={props.canWrite}
                          onRescan={() => props.onRescan(system)}
                        />
                        <SystemRowMenu
                          system={system}
                          canWrite={props.canWrite}
                          onOpen={props.onOpenSystem}
                          onRename={props.onRenameSystem}
                          onDelete={props.onDeleteSystem}
                        />
                      </div>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
        {props.problems.length > 0 ? (
          <ul className="flex flex-col gap-1 px-4 py-3 text-xs text-muted-foreground">
            {props.problems.map((problem) => (
              <li key={problemKey(problem)}>
                {problem.ownerLabel}: {problem.detail}
              </li>
            ))}
          </ul>
        ) : null}
      </Section>
      {pending ? null : proposalsSection}
      {props.figma === undefined ? null : (
        <Section title="Sources" testId="design-system-sources">
          <FigmaDesktopRow figma={props.figma} />
        </Section>
      )}
    </div>
  );
}
