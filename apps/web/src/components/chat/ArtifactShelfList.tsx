import {
  ChevronDownIcon,
  ChevronRightIcon,
  EyeIcon,
  EyeOffIcon,
  ExternalLinkIcon,
  PinIcon,
  PinOffIcon,
} from "lucide-react";
import { type ReactNode, useState } from "react";

import {
  AGED_LABEL,
  organizeShelf,
  SHELF_SEARCH_THRESHOLD,
  type ShelfEntry,
  type ShelfSectionId,
} from "~/artifactShelf";
import { cn } from "~/lib/utils";

import { PULL_REQUEST_STATE_PRESENTATION, PullRequestGlyph } from "../pullRequest/pullRequestIcons";
import { Input } from "../ui/input";

type EntryIcon = (props: { "aria-hidden"?: boolean; className?: string }) => ReactNode;

/**
 * The artifacts list: a search field once it is long, pinned entries, a
 * section per type with the newest few, and Older and Hidden folded away.
 * Hiding is per device and only takes the entry off the list.
 */
export function ArtifactShelfList(props: {
  readonly entries: ReadonlyArray<ShelfEntry>;
  readonly iconFor: (entry: ShelfEntry) => EntryIcon;
  readonly onOpen: (entry: ShelfEntry) => void;
  readonly onPin: (entry: ShelfEntry, pinned: boolean) => void;
  readonly onHide: (entry: ShelfEntry, hidden: boolean) => void;
}) {
  const [query, setQuery] = useState("");
  const [expanded, setExpanded] = useState<ReadonlySet<ShelfSectionId>>(new Set());
  const shelf = organizeShelf(props.entries, { query, expanded });
  const toggle = (id: ShelfSectionId) =>
    setExpanded((current) => {
      const next = new Set(current);
      if (!next.delete(id)) next.add(id);
      return next;
    });
  const searchable = shelf.totalCount > SHELF_SEARCH_THRESHOLD;
  return (
    <div className="flex max-h-[min(32rem,70vh)] flex-col" data-artifact-shelf="true">
      {searchable ? (
        <div className="px-1 pb-1">
          <Input
            size="sm"
            type="search"
            autoFocus
            value={query}
            placeholder={`Search ${shelf.totalCount} artifacts`}
            aria-label="Search artifacts"
            onChange={(event) => setQuery(event.currentTarget.value)}
          />
        </div>
      ) : null}
      <div
        className="flex min-h-0 flex-1 flex-col gap-1 overflow-y-auto"
        data-artifact-shelf-scroll="true"
      >
        {shelf.sections.length === 0 || (query && shelf.sections[0]?.total === 0) ? (
          <p className="px-3 py-4 text-center text-muted-foreground text-xs">
            No artifacts match “{query}”.
          </p>
        ) : null}
        {shelf.sections.map((section) => {
          if (section.total === 0) return null;
          const open = !section.collapsible || expanded.has(section.id);
          const more = section.total - section.entries.length;
          return (
            <section key={section.id} data-artifact-section={section.id} aria-label={section.label}>
              {section.collapsible ? (
                <button
                  type="button"
                  className="flex w-full items-center gap-1 rounded-md px-2 pt-1.5 pb-1 text-left font-medium text-muted-foreground text-xs hover:bg-accent/50"
                  aria-expanded={open}
                  data-artifact-section-toggle={section.id}
                  onClick={() => toggle(section.id)}
                >
                  {open ? (
                    <ChevronDownIcon aria-hidden className="size-3.5" />
                  ) : (
                    <ChevronRightIcon aria-hidden className="size-3.5" />
                  )}
                  {section.label}
                  <span className="tabular-nums">{section.total}</span>
                </button>
              ) : section.id === "results" ? null : (
                <h3 className="flex items-center gap-1 px-2 pt-1.5 pb-1 font-medium text-muted-foreground text-xs">
                  {section.label}
                  <span className="tabular-nums">{section.total}</span>
                </h3>
              )}
              <ul className="flex flex-col">
                {section.entries.map((entry) => (
                  <ShelfRow
                    key={entry.id}
                    entry={entry}
                    Icon={props.iconFor(entry)}
                    onOpen={() => props.onOpen(entry)}
                    onPin={() => props.onPin(entry, !entry.pinned)}
                    onHide={() => props.onHide(entry, !entry.hidden)}
                  />
                ))}
              </ul>
              {!section.collapsible && (more > 0 || expanded.has(section.id)) ? (
                <button
                  type="button"
                  className="w-full rounded-md px-2 py-1 text-left text-muted-foreground text-xs hover:bg-accent/50 hover:text-foreground"
                  data-artifact-section-more={section.id}
                  onClick={() => toggle(section.id)}
                >
                  {more > 0 ? `Show all ${section.total}` : "Show fewer"}
                </button>
              ) : null}
            </section>
          );
        })}
      </div>
    </div>
  );
}

function ShelfRow(props: {
  readonly entry: ShelfEntry;
  readonly Icon: EntryIcon;
  readonly onOpen: () => void;
  readonly onPin: () => void;
  readonly onHide: () => void;
}) {
  const { entry, Icon } = props;
  const isLink = entry.artifact.kind === "link";
  const tag = entry.aged ? AGED_LABEL[entry.aged] : entry.hidden ? "Hidden" : "";
  return (
    <li
      className="group/shelf-row relative flex items-center rounded-md hover:bg-accent focus-within:bg-accent"
      data-thread-artifact-row={entry.artifact.kind}
    >
      <button
        type="button"
        className={cn(
          "flex min-w-0 flex-1 items-center gap-2 px-2 py-1.5 text-left text-sm outline-none [&_svg]:size-4 [&_svg]:shrink-0",
          (entry.aged === "missing" || entry.hidden) && "text-muted-foreground",
        )}
        data-thread-artifact={entry.artifact.kind}
        data-artifact-aged={entry.aged ?? undefined}
        onClick={props.onOpen}
      >
        <EntryGlyph entry={entry} Icon={Icon} />
        <span
          className={cn("min-w-0 flex-auto truncate", entry.aged === "missing" && "line-through")}
        >
          {entry.label}
        </span>
        {tag ? (
          <span className="shrink-0 rounded bg-muted px-1 text-3xs text-muted-foreground uppercase tracking-wide">
            {tag}
          </span>
        ) : null}
        {entry.detail ? (
          <span className="ms-auto min-w-0 max-w-[40%] shrink-[4] truncate text-muted-foreground text-xs group-hover/shelf-row:hidden group-focus-within/shelf-row:hidden">
            {entry.detail}
          </span>
        ) : null}
        {isLink ? (
          <ExternalLinkIcon
            aria-hidden
            className="text-muted-foreground group-hover/shelf-row:hidden group-focus-within/shelf-row:hidden"
          />
        ) : null}
      </button>
      <span className="hidden shrink-0 items-center gap-0.5 pe-1 group-hover/shelf-row:flex group-focus-within/shelf-row:flex">
        <RowAction
          label={entry.pinned ? `Unpin ${entry.label}` : `Pin ${entry.label}`}
          onClick={props.onPin}
          data-artifact-action="pin"
        >
          {entry.pinned ? <PinOffIcon aria-hidden /> : <PinIcon aria-hidden />}
        </RowAction>
        <RowAction
          label={
            entry.hidden ? `Show ${entry.label} in the list` : `Hide ${entry.label} from the list`
          }
          onClick={props.onHide}
          data-artifact-action="hide"
        >
          {entry.hidden ? <EyeIcon aria-hidden /> : <EyeOffIcon aria-hidden />}
        </RowAction>
      </span>
      {entry.pinned ? (
        <PinIcon
          aria-label="Pinned"
          className="pointer-events-none me-2 size-3 shrink-0 text-muted-foreground group-hover/shelf-row:hidden group-focus-within/shelf-row:hidden"
        />
      ) : null}
    </li>
  );
}

function RowAction(props: {
  readonly label: string;
  readonly onClick: () => void;
  readonly children: ReactNode;
  readonly "data-artifact-action": string;
}) {
  return (
    <button
      type="button"
      aria-label={props.label}
      data-artifact-action={props["data-artifact-action"]}
      className="inline-flex size-6 items-center justify-center rounded text-muted-foreground hover:bg-background/60 hover:text-foreground [&_svg]:size-3.5"
      onClick={props.onClick}
    >
      {props.children}
    </button>
  );
}

/** A pull request drawn by its state, as everywhere else in the app; the rest by kind. */
function EntryGlyph(props: { readonly entry: ShelfEntry; readonly Icon: EntryIcon }) {
  if (props.entry.category !== "pullRequests") return <props.Icon aria-hidden />;
  const state = props.entry.pullRequest?.state;
  if (!state) return <PullRequestGlyph.pullRequest aria-hidden className="text-muted-foreground" />;
  const { Icon, toneClassName } = PULL_REQUEST_STATE_PRESENTATION[state];
  return <Icon aria-hidden className={toneClassName} />;
}
