/**
 * What every token table row shares: the monospace name with inline rename,
 * the usage-notes popover, Remove on hover, and the row menu (right-click or
 * long-press) with Edit, Rename…, Copy, Copy value, Remove and Go to target.
 */
import { ContextMenu } from "@base-ui/react/context-menu";
import type { DesignSystem, DesignToken } from "@specweave-studio/contracts";
import {
  ArrowUpRightIcon,
  ClipboardIcon,
  CopyIcon,
  PencilIcon,
  StickyNoteIcon,
  TextCursorInputIcon,
  Trash2Icon,
} from "lucide-react";
import {
  createContext,
  useContext,
  useEffect,
  useId,
  useLayoutEffect,
  useRef,
  useState,
  type ComponentProps,
  type CSSProperties,
  type KeyboardEvent,
  type ReactNode,
} from "react";

import { cn } from "~/lib/utils";

import { Button } from "../../../ui/button";
import { MenuItem, MenuPopup, MenuSeparator } from "../../../ui/menu";
import { Popover, PopoverPopup, PopoverTitle, PopoverTrigger } from "../../../ui/popover";
import { Textarea } from "../../../ui/textarea";
import { copyText } from "./pageActions";
import type { SystemEditIntent } from "./systemEditIntents";
import { tokenNameProblem } from "./tokenValues";

/** What every token table receives from the page. */
export interface TokenTableProps {
  readonly system: DesignSystem;
  readonly canEdit: boolean;
  readonly onEdit: (intent: SystemEditIntent) => Promise<boolean>;
  /** Scrolls to a token and flashes it. */
  readonly onGoTo: (name: string) => void;
}

/** The page's side inset: section titles, table rows and empty states line up on it. */
export const INSET = "px-5 sm:px-7";
export const ROW =
  "group/row grid min-h-12 items-center gap-x-4 border-t border-border/50 px-5 py-2 sm:px-7 transition-colors duration-500 ease-out-quint hover:bg-accent/30 data-[flash=true]:bg-primary/14 data-[flash=true]:duration-150 motion-reduce:transition-none";
export const HEADER_ROW =
  "grid items-end gap-x-4 border-t border-border/50 px-5 pt-3 pb-2.5 sm:px-7 text-xs font-normal text-muted-foreground";
/** A table's own heading inside a section ("Palette", "Display"). */
export const TABLE_TITLE = "flex items-center gap-2 px-5 pb-2.5 sm:px-7";
/** The right gutter: usage notes and Remove. */
export const GUTTER = "4.25rem";

/** A token table's scroller is a size container, for pieces that follow its width in CSS. */
export const TOKENS_CONTAINER = "@container/tokens";

/** Whether the table around a row is under 42rem wide, from its TokensScroller. */
const NarrowTable = createContext(false);

/** True inside a token table under 42rem wide. */
export const useNarrowTable = () => useContext(NarrowTable);

/**
 * A token table's sideways scroller. Under 42rem its rows that have a narrow
 * layout switch to it: the name cell spans the first line with the row's
 * actions in it, and the value cells get the whole line under it, so focus
 * follows what is seen. Measured before paint and on every resize.
 */
export function TokensScroller({ className, children, ...rest }: ComponentProps<"div">) {
  const ref = useRef<HTMLDivElement>(null);
  const [narrow, setNarrow] = useState(false);
  useLayoutEffect(() => {
    const element = ref.current;
    if (element === null) return;
    const measure = () => {
      const rem = Number.parseFloat(getComputedStyle(document.documentElement).fontSize) || 16;
      setNarrow(element.getBoundingClientRect().width < 42 * rem);
    };
    measure();
    if (typeof ResizeObserver === "undefined") return;
    const observer = new ResizeObserver(measure);
    observer.observe(element);
    return () => observer.disconnect();
  }, []);
  return (
    <NarrowTable.Provider value={narrow}>
      <div ref={ref} className={cn(TOKENS_CONTAINER, "overflow-x-auto", className)} {...rest}>
        {children}
      </div>
    </NarrowTable.Provider>
  );
}

/** The row grid: the narrow columns inside a narrow table, when the table has them. */
function useGrid(columns: string, narrowColumns: string | undefined) {
  const narrow = useContext(NarrowTable) && narrowColumns !== undefined;
  return {
    narrow,
    className: narrow ? "gap-x-2 gap-y-1.5" : undefined,
    style: { gridTemplateColumns: narrow ? narrowColumns : columns } as CSSProperties,
  };
}

export function TableHeader({
  columns,
  narrowColumns,
  labels,
}: {
  columns: string;
  /** The narrow layout's value columns, without the name or actions (see gridColumns). */
  narrowColumns?: string | undefined;
  labels: readonly string[];
}) {
  const grid = useGrid(columns, narrowColumns);
  return (
    <div role="row" className={cn(HEADER_ROW, grid.className)} style={grid.style}>
      {labels.map((label, index) => (
        <span
          key={label}
          role="columnheader"
          className={cn("truncate", index === 0 && grid.narrow && "sr-only")}
        >
          {label}
        </span>
      ))}
      <span role="columnheader" className="sr-only">
        Actions
      </span>
    </div>
  );
}

/** Focuses or opens the row's first editor, as the row menu's Edit does. */
function editRow(row: HTMLElement | null) {
  const target = row?.querySelector<HTMLElement>("[data-row-edit]");
  if (target === null || target === undefined) return;
  if (target instanceof HTMLInputElement || target instanceof HTMLTextAreaElement) {
    target.focus();
    target.select();
  } else {
    target.click();
  }
}

export interface TokenRowProps extends TokenTableProps {
  readonly token: DesignToken;
  readonly columns: string;
  /** The narrow layout's value columns, without the name or actions (see gridColumns). */
  readonly narrowColumns?: string | undefined;
  /** The value cells, after the name. */
  readonly children: ReactNode;
  /** The first mode's value, for Copy value. */
  readonly copyValue: string | null;
  /** The token this one aliases, for Go to target. */
  readonly aliasOf?: string | null;
  /** The note the popover shows and edits; the token's description when omitted. */
  readonly note?: string;
  readonly onSaveNote?: (text: string) => void;
  readonly nameSuffix?: ReactNode;
}

export function TokenRow(props: TokenRowProps) {
  const { token, canEdit } = props;
  const rowRef = useRef<HTMLDivElement>(null);
  const [renaming, setRenaming] = useState(false);
  const note = props.note ?? token.description ?? "";
  const saveNote =
    props.onSaveNote ??
    ((text: string) => void props.onEdit({ kind: "set-usage", name: token.name, text }));
  const remove = () => void props.onEdit({ kind: "remove", name: token.name });
  const aliasOf = props.aliasOf ?? null;
  const grid = useGrid(props.columns, props.narrowColumns);
  const narrow = grid.narrow;
  // The notes popover's state lives here, so it survives the actions moving between layouts.
  const [notesOpen, setNotesOpen] = useState(false);
  const [notesDraft, setNotesDraft] = useState(note);
  const actions = (
    <>
      <UsageNotes
        name={token.name}
        note={note}
        canEdit={canEdit}
        onSave={saveNote}
        state={{
          open: notesOpen,
          setOpen: setNotesOpen,
          draft: notesDraft,
          setDraft: setNotesDraft,
        }}
      />
      {canEdit ? (
        <Button
          variant="ghost-destructive"
          size="icon-xs"
          aria-label={`Remove ${token.name}`}
          className="opacity-0 transition-opacity duration-[120ms] group-hover/row:opacity-100 focus-visible:opacity-100 pointer-coarse:opacity-100"
          onClick={remove}
        >
          <Trash2Icon aria-hidden />
        </Button>
      ) : null}
    </>
  );

  return (
    <ContextMenu.Root>
      <ContextMenu.Trigger
        render={
          <div
            ref={rowRef}
            role="row"
            data-token-row={token.name}
            data-testid="token-row"
            className={cn(ROW, grid.className)}
            style={grid.style}
          />
        }
      >
        <div
          role="cell"
          className={
            narrow
              ? "col-span-full flex min-w-0 items-start gap-2"
              : "flex min-w-0 flex-col gap-0.5"
          }
        >
          <div className={narrow ? "flex min-w-0 flex-1 flex-col gap-0.5" : "contents"}>
            <TokenName
              name={token.name}
              canEdit={canEdit}
              renaming={renaming}
              existing={props.system.tokens.map((candidate) => candidate.name)}
              onStartRename={() => setRenaming(true)}
              onRename={(to) => {
                setRenaming(false);
                if (to !== token.name) void props.onEdit({ kind: "rename", from: token.name, to });
              }}
              onCancel={() => setRenaming(false)}
            />
            {props.nameSuffix}
          </div>
          {narrow ? <div className="flex shrink-0 items-center gap-0.5">{actions}</div> : null}
        </div>
        {props.children}
        {narrow ? null : (
          <div role="cell" className="flex items-center justify-end gap-0.5">
            {actions}
          </div>
        )}
      </ContextMenu.Trigger>
      <MenuPopup className="min-w-44" data-testid="token-row-menu">
        {canEdit ? (
          <>
            <MenuItem onClick={() => editRow(rowRef.current)}>
              <PencilIcon aria-hidden />
              Edit
            </MenuItem>
            <MenuItem onClick={() => setRenaming(true)}>
              <TextCursorInputIcon aria-hidden />
              Rename…
            </MenuItem>
          </>
        ) : null}
        <MenuItem onClick={() => void copyText(`var(--${token.name})`)}>
          <CopyIcon aria-hidden />
          Copy
        </MenuItem>
        {props.copyValue !== null ? (
          <MenuItem onClick={() => void copyText(props.copyValue!)}>
            <ClipboardIcon aria-hidden />
            Copy value
          </MenuItem>
        ) : null}
        {aliasOf !== null ? (
          <MenuItem onClick={() => props.onGoTo(aliasOf)}>
            <ArrowUpRightIcon aria-hidden />
            Go to target
          </MenuItem>
        ) : null}
        {canEdit ? (
          <>
            <MenuSeparator />
            <MenuItem variant="destructive" onClick={remove}>
              <Trash2Icon aria-hidden />
              Remove
            </MenuItem>
          </>
        ) : null}
      </MenuPopup>
    </ContextMenu.Root>
  );
}

/** The monospace name; editors click it to rename in place. */
/** How many designs use this system, for the rename warning; null while unknown. */
export const SystemUsageContext = createContext<number | null>(null);

export function TokenName({
  name,
  canEdit,
  renaming,
  existing,
  onStartRename,
  onRename,
  onCancel,
}: {
  name: string;
  canEdit: boolean;
  renaming: boolean;
  existing: readonly string[];
  onStartRename: () => void;
  onRename: (name: string) => void;
  onCancel: () => void;
}) {
  if (renaming)
    return <RenameField name={name} existing={existing} onRename={onRename} onCancel={onCancel} />;
  const label = <span className="truncate font-mono text-[13px] text-foreground">{name}</span>;
  if (!canEdit)
    return (
      <span className="flex min-w-0" title={name}>
        {label}
      </span>
    );
  return (
    <button
      type="button"
      title={`Rename ${name}`}
      className="-mx-1 flex min-w-0 max-w-full rounded-sm px-1 text-left outline-none transition-colors duration-[120ms] hover:bg-accent focus-visible:ring-2 focus-visible:ring-ring"
      onClick={onStartRename}
    >
      {label}
    </button>
  );
}

function RenameField({
  name,
  existing,
  onRename,
  onCancel,
}: {
  name: string;
  existing: readonly string[];
  onRename: (name: string) => void;
  onCancel: () => void;
}) {
  const [draft, setDraft] = useState(name);
  const errorId = useId();
  const warningId = useId();
  const usage = useContext(SystemUsageContext);
  const problem = tokenNameProblem(draft, existing, name);
  // Designs keep the old name, so a rename used anywhere warns first.
  const warning =
    usage !== null && usage > 0
      ? `${usage === 1 ? "1 design uses" : `${usage} designs use`} this system. Any that name ${name} keep the old name and lose its value.`
      : null;
  const commit = () => {
    if (problem === null) onRename(draft.trim());
  };
  const onKeyDown = (event: KeyboardEvent<HTMLInputElement>) => {
    if (event.key === "Enter") {
      event.preventDefault();
      commit();
    } else if (event.key === "Escape") {
      event.preventDefault();
      event.stopPropagation();
      onCancel();
    }
  };
  return (
    <div className="flex min-w-0 flex-col gap-1">
      <input
        autoFocus
        aria-label={`New name for ${name}`}
        aria-invalid={problem !== null}
        aria-describedby={problem !== null ? errorId : warning !== null ? warningId : undefined}
        value={draft}
        spellCheck={false}
        className="h-7 w-full min-w-0 rounded-md border border-input bg-background px-1.5 font-mono text-[13px] outline-none focus-visible:border-ring focus-visible:ring-2 focus-visible:ring-ring/30 aria-invalid:border-destructive/60"
        onChange={(event) => setDraft(event.target.value)}
        onKeyDown={onKeyDown}
        onBlur={() => (problem === null ? commit() : onCancel())}
      />
      {problem !== null ? (
        <span id={errorId} role="alert" className="text-destructive-foreground text-xs">
          {problem}
        </span>
      ) : warning !== null ? (
        <span id={warningId} data-testid="rename-warning" className="text-muted-foreground text-xs">
          {warning}
        </span>
      ) : null}
    </div>
  );
}

/** The usage-notes popover; read-only viewers see it only when a note exists. */
export interface NotesState {
  readonly open: boolean;
  readonly setOpen: (open: boolean) => void;
  readonly draft: string;
  readonly setDraft: (draft: string) => void;
}

export function UsageNotes({
  name,
  note,
  canEdit,
  onSave,
  state,
}: {
  name: string;
  note: string;
  canEdit: boolean;
  onSave: (text: string) => void;
  /** State held by the caller, so it outlives this trigger; its own otherwise. */
  state?: NotesState;
}) {
  const [ownOpen, setOwnOpen] = useState(false);
  const [ownDraft, setOwnDraft] = useState(note);
  const { open, setOpen, draft, setDraft } = state ?? {
    open: ownOpen,
    setOpen: setOwnOpen,
    draft: ownDraft,
    setDraft: setOwnDraft,
  };
  const has = note.trim() !== "";
  const gone = !canEdit && !has;
  // With no trigger left to close it, a popover open when its note vanished would reopen later on its own.
  useEffect(() => {
    if (gone && open) setOpen(false);
  }, [gone, open, setOpen]);
  if (gone) return <span aria-hidden className="size-7 sm:size-6" />;
  const title = has || !canEdit ? "Usage notes" : "Add usage notes";
  return (
    <Popover
      open={open}
      onOpenChange={(next) => {
        if (next) setDraft(note);
        else if (canEdit && draft.trim() !== note.trim()) onSave(draft);
        setOpen(next);
      }}
    >
      <PopoverTrigger
        render={
          <Button
            variant="ghost"
            size="icon-xs"
            aria-label={`${title} for ${name}`}
            title={title}
            data-has-note={has}
            className={cn(
              !has &&
                "opacity-0 transition-opacity duration-[120ms] group-hover/row:opacity-100 focus-visible:opacity-100 data-popup-open:opacity-100 pointer-coarse:opacity-100",
            )}
          />
        }
      >
        <StickyNoteIcon aria-hidden className={has ? "text-foreground" : undefined} />
      </PopoverTrigger>
      <PopoverPopup width="md" align="end" padding="compact">
        <div className="flex flex-col gap-2 py-1">
          <PopoverTitle>{title}</PopoverTitle>
          <p className="font-mono text-muted-foreground text-xs">{name}</p>
          {canEdit ? (
            <Textarea
              size="sm"
              aria-label={`Usage notes for ${name}`}
              placeholder="When to use it, and when not to…"
              value={draft}
              maxLength={2_000}
              onChange={(event) => setDraft(event.target.value)}
            />
          ) : (
            <p className="whitespace-pre-wrap text-sm text-foreground">{note}</p>
          )}
        </div>
      </PopoverPopup>
    </Popover>
  );
}

/** A section's empty state: what goes here, and "+ Add" for editors. */
export function EmptyTokens({ children }: { children: ReactNode }) {
  return <p className={cn("py-6 text-sm text-muted-foreground", INSET)}>{children}</p>;
}
