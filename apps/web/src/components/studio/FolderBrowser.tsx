import { useEffect, useId, useMemo, useRef, useState } from "react";
import {
  ChevronRightIcon,
  ClockIcon,
  EllipsisIcon,
  EyeIcon,
  EyeOffIcon,
  FolderCheckIcon,
  FolderGit2Icon,
  FolderIcon,
  FolderPlusIcon,
  HouseIcon,
  TextCursorInputIcon,
} from "lucide-react";
import { squashAtomCommandFailure } from "@specweave-studio/client-runtime/state/runtime";
import { folderNameProblem, type EnvironmentId } from "@specweave-studio/contracts";
import { filesystemEnvironment, useFilesystemReadAccess } from "../../state/filesystem";
import { useEnvironmentQuery } from "../../state/query";
import { useAtomCommand } from "../../state/use-atom-command";
import { cn } from "../../lib/utils";
import { PathField } from "./PathField";
import { cleanPastedPath, typedDirectory } from "./pathField.logic";
import { Tooltip, TooltipPopup, TooltipTrigger } from "../ui/tooltip";
import {
  collapseCrumbs,
  parentFolderOf,
  pathCrumbs,
  projectAt,
  sameFolder,
  typeAheadIndex,
  withSeparator,
  type FolderPlace,
  type KnownProject,
} from "./folderBrowser.logic";

export type { FolderPlace } from "./folderBrowser.logic";

export interface FolderListing {
  readonly path: string;
  readonly homePath: string | null;
  readonly entries: ReadonlyArray<{
    readonly name: string;
    readonly fullPath: string;
    readonly kind?: "folder" | "git" | undefined;
    /** A link to a folder elsewhere. */
    readonly link?: boolean | undefined;
  }>;
}

/** The error's own words; String() of an error object would prefix its class name. */
function errorText(error: unknown): string {
  if (
    error instanceof Error ||
    (typeof error === "object" && error !== null && "message" in error)
  ) {
    const message = (error as { message?: unknown }).message;
    if (typeof message === "string" && message.trim()) return message;
  }
  return String(error);
}

const NO_PLACES: readonly FolderPlace[] = [];
const NO_PROJECTS: readonly KnownProject[] = [];
const NO_NAMES: readonly string[] = [];
const PLACE_ICONS = { projects: FolderIcon, home: HouseIcon, recent: ClockIcon } as const;
const ROW =
  "flex w-full items-center gap-2.5 rounded-md px-2 py-1.5 text-left text-sm outline-none motion-safe:transition-colors";
const TOOL =
  "inline-flex shrink-0 items-center gap-1.5 rounded-md px-2 py-1 text-xs text-muted-foreground outline-none hover:bg-muted hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring disabled:opacity-50 motion-safe:transition-colors";

/** Places to jump to beside a folder list: suggested folders, then recent ones. */
export function FolderPlaces({
  places,
  currentPath,
  disabled = false,
  onOpen,
}: {
  readonly places: readonly FolderPlace[];
  readonly currentPath: string | null;
  readonly disabled?: boolean;
  readonly onOpen: (path: string) => void;
}) {
  return (
    <div
      role="group"
      aria-label="Places"
      className="flex gap-0.5 overflow-x-auto border-b p-1.5 sm:flex-col sm:overflow-visible sm:border-r sm:border-b-0"
    >
      {places.map((place, index) => {
        const Icon = PLACE_ICONS[place.kind];
        const recent = place.kind === "recent";
        const heading =
          index === 0
            ? recent
              ? "Recent"
              : "Suggested"
            : recent && places[index - 1]!.kind !== "recent"
              ? "Recent"
              : null;
        return (
          <div key={`${place.kind}:${place.path}`} className="contents">
            {heading ? (
              <p className="hidden px-2 pt-1.5 pb-0.5 text-xs text-muted-foreground first:pt-0.5 sm:block">
                {heading}
              </p>
            ) : null}
            <button
              type="button"
              disabled={disabled}
              aria-current={
                currentPath !== null && sameFolder(currentPath, place.path) ? "true" : undefined
              }
              onClick={() => onOpen(place.path)}
              className={cn(
                ROW,
                "w-auto shrink-0 py-1 hover:bg-muted focus-visible:ring-2 focus-visible:ring-ring aria-[current=true]:bg-muted sm:w-full",
              )}
            >
              <Icon className="size-3.5 shrink-0 text-muted-foreground" aria-hidden />
              <span className="truncate">{place.label}</span>
            </button>
          </div>
        );
      })}
    </div>
  );
}

/**
 * The rows of a folder list, marking repositories and existing projects. The
 * owner decides what selects a row: `onHover` is left out where the pointer
 * must not change what Enter does.
 */
export function FolderRows({
  listId,
  entries,
  active,
  projects,
  disabled = false,
  onHover,
  onOpen,
}: {
  readonly listId: string;
  readonly entries: FolderListing["entries"];
  readonly active: number | null;
  readonly projects: readonly KnownProject[];
  readonly disabled?: boolean;
  readonly onHover?: (index: number) => void;
  readonly onOpen: (path: string) => void;
}) {
  return entries.map((entry, index) => {
    const project = projectAt(entry.fullPath, projects);
    const Icon = project ? FolderCheckIcon : entry.kind === "git" ? FolderGit2Icon : FolderIcon;
    return (
      <button
        type="button"
        role="option"
        id={`${listId}-${index}`}
        data-row={index}
        key={entry.fullPath}
        tabIndex={-1}
        aria-selected={index === active}
        disabled={disabled}
        onMouseEnter={onHover ? () => onHover(index) : undefined}
        onClick={() => onOpen(entry.fullPath)}
        className={cn(ROW, "group aria-selected:bg-muted", !onHover && "hover:bg-muted/50")}
      >
        <Icon
          aria-hidden
          className={cn(
            "size-4 shrink-0",
            project
              ? "text-primary"
              : entry.kind === "git"
                ? "text-foreground"
                : "text-muted-foreground",
          )}
        />
        <span className="min-w-0 flex-1 truncate">{entry.name}</span>
        {project || entry.kind === "git" || entry.link ? (
          <span className="max-w-[45%] shrink-0 truncate text-xs text-muted-foreground">
            {[
              project
                ? `Project: ${project.title}`
                : entry.kind === "git"
                  ? "Git repository"
                  : null,
              entry.link ? "Link" : null,
            ]
              .filter(Boolean)
              .join(" · ")}
          </span>
        ) : null}
        <ChevronRightIcon
          aria-hidden
          className="size-3.5 shrink-0 text-muted-foreground opacity-0 group-aria-selected:opacity-100"
        />
      </button>
    );
  });
}

/**
 * Browses folders on one machine: a breadcrumb for where you are, places to
 * jump to, and a keyboard-driven list that marks repositories and existing
 * projects. Opening a folder never creates anything; New folder does, on that
 * machine.
 */
export function FolderBrowser({
  environmentId,
  startPath,
  machineLabel = null,
  disabled = false,
  places = NO_PLACES,
  projects = NO_PROJECTS,
  canCreateFolder = false,
  missingOkPath = null,
  tools = null,
  footer = null,
  onListing,
  onNavigate,
}: {
  readonly environmentId: EnvironmentId;
  /** The folder listed first. */
  readonly startPath: string;
  /** The machine being browsed, named in errors so its folders are never taken for this device's. */
  readonly machineLabel?: string | null;
  readonly disabled?: boolean;
  readonly places?: readonly FolderPlace[];
  /** Projects already registered on this machine, marked in the list. */
  readonly projects?: readonly KnownProject[];
  /** Offer New folder. Off for machines whose server cannot make one. */
  readonly canCreateFolder?: boolean;
  /** A folder that may not exist yet and is still a valid choice (it is made on first use). */
  readonly missingOkPath?: string | null;
  /** Extra buttons beside New folder, such as the system folder dialog. */
  readonly tools?: React.ReactNode;
  readonly footer?: React.ReactNode;
  /** The folder now shown, once it has loaded; null while there is none to show. */
  readonly onListing?: (listing: FolderListing | null) => void;
  /** A person opened a folder (not the first automatic listing). */
  readonly onNavigate?: (path: string) => void;
}) {
  const listId = useId();
  const [browsePath, setBrowsePath] = useState(() => withSeparator(startPath || "~/"));
  const [direction, setDirection] = useState<"forward" | "back" | null>(null);
  const [active, setActive] = useState(0);
  const [showHidden, setShowHidden] = useState(false);
  const [expandedCrumbs, setExpandedCrumbs] = useState(false);
  const [pathDraft, setPathDraft] = useState<string | null>(null);
  const [newName, setNewName] = useState<string | null>(null);
  const [newError, setNewError] = useState<string | null>(null);
  const [creating, setCreating] = useState(false);
  const typed = useRef({ text: "", at: 0 });
  const listRef = useRef<HTMLDivElement>(null);
  const access = useFilesystemReadAccess(environmentId);
  const query = useEnvironmentQuery(
    access.canReadFiles
      ? filesystemEnvironment.browse({ environmentId, input: { partialPath: browsePath } })
      : null,
  );
  const createDirectory = useAtomCommand(filesystemEnvironment.createDirectory, {
    reportFailure: false,
  });
  const onMachine = machineLabel ? ` on ${machineLabel}` : "";
  const failed = query.error !== null && query.error !== undefined;
  // The machine found the folder but its account may not list it. Such a
  // folder is named as the problem and is never a choice.
  const unreadable = !failed && !query.isPending && query.data?.unreadable === true;
  const loaded =
    query.data !== null && !query.isPending && !failed && !unreadable && access.canReadFiles;
  // Only a folder the machine says is absent counts as "not made yet"; an
  // offline machine or a refusal is an error, never a choice.
  const missingOk =
    failed &&
    missingOkPath !== null &&
    sameFolder(withSeparator(missingOkPath), browsePath) &&
    // Typed by newer servers; an older one only says so in words.
    ((query.error as { missing?: unknown } | null)?.missing === true ||
      /does not exist/.test(errorText(query.error)));
  const currentPath = loaded ? query.data!.parentPath : missingOk ? missingOkPath : null;
  const homePath = query.data?.homePath ?? null;
  const entries = useMemo(() => (loaded ? query.data!.entries : []), [loaded, query.data]);
  const visible = useMemo(
    () => (showHidden ? entries : entries.filter((entry) => !entry.name.startsWith("."))),
    [entries, showHidden],
  );
  const hiddenCount = entries.length - visible.length;
  const windows = currentPath !== null && /^[A-Za-z]:\\/.test(currentPath);
  // A home under /Users is a Mac's, where names match whatever their case.
  const machine = {
    windows,
    ignoresCase: windows || (homePath ?? currentPath ?? "").startsWith("/Users/"),
  };
  // Completion knows the folder being shown; a path typed elsewhere is opened as it is.
  const draftNames = (typed: string) =>
    currentPath !== null && sameFolder(typedDirectory(typed, windows) || "/", currentPath)
      ? entries.map((entry) => entry.name)
      : NO_NAMES;

  // Report the folder shown, and nothing while it is loading or unreadable, so
  // a stale folder is never taken for the choice.
  const reported = useRef<string | null | undefined>(undefined);
  useEffect(() => {
    const key = currentPath === null ? null : `${currentPath}\n${entries.length}`;
    if (reported.current === key) return;
    reported.current = key;
    onListing?.(currentPath === null ? null : { path: currentPath, homePath, entries });
  });

  const open = (path: string, toward: "forward" | "back" | null = null) => {
    const from = currentPath;
    setDirection(
      toward ??
        (from !== null && withSeparator(from).startsWith(withSeparator(path)) ? "back" : "forward"),
    );
    setBrowsePath(withSeparator(path));
    setActive(0);
    setNewName(null);
    setNewError(null);
    setPathDraft(null);
    setExpandedCrumbs(false);
    onNavigate?.(path);
  };
  const parent = currentPath === null ? parentFolderOf(browsePath) : parentFolderOf(currentPath);

  const submitNewFolder = async () => {
    if (newName === null || currentPath === null || creating) return;
    const problem =
      folderNameProblem(newName, windows) ??
      (entries.some((entry) => entry.name === newName.trim())
        ? `"${newName.trim()}" is already here.`
        : null);
    if (problem !== null) {
      setNewError(problem);
      return;
    }
    setCreating(true);
    const result = await createDirectory({
      environmentId,
      input: { parentPath: currentPath, name: newName.trim() },
    });
    setCreating(false);
    if (result._tag === "Failure") {
      setNewError(
        errorText(squashAtomCommandFailure(result)).replace(
          "on this machine",
          onMachine.trim() || "on this machine",
        ),
      );
      return;
    }
    query.refresh();
    open(result.value.path, "forward");
  };

  const onListKeyDown = (event: React.KeyboardEvent) => {
    if (disabled || event.target !== event.currentTarget) return;
    const last = visible.length - 1;
    const row = visible[active];
    if (event.key === "ArrowDown") setActive(Math.min(active + 1, last));
    else if (event.key === "ArrowUp") setActive(Math.max(active - 1, 0));
    else if (event.key === "Home") setActive(0);
    else if (event.key === "End") setActive(Math.max(last, 0));
    else if ((event.key === "ArrowRight" || event.key === "Enter") && row)
      open(row.fullPath, "forward");
    else if ((event.key === "ArrowLeft" || event.key === "Backspace") && parent)
      open(parent, "back");
    else if (
      event.key === "/" ||
      (event.key.toLowerCase() === "l" && (event.metaKey || event.ctrlKey))
    ) {
      setPathDraft(currentPath ?? browsePath);
    } else if (event.key.length === 1 && !event.metaKey && !event.ctrlKey && !event.altKey) {
      const now = Date.now();
      typed.current = {
        text: now - typed.current.at < 700 ? typed.current.text + event.key : event.key,
        at: now,
      };
      const index = typeAheadIndex(
        visible.map((entry) => entry.name),
        typed.current.text,
        active,
      );
      if (index >= 0) setActive(index);
    } else return;
    event.preventDefault();
  };
  useEffect(() => {
    listRef.current
      ?.querySelector<HTMLElement>(`[data-row="${active}"]`)
      ?.scrollIntoView?.({ block: "nearest" });
  }, [active]);

  const crumbs = currentPath === null ? [] : pathCrumbs(currentPath, homePath);
  const { head, hidden, tail } = expandedCrumbs
    ? { head: crumbs, hidden: [], tail: [] }
    : collapseCrumbs(crumbs);
  const crumbButton = (crumb: { label: string; path: string }, last: boolean) => (
    <li key={crumb.path} className="flex min-w-0 items-center">
      <button
        type="button"
        disabled={disabled}
        aria-current={last ? "location" : undefined}
        onClick={() => open(crumb.path, "back")}
        className={cn(
          "min-w-0 truncate rounded px-1.5 py-0.5 text-sm outline-none hover:bg-muted focus-visible:ring-2 focus-visible:ring-ring motion-safe:transition-colors",
          last ? "font-medium text-foreground" : "text-muted-foreground hover:text-foreground",
        )}
      >
        {crumb.label}
      </button>
      {last ? null : (
        <ChevronRightIcon className="size-3 shrink-0 text-muted-foreground" aria-hidden />
      )}
    </li>
  );

  return (
    <div
      data-slot="folder-browser"
      className="overflow-hidden rounded-lg border"
      onPaste={(event) => {
        if (disabled || event.target instanceof HTMLInputElement) return;
        const pasted = cleanPastedPath(event.clipboardData.getData("text"), machine);
        if (pasted.length === 0) return;
        event.preventDefault();
        setPathDraft(pasted);
      }}
      onKeyDown={(event) => {
        if (event.key !== "Escape") event.stopPropagation();
      }}
    >
      <div className="flex min-h-10 items-center gap-1 border-b px-2 py-1.5">
        {pathDraft !== null ? (
          <PathField
            autoFocus
            aria-label="Folder path"
            value={pathDraft}
            names={draftNames}
            machine={machine}
            disabled={disabled}
            onChange={setPathDraft}
            // Leaving an edited path keeps it; an untouched one turns back into the breadcrumb.
            onBlur={() => {
              if (sameFolder(pathDraft.trim() || "/", currentPath ?? browsePath))
                setPathDraft(null);
            }}
            onSubmit={(path) => open(path)}
            onCancel={() => {
              setPathDraft(null);
              listRef.current?.focus();
            }}
          />
        ) : (
          <nav
            aria-label={`Current folder${onMachine}`}
            className="flex min-w-0 flex-1 cursor-text self-stretch"
            onClick={(event) => {
              if (event.target !== event.currentTarget || disabled || !access.canReadFiles) return;
              setPathDraft(currentPath ?? browsePath);
            }}
          >
            <ol
              className={cn(
                "flex min-w-0 cursor-default items-center",
                expandedCrumbs && "flex-wrap",
              )}
            >
              {head.map((crumb, index) =>
                crumbButton(crumb, hidden.length === 0 && index === head.length - 1),
              )}
              {hidden.length > 0 ? (
                <li className="flex items-center">
                  <button
                    type="button"
                    aria-label={`Show ${hidden.length} more folders in the path`}
                    disabled={disabled}
                    onClick={() => setExpandedCrumbs(true)}
                    className="rounded px-1 py-0.5 text-muted-foreground outline-none hover:bg-muted hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring"
                  >
                    <EllipsisIcon className="size-3.5" aria-hidden />
                  </button>
                  <ChevronRightIcon className="size-3 shrink-0 text-muted-foreground" aria-hidden />
                </li>
              ) : null}
              {tail.map((crumb, index) => crumbButton(crumb, index === tail.length - 1))}
              {currentPath === null ? (
                <li className="truncate px-1.5 text-sm text-muted-foreground">{browsePath}</li>
              ) : null}
            </ol>
          </nav>
        )}
        <Tooltip>
          <TooltipTrigger
            render={
              <button
                type="button"
                className={TOOL}
                aria-label="Type a path"
                disabled={disabled || !access.canReadFiles}
                onMouseDown={(event) => event.preventDefault()}
                onClick={() =>
                  setPathDraft(pathDraft === null ? (currentPath ?? browsePath) : null)
                }
              />
            }
          >
            <TextCursorInputIcon className="size-3.5" aria-hidden />
          </TooltipTrigger>
          <TooltipPopup>Type a path (/)</TooltipPopup>
        </Tooltip>
        {hiddenCount > 0 || showHidden ? (
          <Tooltip>
            <TooltipTrigger
              render={
                <button
                  type="button"
                  className={TOOL}
                  aria-pressed={showHidden}
                  aria-label="Show hidden folders"
                  disabled={disabled}
                  onClick={() => setShowHidden(!showHidden)}
                />
              }
            >
              {showHidden ? (
                <EyeIcon className="size-3.5" aria-hidden />
              ) : (
                <EyeOffIcon className="size-3.5" aria-hidden />
              )}
            </TooltipTrigger>
            <TooltipPopup>
              {showHidden ? "Hide hidden folders" : `Show ${hiddenCount} hidden folders`}
            </TooltipPopup>
          </Tooltip>
        ) : null}
        {tools}
        {canCreateFolder ? (
          <button
            type="button"
            className={TOOL}
            disabled={disabled || !loaded}
            onClick={() => {
              setNewName("");
              setNewError(null);
            }}
          >
            <FolderPlusIcon className="size-3.5" aria-hidden />
            <span>New folder</span>
          </button>
        ) : null}
      </div>
      <div className={cn("grid", places.length > 0 && "sm:grid-cols-[10.5rem_1fr]")}>
        {places.length > 0 ? (
          <FolderPlaces
            places={places}
            currentPath={currentPath}
            disabled={disabled}
            onOpen={(path) => open(path)}
          />
        ) : null}
        <div className="h-52 overflow-y-auto overscroll-contain p-1.5">
          {!access.canReadFiles && !access.isPending && !access.error ? (
            <p role="alert" className="px-2 py-1.5 text-xs text-destructive-foreground">
              Folder access is unavailable{onMachine}.
            </p>
          ) : null}
          {query.isPending ? (
            <div role="status" aria-label="Loading folders…" className="space-y-1 p-1">
              {[68, 44, 56, 36, 50].map((width) => (
                <div key={width} className="flex items-center gap-2.5 py-1.5">
                  <div className="size-4 rounded bg-muted motion-safe:animate-pulse" />
                  <div
                    className="h-3 rounded bg-muted motion-safe:animate-pulse"
                    style={{ width: `${width}%` }}
                  />
                </div>
              ))}
            </div>
          ) : null}
          {missingOk ? (
            <p role="status" className="px-2 py-1.5 text-sm text-muted-foreground">
              This folder{onMachine} does not exist yet. It is made when you create the project.
            </p>
          ) : unreadable ? (
            <div className="space-y-2 px-2 py-1.5">
              <p role="alert" className="text-sm text-destructive-foreground">
                {`You do not have permission to read this folder ${onMachine.trim() || "on this machine"}.`}{" "}
                Open another folder for the project.
              </p>
              {parent ? (
                <button
                  type="button"
                  className={cn(TOOL, "border text-sm")}
                  disabled={disabled}
                  onClick={() => open(parent, "back")}
                >
                  Open {parent}
                </button>
              ) : null}
            </div>
          ) : failed || access.error ? (
            <div className="space-y-2 px-2 py-1.5">
              <p role="alert" className="text-sm text-destructive-foreground">
                {failed && machineLabel
                  ? errorText(query.error).replace("on this machine", `on ${machineLabel}`)
                  : errorText(query.error ?? access.error)}
              </p>
              {failed && parent ? (
                <button
                  type="button"
                  className={cn(TOOL, "border text-sm")}
                  disabled={disabled}
                  onClick={() => open(parent, "back")}
                >
                  Open {parent}
                </button>
              ) : null}
            </div>
          ) : null}
          {newName !== null ? (
            <form
              data-folder-new
              className="mb-px rounded-md bg-muted px-2 py-1.5"
              onSubmit={(event) => {
                event.preventDefault();
                void submitNewFolder();
              }}
            >
              <div className="flex items-center gap-2.5">
                <FolderPlusIcon className="size-4 shrink-0 text-muted-foreground" aria-hidden />
                <input
                  autoFocus
                  aria-label="New folder name"
                  aria-invalid={newError !== null}
                  placeholder="Folder name"
                  className="min-w-0 flex-1 rounded border bg-background px-2 py-0.5 text-sm outline-none focus-visible:ring-2 focus-visible:ring-ring"
                  value={newName}
                  spellCheck={false}
                  autoCapitalize="off"
                  autoCorrect="off"
                  disabled={disabled || creating}
                  onChange={(event) => {
                    setNewName(event.target.value);
                    setNewError(null);
                  }}
                  onKeyDown={(event) => {
                    if (event.key !== "Escape") return;
                    event.preventDefault();
                    event.stopPropagation();
                    setNewName(null);
                    setNewError(null);
                  }}
                />
                <button type="submit" className={cn(TOOL, "text-foreground")} disabled={creating}>
                  {creating ? "Creating…" : "Create"}
                </button>
              </div>
              {newError ? (
                <p role="alert" className="pt-1 pl-6.5 text-xs text-destructive-foreground">
                  {newError}
                </p>
              ) : null}
            </form>
          ) : null}
          <div
            ref={listRef}
            id={listId}
            role="listbox"
            aria-label={`Folders${onMachine}`}
            aria-activedescendant={visible[active] ? `${listId}-${active}` : undefined}
            tabIndex={disabled ? -1 : 0}
            onKeyDown={onListKeyDown}
            className="min-h-6 rounded-md outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-inset"
          >
            <div
              key={currentPath}
              role="presentation"
              data-folder-enter={direction ?? undefined}
              className="flex flex-col gap-px"
            >
              <FolderRows
                listId={listId}
                entries={loaded ? visible : []}
                active={active}
                projects={projects}
                disabled={disabled}
                onHover={setActive}
                onOpen={(path) => open(path, "forward")}
              />
            </div>
          </div>
          {loaded && visible.length === 0 && newName === null ? (
            <p className="px-2 py-1.5 text-sm text-muted-foreground">
              {hiddenCount > 0 ? "Only hidden folders here." : "No folders inside."}
            </p>
          ) : null}
        </div>
      </div>
      {footer ? <div className="border-t px-3 py-2">{footer}</div> : null}
    </div>
  );
}
