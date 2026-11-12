import { useEffect, useEffectEvent, useId, useRef, useState } from "react";
import { FolderOpenIcon } from "lucide-react";
import type { EnvironmentId, FilesystemBrowseEntry } from "@specweave-studio/contracts";
import {
  filterFilesystemBrowseEntries,
  getFilesystemBrowsePath,
} from "@specweave-studio/client-runtime/state/filesystem";
import { filesystemEnvironment, useFilesystemReadAccess } from "../../state/filesystem";
import { useEnvironmentQuery } from "../../state/query";
import { droppedFolder } from "../../lib/folderDrop";
import {
  currentPlatform,
  hasMainModifier,
  keyLabel,
  shortcutLabel,
  systemDialogLabel,
} from "../../lib/platformConventions";
import { hasTrailingPathSeparator, isExplicitRelativeProjectPath } from "../../lib/projectPaths";
import { cn, isMacPlatform, isWindowsPlatform } from "../../lib/utils";
import { Button } from "../ui/button";
import { Kbd } from "../ui/kbd";
import { Tooltip, TooltipPopup, TooltipTrigger } from "../ui/tooltip";
import { FolderPlaces, FolderRows, type FolderListing, type FolderPlace } from "./FolderBrowser";
import { displayPath, type KnownProject } from "./folderBrowser.logic";
import { usePathCompletion } from "./PathField";
import {
  addFolderKey,
  folderChoiceState,
  pathKindProblem,
  typedDirectory,
  typedLeaf,
  type FolderChoiceState,
} from "./pathField.logic";

const NO_ENTRIES: ReadonlyArray<FilesystemBrowseEntry> = [];
const NO_NAMES: readonly string[] = [];

/** The error's own words; String() of an error object would prefix its class name. */
function errorText(error: unknown): string {
  if (typeof error === "object" && error !== null && "message" in error) {
    const message = (error as { message?: unknown }).message;
    if (typeof message === "string" && message.trim()) return message;
  }
  return String(error);
}

export interface AddFolder {
  /** What the folder in the bar is and what confirming it does. */
  readonly choice: FolderChoiceState;
  /** The folder the bar names, as the machine spells it when it has answered. */
  readonly path: string;
  readonly adding: boolean;
  /** Why the last confirm did not add the folder; gone once the bar changes. */
  readonly failure: string | null;
  readonly listing: {
    readonly path: string | null;
    readonly homePath: string | null;
    readonly rows: FolderListing["entries"];
    readonly pending: boolean;
    readonly hiddenCount: number;
  };
  /** The row the arrow keys put into the bar; never set by the pointer. */
  readonly highlighted: number | null;
  /** The folder list's id; its rows are `${listId}-${index}`. */
  readonly listId: string;
  /** The id of the line that says why the system dialog is not offered. */
  readonly noteId: string;
  readonly machineLabel: string | null;
  readonly projects: readonly KnownProject[];
  /** A sentence about the last drop: a refusal, or that a file's folder was used. */
  readonly dropNote: string | null;
  readonly submit: () => void;
  readonly open: (path: string) => void;
  readonly drop: (event: React.DragEvent) => void;
  /** Props for the address bar's input. `onKeyDown` returns true when it took the key. */
  readonly bar: {
    readonly change: (
      next: string,
      from?: { readonly element?: HTMLInputElement | null; readonly composing?: boolean },
    ) => void;
    readonly onPaste: (event: React.ClipboardEvent<HTMLInputElement>) => void;
    readonly onKeyDown: (event: React.KeyboardEvent<HTMLInputElement>) => boolean;
    /** Ties the bar to the folder list and to the highlighted row. */
    readonly aria: {
      readonly "aria-controls": string;
      readonly "aria-activedescendant"?: string;
    };
  };
}

/**
 * Add project > Local folder, as an address bar over a folder list. One rule:
 * Enter confirms the folder the bar shows. Arrow keys write the highlighted
 * folder into the bar, Tab or Right opens it, and the pointer resting on a row
 * changes nothing that Enter does.
 */
export function useAddFolder(input: {
  readonly environmentId: EnvironmentId | null;
  /** The panel is on screen. */
  readonly active: boolean;
  /** The bar's text, owned by the caller. */
  readonly value: string;
  readonly onValueChange: (next: string) => void;
  /** The target machine's platform, in `navigator.platform` form. */
  readonly platform: string;
  /** The open project's folder, which a relative path starts from. */
  readonly cwd: string | null;
  readonly machineLabel: string | null;
  readonly projects: readonly KnownProject[];
  readonly allowed: boolean;
  readonly notAllowedReason?: string | null;
  /** Adds or opens the folder. Resolves to null when done, or to the reason it was not. */
  readonly add: (path: string) => Promise<string | null>;
  /** Opens the system folder dialog, when this device's disks are the target. */
  readonly pickNatively?: (() => void) | null;
  /** Why a dropped folder cannot be taken here; null when it can. */
  readonly dropRefusal: string | null;
  readonly getPathForFile?: ((file: File) => string) | undefined;
  /** The machine said the folder in the bar is not there, e.g. a remembered folder since removed. */
  readonly onMissing?: ((path: string) => void) | undefined;
}): AddFolder {
  const { value, platform, cwd } = input;
  const windows = isWindowsPlatform(platform);
  const machine = { windows, ignoresCase: windows || isMacPlatform(platform) };
  const listId = useId();
  const [highlight, setHighlight] = useState<{
    /** The highlighted folder, which is also what the bar shows. */
    readonly value: string;
    /** The typed text the list was showing when the arrows took over. */
    readonly base: string;
  } | null>(null);
  const [failed, setFailed] = useState<{ value: string; reason: string } | null>(null);
  const [dropped, setDropped] = useState<{ value: string | null; note: string } | null>(null);
  const [adding, setAdding] = useState(false);
  const addingRef = useRef(false);

  // Arrow keys change the bar, and typing anything ends the highlight.
  const arrow = highlight !== null && highlight.value === value ? highlight : null;
  const completion = usePathCompletion({
    value,
    onChange: input.onValueChange,
    names: NO_NAMES,
    machine,
  });
  // The list filters by what the person typed, not by a completion or an arrowed name.
  const listed = arrow?.base ?? completion.typed;
  const browse = getFilesystemBrowsePath(listed, platform, input.active);
  const relativeNeedsProject = isExplicitRelativeProjectPath(value.trim()) && cwd === null;
  const problem =
    value.trim().length === 0
      ? null
      : (pathKindProblem(value, machine, input.machineLabel) ??
        (relativeNeedsProject
          ? "A relative path needs an open project to start from. Type the full path."
          : !getFilesystemBrowsePath(value, platform, true).isBrowsing
            ? windows
              ? "Type a full path: one that starts with a drive, like C:\\Projects, or with ~/."
              : "Type a full path: one that starts with / or ~/."
            : null));
  const access = useFilesystemReadAccess(input.environmentId);
  const hasTarget =
    input.active &&
    input.environmentId !== null &&
    problem === null &&
    browse.isBrowsing &&
    browse.directoryPath.length > 0;
  const query = useEnvironmentQuery(
    access.canReadFiles && hasTarget
      ? filesystemEnvironment.browse({
          environmentId: input.environmentId!,
          input: { partialPath: browse.directoryPath, ...(cwd ? { cwd } : {}) },
        })
      : null,
  );
  const failedToList = query.error !== null && query.error !== undefined;
  const pending = hasTarget && (access.isPending || query.isPending);
  const loaded = hasTarget && !pending && !failedToList && query.data != null;
  const unreadable = loaded && query.data!.unreadable === true;
  const entries = loaded && !unreadable ? query.data!.entries : NO_ENTRIES;
  const rows = filterFilesystemBrowseEntries(entries, browse.filterQuery).visibleEntries;
  const hiddenCount = browse.filterQuery.length === 0 ? entries.length - rows.length : 0;

  // What the bar names: the listed folder itself, or a name inside it.
  const insideListed = hasTrailingPathSeparator(value) || value.trim().length === 0;
  const leaf = typedLeaf(value.trim(), windows);
  const sameName = (name: string) =>
    machine.ignoresCase ? name.toLowerCase() === leaf.toLowerCase() : name === leaf;
  // The highlighted row is the one the bar names, wherever a refreshed list has put it.
  const arrowIndex = arrow === null ? -1 : rows.findIndex((row) => row.fullPath === arrow.value);
  const highlighted = arrowIndex >= 0 ? arrowIndex : null;
  const exact =
    arrow !== null
      ? (rows[arrowIndex] ?? null)
      : insideListed
        ? null
        : (entries.find((entry) => sameName(entry.name)) ?? null);
  const path = insideListed
    ? ((loaded ? query.data!.parentPath : null) ?? value.trim())
    : (exact?.fullPath ?? value.trim());
  const missing = failedToList && /does not exist/.test(errorText(query.error));
  const missingFolder = missing && insideListed ? browse.directoryPath : null;
  const reportMissing = useEffectEvent((folder: string) => input.onMissing?.(folder));
  useEffect(() => {
    if (missingFolder !== null) reportMissing(missingFolder);
  }, [missingFolder]);
  const accessError =
    hasTarget && !access.isPending && !access.canReadFiles
      ? (access.error ?? "This connection cannot browse folders on the machine.")
      : null;
  const listError =
    accessError ??
    (failedToList && !missing
      ? input.machineLabel
        ? errorText(query.error).replace("on this machine", `on ${input.machineLabel}`)
        : errorText(query.error)
      : null);
  const choice = folderChoiceState({
    path: problem === null ? path : value,
    machineLabel: input.machineLabel,
    problem,
    pending,
    found: unreadable
      ? insideListed
        ? "unreadable"
        : "exists"
      : missing
        ? "missing"
        : !loaded
          ? "unknown"
          : insideListed || exact !== null
            ? "exists"
            : "missing",
    git: exact?.kind === "git" || (insideListed && entries.some((entry) => entry.name === ".git")),
    childCount: loaded && !unreadable && insideListed ? rows.length : null,
    projects: input.projects,
    allowed: input.allowed,
    notAllowedReason: input.notAllowedReason ?? null,
    error: listError,
  });

  // A Windows folder keeps its own separator, whatever the bar held before.
  const withSeparator = (target: string) =>
    /[\\/]$/.test(target) ? target : `${target}${windows && !target.includes("/") ? "\\" : "/"}`;
  const open = (target: string) => {
    setHighlight(null);
    input.onValueChange(withSeparator(target));
  };
  const submit = () => {
    if (choice.action === "none" || addingRef.current) return;
    addingRef.current = true;
    setAdding(true);
    setFailed(null);
    const confirmed = value;
    void input
      .add(path)
      .catch((error: unknown) => errorText(error))
      .then((reason) => {
        addingRef.current = false;
        setAdding(false);
        if (reason !== null) setFailed({ value: confirmed, reason });
      });
  };

  const onKeyDown = (event: React.KeyboardEvent<HTMLInputElement>): boolean => {
    if (event.nativeEvent.isComposing || event.keyCode === 229) return false;
    const system = currentPlatform();
    if (event.key.toLowerCase() === "o" && hasMainModifier(event, system) && input.pickNatively) {
      event.preventDefault();
      input.pickNatively();
      return true;
    }
    const field = event.currentTarget;
    const action = addFolderKey({
      key: event.key,
      modified: event.metaKey || event.ctrlKey || event.altKey || event.shiftKey,
      value,
      selectionStart: field.selectionStart ?? value.length,
      selectionEnd: field.selectionEnd ?? value.length,
      highlighted,
      rows,
      openable:
        exact?.fullPath ??
        (leaf.length > 0 && rows.length === 1 && !insideListed ? rows[0]!.fullPath : null),
      machine,
    });
    if (action === null) return false;
    event.preventDefault();
    if (action.kind === "submit") submit();
    else if (action.kind === "open" || action.kind === "parent") open(action.path);
    else {
      const row = rows[action.index]!;
      setHighlight({ value: row.fullPath, base: listed });
      input.onValueChange(row.fullPath);
    }
    return true;
  };

  const drop = (event: React.DragEvent) => {
    if (!event.dataTransfer.types.includes("Files")) return;
    event.preventDefault();
    if (input.dropRefusal !== null) {
      setDropped({ value: null, note: input.dropRefusal });
      return;
    }
    // Text and links can travel with a drop; only the file items line up with `files`.
    const items = [...event.dataTransfer.items].filter((item) => item.kind === "file");
    const folder = droppedFolder({
      files: [...event.dataTransfer.files],
      isDirectory: (index) => items[index]?.webkitGetAsEntry?.()?.isDirectory ?? null,
      getPathForFile: input.getPathForFile,
    });
    if (folder === null) {
      setDropped({
        value: null,
        note: "Could not read the dropped folder's path. Type or paste it instead.",
      });
      return;
    }
    // This device's path form can be one the target machine does not use (a Windows disk and WSL).
    const wrongKind = pathKindProblem(folder.path, machine, input.machineLabel);
    if (wrongKind !== null) {
      setDropped({ value: null, note: wrongKind });
      return;
    }
    const next = withSeparator(folder.path);
    setHighlight(null);
    setDropped(
      folder.fromFile
        ? { value: next, note: "You dropped a file, so the folder it is in is shown." }
        : null,
    );
    input.onValueChange(next);
  };

  return {
    choice,
    path,
    adding,
    failure: failed !== null && failed.value === value ? failed.reason : null,
    listing: {
      path: loaded ? query.data!.parentPath : null,
      homePath: query.data?.homePath ?? null,
      rows,
      pending,
      hiddenCount,
    },
    highlighted,
    listId,
    noteId: `${listId}-note`,
    machineLabel: input.machineLabel,
    projects: input.projects,
    dropNote:
      dropped !== null && (dropped.value === null || dropped.value === value) ? dropped.note : null,
    submit,
    open,
    drop,
    bar: {
      change: (next, from) => {
        if (dropped?.value === null) setDropped(null);
        // Complete from the folder being typed in, and only while its listing is the one shown.
        const sameDirectory = typedDirectory(next, windows) === typedDirectory(listed, windows);
        completion.change(next, {
          ...from,
          names: sameDirectory ? entries.map((entry) => entry.name) : NO_NAMES,
        });
      },
      onPaste: (event) => {
        if (dropped?.value === null) setDropped(null);
        completion.paste(event);
      },
      onKeyDown,
      aria: {
        "aria-controls": listId,
        ...(highlighted === null ? {} : { "aria-activedescendant": `${listId}-${highlighted}` }),
      },
    },
  };
}

/** `text` once it has stopped changing for `delayMs`. */
function useSettled(text: string, delayMs: number): string {
  const [settled, setSettled] = useState(text);
  useEffect(() => {
    const timer = setTimeout(() => setSettled(text), delayMs);
    return () => clearTimeout(timer);
  }, [text, delayMs]);
  return settled;
}

/**
 * The body of Add project > Local folder under the address bar: what the
 * folder in the bar is, places to jump to, and the folders beside or inside it.
 */
export function AddFolderPanel({
  folder,
  places,
  busyNote = null,
  pickerNote = null,
}: {
  readonly folder: AddFolder;
  readonly places: readonly FolderPlace[];
  /** What the app is doing with a confirmed folder, e.g. looking for copies. */
  readonly busyNote?: string | null;
  /** Why the system folder dialog is not offered for this target. */
  readonly pickerNote?: string | null;
}) {
  const listId = folder.listId;
  const listRef = useRef<HTMLDivElement>(null);
  const [dragging, setDragging] = useState(false);
  const { listing, choice } = folder;
  useEffect(() => {
    if (folder.highlighted === null) return;
    listRef.current
      ?.querySelector<HTMLElement>(`[data-row="${folder.highlighted}"]`)
      ?.scrollIntoView?.({ block: "nearest" });
  }, [folder.highlighted]);
  const problem = folder.failure !== null || choice.tone === "problem";
  const status = folder.failure ?? busyNote ?? (folder.adding ? "Adding…" : choice.status);
  // Read out once the text has settled, so typing is not narrated key by key.
  // A failed add is the one interruption, and it is announced by its own alert.
  const announced = useSettled(folder.failure !== null || listing.pending ? "" : status, 700);
  return (
    <div
      data-slot="add-folder"
      data-dragging={dragging ? "" : undefined}
      className="flex min-h-0 flex-col data-dragging:bg-primary/5"
      onDragOver={(event) => {
        if (!event.dataTransfer.types.includes("Files")) return;
        event.preventDefault();
        setDragging(true);
      }}
      onDragLeave={(event) => {
        if (!event.currentTarget.contains(event.relatedTarget as Node | null)) setDragging(false);
      }}
      onDrop={(event) => {
        setDragging(false);
        folder.drop(event);
      }}
    >
      <div className="px-4 py-2.5">
        <p
          role={folder.failure !== null ? "alert" : undefined}
          data-slot="add-folder-status"
          data-tone={problem ? "problem" : "plain"}
          className={cn(
            "break-words text-sm",
            problem ? "text-destructive-foreground" : "text-muted-foreground",
          )}
        >
          {status}
        </p>
        <p role="status" data-slot="add-folder-announcement" className="sr-only">
          {announced}
        </p>
        {pickerNote ? (
          <p
            id={folder.noteId}
            data-slot="add-folder-picker-note"
            className="pt-1 text-xs text-muted-foreground"
          >
            {pickerNote}
          </p>
        ) : null}
        {folder.dropNote ? (
          <p
            role="status"
            data-slot="add-folder-drop"
            className="pt-1 text-xs text-muted-foreground"
          >
            {folder.dropNote}
          </p>
        ) : null}
      </div>
      <div
        className={cn("grid min-h-0 border-t", places.length > 0 && "sm:grid-cols-[10.5rem_1fr]")}
      >
        {places.length > 0 ? (
          <FolderPlaces places={places} currentPath={listing.path} onOpen={folder.open} />
        ) : null}
        <div className="h-52 overflow-y-auto overscroll-contain p-1.5">
          {listing.path !== null ? (
            <p className="truncate px-2 pb-1 text-xs text-muted-foreground">
              Folders in {displayPath(listing.path, listing.homePath)}
              {folder.machineLabel ? ` on ${folder.machineLabel}` : ""}
            </p>
          ) : null}
          {listing.pending ? (
            <div role="status" aria-label="Loading folders…" className="space-y-1 p-1">
              {[68, 44, 56].map((width) => (
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
          <div
            ref={listRef}
            id={listId}
            role="listbox"
            aria-label={`Folders${folder.machineLabel ? ` on ${folder.machineLabel}` : ""}`}
            className="flex flex-col gap-px"
          >
            <FolderRows
              listId={listId}
              entries={listing.rows}
              active={folder.highlighted}
              projects={folder.projects}
              onOpen={folder.open}
            />
          </div>
          {listing.path !== null && !listing.pending && listing.rows.length === 0 ? (
            <p className="px-2 py-1.5 text-sm text-muted-foreground">
              {listing.hiddenCount > 0 ? "Only hidden folders here." : "No folders inside."}
            </p>
          ) : null}
        </div>
      </div>
    </div>
  );
}

/** The footer's full-size primary: it names what Enter does with the folder in the bar. */
export function AddFolderAction({ folder }: { readonly folder: AddFolder }) {
  const platform = currentPlatform();
  return (
    <div
      className="shrink-0 border-t border-border px-4 py-3"
      role="region"
      aria-label="Add project"
    >
      <Button
        className="w-full"
        data-slot="add-folder-primary"
        disabled={folder.adding || folder.choice.action === "none"}
        onClick={folder.submit}
      >
        <span className="truncate">{folder.adding ? "Adding…" : folder.choice.label}</span>
        {folder.adding ? null : (
          // A plain key hint: Kbd owns its colours, and they are not made for the primary fill.
          <span className="rounded bg-primary-foreground/15 px-1.5 text-xs">
            {keyLabel("enter", platform)}
          </span>
        )}
      </Button>
      <p className="pt-2 text-xs text-muted-foreground">
        <Kbd keyName="tab" /> opens the highlighted folder. <Kbd keyName="enter" /> adds the folder
        shown in the bar.
      </p>
    </div>
  );
}

/** The labelled button beside the bar that opens the system's folder dialog. */
export function SystemFolderButton({
  picking,
  disabled = false,
  describedBy,
  className,
  onPick,
}: {
  readonly picking: boolean;
  /** The system dialog cannot be used for this target; the button stays, and the panel says why. */
  readonly disabled?: boolean;
  /** The id of the line that says why, for a disabled button. */
  readonly describedBy?: string | undefined;
  readonly className?: string | undefined;
  readonly onPick: () => void;
}) {
  const platform = currentPlatform();
  const label = systemDialogLabel(platform);
  return (
    <Tooltip>
      <TooltipTrigger
        render={
          <Button
            variant="outline"
            size="xs"
            className={className}
            data-slot="system-folder-button"
            disabled={picking || disabled}
            aria-describedby={disabled ? describedBy : undefined}
            onMouseDown={(event) => event.preventDefault()}
            onClick={onPick}
          />
        }
      >
        <FolderOpenIcon aria-hidden />
        <span>{picking ? "Waiting…" : label}</span>
      </TooltipTrigger>
      <TooltipPopup>
        {label.replace("…", "")} a folder on this device ({shortcutLabel("o", platform)})
      </TooltipPopup>
    </Tooltip>
  );
}
