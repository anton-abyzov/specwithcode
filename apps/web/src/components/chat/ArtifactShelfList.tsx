import {
  CheckIcon,
  ChevronDownIcon,
  ChevronRightIcon,
  CopyIcon,
  EyeIcon,
  EyeOffIcon,
  ExternalLinkIcon,
  PinIcon,
} from "lucide-react";
import { type ReactNode, type Ref, useEffect, useId, useRef, useState } from "react";

import {
  AGED_LABEL,
  formatShelfTime,
  organizeShelf,
  SHELF_SEARCH_THRESHOLD,
  shelfStateLabel,
  type ShelfEntry,
  type ShelfSectionId,
} from "~/artifactShelf";
import { useCopyToClipboard } from "~/hooks/useCopyToClipboard";
import { cn } from "~/lib/utils";
import { NATIVE_NO_LINK_NOTE, NATIVE_REMOTE_NOTE, nativeVersionLabel } from "~/nativeArtifacts";

import { PULL_REQUEST_STATE_PRESENTATION, PullRequestGlyph } from "../pullRequest/pullRequestIcons";
import { Input } from "../ui/input";
import { Tooltip, TooltipPopup } from "../ui/tooltip";

type EntryIcon = (props: { "aria-hidden"?: boolean; className?: string }) => ReactNode;

/** What to focus once a row moves: after a hide the row is gone, so the next one. */
type FocusRequest =
  | { readonly id: string; readonly target: "open" | "pin" }
  | { readonly section: ShelfSectionId };

/** A hover waits this long before the full path shows; focus shows it at once. */
const PATH_HOVER_DELAY_MS = 500;

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
  /** When the list opened: rows date against it. */
  readonly now?: number | undefined;
  /** Said above the sections, such as the machine being offline. */
  readonly notice?: string | null | undefined;
}) {
  const [query, setQuery] = useState("");
  const [expanded, setExpanded] = useState<ReadonlySet<ShelfSectionId>>(new Set());
  const [focus, setFocus] = useState<FocusRequest | null>(null);
  const toggles = useRef(new Map<ShelfSectionId, HTMLButtonElement | null>());
  const shelf = organizeShelf(props.entries, { query, expanded });
  const now = props.now ?? Date.now();
  const toggle = (id: ShelfSectionId) =>
    setExpanded((current) => {
      const next = new Set(current);
      if (!next.delete(id)) next.add(id);
      return next;
    });
  const shown = shelf.sections.flatMap((section) => section.entries);
  const hide = (entry: ShelfEntry) => {
    const index = shown.findIndex((candidate) => candidate.id === entry.id);
    const next = shown[index + 1] ?? shown[index - 1];
    setFocus(next ? { id: next.id, target: "open" } : { section: "hidden" });
    props.onHide(entry, !entry.hidden);
  };
  useEffect(() => {
    if (focus === null || !("section" in focus)) return;
    toggles.current.get(focus.section)?.focus();
    setFocus(null);
  }, [focus]);
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
      {props.notice ? (
        <p
          className="mx-1 mb-1 rounded-md bg-muted px-2 py-1.5 text-muted-foreground text-xs"
          role="status"
          data-artifact-shelf-notice="true"
        >
          {props.notice}
        </p>
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
                  ref={(node) => {
                    toggles.current.set(section.id, node);
                  }}
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
                    now={now}
                    focus={focus && "id" in focus && focus.id === entry.id ? focus.target : null}
                    onFocused={() => setFocus(null)}
                    onOpen={() => props.onOpen(entry)}
                    onPin={() => {
                      // The row moves to or from Pinned; its pin keeps focus there.
                      setFocus({ id: entry.id, target: "pin" });
                      props.onPin(entry, !entry.pinned);
                    }}
                    onHide={() => hide(entry)}
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

/** Shows the full path beside a row on keyboard focus at once, and on hover after a pause. */
function usePathPopup() {
  const [open, setOpen] = useState(false);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const clear = () => {
    if (timer.current !== null) clearTimeout(timer.current);
    timer.current = null;
  };
  useEffect(() => clear, []);
  return {
    open,
    handlers: {
      onFocus: () => {
        clear();
        setOpen(true);
      },
      onBlur: () => {
        clear();
        setOpen(false);
      },
      onMouseEnter: () => {
        clear();
        timer.current = setTimeout(() => setOpen(true), PATH_HOVER_DELAY_MS);
      },
      onMouseLeave: () => {
        clear();
        setOpen(false);
      },
    },
  };
}

function ShelfRow(props: {
  readonly entry: ShelfEntry;
  readonly Icon: EntryIcon;
  readonly now: number;
  readonly focus: "open" | "pin" | null;
  readonly onFocused: () => void;
  readonly onOpen: () => void;
  readonly onPin: () => void;
  readonly onHide: () => void;
}) {
  const { entry, Icon } = props;
  const kind = entry.artifact.kind;
  const native = entry.artifact.kind === "native" ? entry.artifact.native : null;
  // A published page whose result named another site has no link to open.
  const openable = native === null || native.url !== null;
  const opensInBrowser = (kind === "link" || kind === "native") && openable;
  const missing = entry.aged === "missing";
  const stateLabel = shelfStateLabel(entry);
  const tag =
    (entry.aged ? AGED_LABEL[entry.aged] : "") || stateLabel || (entry.hidden ? "Hidden" : "");
  const openRef = useRef<HTMLButtonElement>(null);
  const pinRef = useRef<HTMLButtonElement>(null);
  const describedBy = useId();
  const path = usePathPopup();
  const { copyToClipboard, isCopied } = useCopyToClipboard({ preserveBytes: true });
  useEffect(() => {
    if (props.focus === null) return;
    (props.focus === "pin" ? pinRef : openRef).current?.focus();
    props.onFocused();
  }, [props.focus]);
  const note =
    native === null ? null : native.url !== null ? NATIVE_REMOTE_NOTE : NATIVE_NO_LINK_NOTE;
  const source = entry.inherited
    ? `From ${entry.inherited.machineLabel ?? "the earlier machine"}`
    : (entry.source?.label ?? null);
  const at = entry.mentionedAt;
  // Where it is: the folder takes what the line has left and always keeps its last name.
  const meta: ReactNode[] = [];
  const version = native === null ? null : nativeVersionLabel(native);
  if (version !== null) {
    meta.push(
      <span key="version" className="shrink-0" data-artifact-version="true">
        {version}
      </span>,
    );
  }
  if (entry.folder) {
    meta.push(
      <span key="folder" className="flex min-w-0 shrink" data-artifact-folder={entry.folder.full}>
        {/* Only the head gives way; the last folder is cut only when it alone is too long. */}
        {entry.folder.head ? <span className="min-w-0 truncate">{entry.folder.head}</span> : null}
        <span className="max-w-full shrink-0 truncate">{entry.folder.tail}</span>
      </span>,
    );
  } else if (entry.detail) {
    meta.push(
      <span key="detail" className="min-w-0 shrink truncate">
        {entry.detail}
      </span>,
    );
  }
  // Where it came from and when: the message, or for a published page where its link opens.
  const origin: ReactNode[] = [];
  if (note) {
    origin.push(
      // Read out once, with the path, through the description.
      <span key="note" aria-hidden className="min-w-0 shrink truncate" data-artifact-note="true">
        {note}
      </span>,
    );
  } else if (source) {
    origin.push(
      <span key="source" className="min-w-0 shrink truncate" data-artifact-source="true">
        {source}
      </span>,
    );
  }
  if (at !== null) {
    origin.push(
      <time key="time" className="shrink-0 tabular-nums" dateTime={new Date(at).toISOString()}>
        {formatShelfTime(at, props.now)}
      </time>,
    );
  }
  // Why a file is in the state it is, on a line of its own so it reads whole.
  const reason = entry.stateReason
    ? [
        <span key="reason" className="min-w-0 truncate" data-artifact-reason="true">
          {entry.stateReason}
        </span>,
      ]
    : [];
  const description = [entry.fullPath, note].filter(Boolean).join(". ");
  // Hidden from sight until the row is hovered or focused, never from the keyboard or touch.
  const revealed =
    "opacity-0 focus-visible:opacity-100 group-hover/shelf-row:opacity-100 group-focus-within/shelf-row:opacity-100 pointer-coarse:opacity-100";
  return (
    <li
      className="group/shelf-row relative flex items-start rounded-md hover:bg-accent focus-within:bg-accent"
      data-thread-artifact-row={kind}
      data-artifact-state={entry.fileState ?? undefined}
    >
      <button
        ref={openRef}
        type="button"
        className={cn(
          // The actions sit over the row's end, so a narrow list keeps the name; only
          // what always shows (a pinned pin, or every action on touch) has room kept.
          "flex min-w-0 flex-1 flex-col gap-0.5 px-2 py-1.5 text-left outline-none pointer-coarse:pe-28",
          entry.pinned && "pe-8",
          (missing || entry.hidden) && "text-muted-foreground",
        )}
        data-thread-artifact={kind}
        data-artifact-aged={entry.aged ?? undefined}
        aria-describedby={description ? describedBy : undefined}
        aria-disabled={openable ? undefined : true}
        onClick={openable ? props.onOpen : undefined}
        {...path.handlers}
      >
        <span className="flex w-full min-w-0 items-center gap-2 text-sm [&_svg]:size-4 [&_svg]:shrink-0">
          <EntryGlyph entry={entry} Icon={Icon} />
          <span className="shrink-0 text-muted-foreground text-xs" data-artifact-kind="true">
            {entry.kindLabel}
          </span>
          <span className={cn("min-w-0 flex-auto truncate", missing && "line-through")}>
            {entry.label}
          </span>
          {tag ? (
            <span
              className="shrink-0 rounded bg-muted px-1 text-3xs text-muted-foreground uppercase tracking-wide"
              data-artifact-tag="true"
            >
              {tag}
            </span>
          ) : null}
          {opensInBrowser ? (
            <ExternalLinkIcon aria-hidden className="text-muted-foreground" />
          ) : null}
        </span>
        <MetaLine parts={meta} data-artifact-meta="true" />
        <MetaLine parts={origin} data-artifact-origin="true" />
        <MetaLine parts={reason} />
      </button>
      {description ? (
        <span id={describedBy} className="sr-only">
          {description}
        </span>
      ) : null}
      <span className="absolute end-1 top-1 flex items-center gap-0.5 rounded group-hover/shelf-row:bg-accent group-focus-within/shelf-row:bg-accent">
        <RowAction
          ref={pinRef}
          // One name; the pressed state says whether it is pinned.
          label={`Pin ${entry.label}`}
          pressed={entry.pinned}
          className={entry.pinned ? undefined : revealed}
          onClick={props.onPin}
          data-artifact-action="pin"
        >
          {entry.pinned ? (
            <PinIcon aria-hidden className="fill-current" />
          ) : (
            <PinIcon aria-hidden />
          )}
        </RowAction>
        <RowAction
          label={
            entry.hidden ? `Show ${entry.label} in the list` : `Hide ${entry.label} from the list`
          }
          className={revealed}
          onClick={props.onHide}
          data-artifact-action="hide"
        >
          {entry.hidden ? <EyeIcon aria-hidden /> : <EyeOffIcon aria-hidden />}
        </RowAction>
        {entry.fullPath ? (
          <RowAction
            label={
              isCopied
                ? "Copied"
                : kind === "link"
                  ? `Copy the link to ${entry.label}`
                  : `Copy the path of ${entry.label}`
            }
            className={isCopied ? undefined : revealed}
            onClick={() => copyToClipboard(entry.fullPath!, undefined)}
            data-artifact-action="copy"
          >
            {isCopied ? <CheckIcon aria-hidden /> : <CopyIcon aria-hidden />}
          </RowAction>
        ) : null}
      </span>
      {entry.fullPath ? (
        <Tooltip open={path.open}>
          <TooltipPopup anchor={openRef} side="bottom" align="start" variant="code">
            <span data-artifact-full-path="true">{entry.fullPath}</span>
            {native?.url ? <span className="block">{native.url}</span> : null}
            {note ? <span className="block font-sans">{note}</span> : null}
          </TooltipPopup>
        </Tooltip>
      ) : null}
    </li>
  );
}

/** One line of row details, dot-separated; each part truncates on its own. */
function MetaLine(props: {
  readonly parts: ReadonlyArray<ReactNode>;
  readonly "data-artifact-meta"?: "true";
  readonly "data-artifact-origin"?: "true";
}) {
  if (props.parts.length === 0) return null;
  return (
    <span
      className="flex w-full min-w-0 items-center gap-1 ps-6 text-muted-foreground text-xs"
      data-artifact-meta={props["data-artifact-meta"]}
      data-artifact-origin={props["data-artifact-origin"]}
    >
      {props.parts.flatMap((part, index) =>
        index === 0
          ? [part]
          : [
              <span key={`dot-${index}`} aria-hidden className="shrink-0">
                ·
              </span>,
              part,
            ],
      )}
    </span>
  );
}

function RowAction(props: {
  readonly label: string;
  readonly onClick: () => void;
  readonly children: ReactNode;
  readonly "data-artifact-action": string;
  readonly pressed?: boolean | undefined;
  readonly className?: string | undefined;
  readonly ref?: Ref<HTMLButtonElement> | undefined;
}) {
  return (
    <button
      ref={props.ref}
      type="button"
      aria-label={props.label}
      aria-pressed={props.pressed}
      data-artifact-action={props["data-artifact-action"]}
      className={cn(
        "inline-flex size-6 items-center justify-center rounded text-muted-foreground hover:bg-background/60 hover:text-foreground pointer-coarse:size-8 [&_svg]:size-3.5",
        props.className,
      )}
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
