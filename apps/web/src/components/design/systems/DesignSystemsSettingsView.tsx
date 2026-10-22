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
  FigmaIcon,
  FileCode2Icon,
  FileJsonIcon,
  MessageSquareTextIcon,
  PlusIcon,
  RefreshCwIcon,
  SearchIcon,
} from "lucide-react";
import { useState, type ComponentType, type ReactNode } from "react";

import { SettingsGroup } from "../../settings/SettingsGroup";
import { Button } from "../../ui/button";
import { InputGroup, InputGroupAddon, InputGroupInput } from "../../ui/input-group";
import { Menu, MenuItem, MenuPopup, MenuTrigger } from "../../ui/menu";
import { editedAgo } from "../gallery/galleryModel";
import {
  NEW_SYSTEM_MODES,
  type FigmaStatusView,
  type NewSystemMode,
} from "./NewDesignSystemDialog";
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
  problems: readonly { ownerLabel: string; detail: string }[];
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
        <div className="flex items-center gap-2">{action}</div>
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
        {NEW_SYSTEM_MODES.map(({ mode, label }) => {
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
          <div className="overflow-x-auto">
            <table className="w-full text-sm">
              <thead>
                <tr className="text-left text-xs text-muted-foreground">
                  <th className="px-4 py-2 font-normal">Name</th>
                  <th className="px-2 py-2 font-normal">Owner</th>
                  <th className="px-2 py-2 font-normal">Sources</th>
                  <th className="px-2 py-2 font-normal">Updated</th>
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
                      <div className="truncate text-foreground">{system.name}</div>
                      <div className="truncate text-xs text-muted-foreground">
                        {system.tokenCount} tokens · {system.componentCount} components
                      </div>
                    </td>
                    <td className="max-w-40 truncate px-2 py-2.5 text-foreground/90">
                      {system.ownerLabel}
                    </td>
                    <td className="px-2 py-2.5 text-muted-foreground" data-testid="system-sources">
                      {sourcesLabel(system.sources)}
                    </td>
                    <td className="whitespace-nowrap px-2 py-2.5 text-muted-foreground">
                      {updatedLabel(system.updatedAt, props.now)}
                    </td>
                    <td className="px-4 py-2.5">
                      <RescanCell
                        system={system}
                        state={props.rescans[systemKey(system)]}
                        canWrite={props.canWrite}
                        onRescan={() => props.onRescan(system)}
                      />
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
              <li key={problem.ownerLabel}>
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
