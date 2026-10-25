import type { DesignOwnerInput, DesignSummary, ProjectId } from "@specweave-studio/contracts";
import {
  CopyIcon,
  CopyPlusIcon,
  EllipsisIcon,
  FolderInputIcon,
  FolderOpenIcon,
  FolderSymlinkIcon,
  LinkIcon,
  PanelTopOpenIcon,
  PencilIcon,
  Trash2Icon,
} from "lucide-react";
import { useId, useRef, useState, type ReactNode, type RefObject } from "react";

import {
  AlertDialog,
  AlertDialogClose,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogPopup,
  AlertDialogTitle,
} from "../../ui/alert-dialog";
import { Button } from "../../ui/button";
import {
  Dialog,
  DialogFooter,
  DialogHeader,
  DialogPanel,
  DialogPopup,
  DialogTitle,
} from "../../ui/dialog";
import { Input } from "../../ui/input";
import { Label } from "../../ui/label";
import {
  Menu,
  MenuGroup,
  MenuGroupLabel,
  MenuItem,
  MenuPopup,
  MenuSeparator,
  MenuSub,
  MenuSubPopup,
  MenuSubTrigger,
  MenuTrigger,
} from "../../ui/menu";
import type { ProjectFaviconProject } from "../../ProjectFavicon";
import { DESIGN_TITLE_MAX } from "./designMenuActions";

export interface GalleryProject {
  readonly id: ProjectId;
  readonly title: string;
  /** The `/projects/$projectKey` workspace this project opens in, when this window has one. */
  readonly projectKey?: string;
  /** The project record its sidebar icon is drawn from. */
  readonly icon?: ProjectFaviconProject;
  /** "personal" projects have no repository to read; "code" when omitted. */
  readonly kind?: "code" | "personal";
  /**
   * Why the project is not a place for a new design (archived, automated), as a picker
   * says it; omitted for the person's own projects. Its designs still show.
   */
  readonly unavailable?: string;
  /** The project's folder the design list could not find; "" when its path is unknown. */
  readonly missingFolder?: string;
  /** The project's own last change, for ordering pickers by recent activity. */
  readonly updatedAt?: string;
}

/** What the design menu does; the gallery card and the editor header share it. */
export interface DesignMenuHandlers {
  /** Gallery only: the editor is already open. */
  readonly onOpen?: (summary: DesignSummary) => void;
  /** Resolves to an error message, or null once the title is saved. */
  readonly onRename: (summary: DesignSummary, title: string) => Promise<string | null>;
  /** Copies the design into its own owner as "<title> copy". */
  readonly onDuplicate: (summary: DesignSummary) => void;
  /** Resolves to an error message, or null when the copy was made. */
  readonly onCopy: (summary: DesignSummary, to: DesignOwnerInput) => Promise<string | null>;
  readonly onDelete: (summary: DesignSummary) => Promise<string | null>;
  /** Copies the app link `/design/<key>`; it opens on any client signed in to this machine. */
  readonly onCopyLink: (summary: DesignSummary) => void;
  /** Opens the owning project's workspace; omitted where that is not possible. */
  readonly onOpenProject?: ((summary: DesignSummary, projectKey: string) => void) | null;
  /**
   * Opens "Connect to a project" for a Playground design, with `projectId`
   * chosen when given. Omitted when this machine's server cannot move designs
   * or this window is not the owner's.
   */
  readonly onConnect?: ((summary: DesignSummary, projectId?: ProjectId) => void) | null;
}

export interface DesignActionHandlers extends DesignMenuHandlers {
  readonly onOpen: (summary: DesignSummary) => void;
}

export type DesignMenuSurface = "gallery" | "editor";

export type DesignMenuAction =
  | "open"
  | "rename"
  | "duplicate"
  | "copy-link"
  | "open-project"
  | "connect-to-project"
  | "copy-to-project"
  | "copy-to-playground"
  | "delete";

export type DesignMenuEntry =
  | { readonly kind: "action"; readonly action: DesignMenuAction; readonly disabled: boolean }
  | { readonly kind: "separator" };

export const DESIGN_MENU_LABELS: Record<DesignMenuAction, string> = {
  open: "Open",
  rename: "Rename…",
  duplicate: "Duplicate",
  "copy-link": "Copy link",
  "open-project": "Open project",
  "connect-to-project": "Connect to a project…",
  "copy-to-project": "Copy to project…",
  "copy-to-playground": "Copy to Playground",
  delete: "Delete…",
};

/** The menu for one design, in order; writes are disabled without `canWrite`. */
export function designMenuEntries(input: {
  readonly surface: DesignMenuSurface;
  readonly ownerKind: "playground" | "project";
  readonly canWrite: boolean;
  readonly copyTargets: number;
  readonly canOpenProject: boolean;
  /** Playground designs only: this machine moves designs and the window is the owner's. */
  readonly canConnect?: boolean;
}): DesignMenuEntry[] {
  const readOnly = !input.canWrite;
  const action = (name: DesignMenuAction, disabled = false): DesignMenuEntry => ({
    kind: "action",
    action: name,
    disabled,
  });
  const project = input.ownerKind === "project";
  return [
    ...(input.surface === "gallery" ? [action("open")] : []),
    action("rename", readOnly),
    action("duplicate", readOnly),
    action("copy-link"),
    ...(project && input.canOpenProject ? [action("open-project")] : []),
    { kind: "separator" },
    ...(!project && input.canConnect ? [action("connect-to-project", readOnly)] : []),
    action("copy-to-project", readOnly || input.copyTargets === 0),
    ...(project ? [action("copy-to-playground", readOnly)] : []),
    { kind: "separator" },
    action("delete", readOnly),
  ];
}

/**
 * Projects a design can be copied into: every project but its own, minus the archived,
 * automated and missing-folder ones no picker offers (the rule of `offeredProjects`).
 */
export function copyTargetsFor(
  summary: DesignSummary,
  projects: readonly GalleryProject[],
): GalleryProject[] {
  const owner = summary.ref.owner;
  return projects.filter(
    (project) =>
      project.unavailable === undefined &&
      (owner.kind !== "project" || project.id !== owner.projectId),
  );
}

/** The owning project's workspace key, when this window can open it. */
export function projectKeyFor(
  summary: DesignSummary,
  projects: readonly GalleryProject[],
): string | null {
  const owner = summary.ref.owner;
  if (owner.kind !== "project") return null;
  return projects.find((project) => project.id === owner.projectId)?.projectKey ?? null;
}

const ICONS: Record<DesignMenuAction, ReactNode> = {
  open: <PanelTopOpenIcon aria-hidden />,
  rename: <PencilIcon aria-hidden />,
  duplicate: <CopyPlusIcon aria-hidden />,
  "copy-link": <LinkIcon aria-hidden />,
  "open-project": <FolderOpenIcon aria-hidden />,
  "connect-to-project": <FolderSymlinkIcon aria-hidden />,
  "copy-to-project": <FolderInputIcon aria-hidden />,
  "copy-to-playground": <CopyIcon aria-hidden />,
  delete: <Trash2Icon aria-hidden />,
};

/**
 * The items of the design menu, for a `MenuPopup` the caller owns. Rename…
 * and Delete… only ask: render `useDesignMenuDialogs(...).dialogs` beside the
 * menu and pass its `requestRename` and `requestDelete`.
 */
export function DesignMenuItems({
  summary,
  projects,
  canWrite,
  handlers,
  surface = "gallery",
  onRequestRename,
  onRequestDelete,
}: {
  summary: DesignSummary;
  projects: readonly GalleryProject[];
  canWrite: boolean;
  handlers: DesignMenuHandlers;
  surface?: DesignMenuSurface;
  onRequestRename: () => void;
  onRequestDelete: () => void;
}) {
  const targets = copyTargetsFor(summary, projects);
  const projectKey = projectKeyFor(summary, projects);
  const openProject = handlers.onOpenProject ?? null;
  const entries = designMenuEntries({
    surface: handlers.onOpen ? surface : "editor",
    ownerKind: summary.ref.owner.kind,
    canWrite,
    copyTargets: targets.length,
    canOpenProject: projectKey !== null && openProject !== null,
    canConnect: handlers.onConnect != null,
  });
  const run: Record<DesignMenuAction, () => void> = {
    open: () => handlers.onOpen?.(summary),
    rename: onRequestRename,
    duplicate: () => handlers.onDuplicate(summary),
    "copy-link": () => handlers.onCopyLink(summary),
    "open-project": () => {
      if (projectKey !== null) openProject?.(summary, projectKey);
    },
    "connect-to-project": () => handlers.onConnect?.(summary),
    "copy-to-project": () => undefined,
    "copy-to-playground": () => void handlers.onCopy(summary, { kind: "playground" }),
    delete: onRequestDelete,
  };

  return entries.map((entry, index) => {
    if (entry.kind === "separator") return <MenuSeparator key={`separator-${index}`} />;
    const label = DESIGN_MENU_LABELS[entry.action];
    if (entry.action === "copy-to-project") {
      return (
        <MenuSub key={entry.action}>
          <MenuSubTrigger disabled={entry.disabled}>
            {ICONS[entry.action]}
            {label}
          </MenuSubTrigger>
          <MenuSubPopup className="min-w-44">
            <MenuGroup>
              <MenuGroupLabel>Copy to</MenuGroupLabel>
              {targets.map((project) => (
                <MenuItem
                  key={project.id}
                  onClick={() =>
                    void handlers.onCopy(summary, { kind: "project", projectId: project.id })
                  }
                >
                  {project.title}
                </MenuItem>
              ))}
            </MenuGroup>
          </MenuSubPopup>
        </MenuSub>
      );
    }
    return (
      <MenuItem
        key={entry.action}
        variant={entry.action === "delete" ? "destructive" : "default"}
        disabled={entry.disabled}
        data-action={entry.action}
        onClick={run[entry.action]}
      >
        {ICONS[entry.action]}
        {label}
      </MenuItem>
    );
  });
}

/**
 * The Rename and Delete dialogs the menu opens. `returnFocus` is where focus
 * goes when a dialog closes, normally the menu's trigger.
 */
export function useDesignMenuDialogs(
  summary: DesignSummary,
  handlers: Pick<DesignMenuHandlers, "onRename" | "onDelete">,
  returnFocus?: RefObject<HTMLElement | null>,
) {
  const [open, setOpen] = useState<"rename" | "delete" | null>(null);
  const [renames, setRenames] = useState(0);
  return {
    requestRename: () => {
      setRenames((count) => count + 1);
      setOpen("rename");
    },
    requestDelete: () => setOpen("delete"),
    dialogs: (
      <>
        {open === "rename" ? (
          <RenameDesignDialog
            key={renames}
            summary={summary}
            onRename={handlers.onRename}
            onClose={() => setOpen(null)}
            returnFocus={returnFocus}
          />
        ) : null}
        <DeleteDesignDialog
          summary={summary}
          open={open === "delete"}
          onOpenChange={(next) => setOpen(next ? "delete" : null)}
          onDelete={handlers.onDelete}
          returnFocus={returnFocus}
        />
      </>
    ),
  };
}

/** One title field: Enter saves, Escape cancels, a server refusal shows in place. */
export function RenameDesignDialog({
  summary,
  onRename,
  onClose,
  returnFocus,
}: {
  summary: DesignSummary;
  onRename: (summary: DesignSummary, title: string) => Promise<string | null>;
  onClose: () => void;
  returnFocus?: RefObject<HTMLElement | null> | undefined;
}) {
  const id = useId();
  const field = useRef<HTMLInputElement>(null);
  const [title, setTitle] = useState(summary.title);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  return (
    <Dialog open onOpenChange={(next) => !next && !busy && onClose()}>
      <DialogPopup
        className="sm:max-w-sm"
        data-testid="rename-design-dialog"
        initialFocus={field}
        {...(returnFocus ? { finalFocus: returnFocus } : {})}
      >
        <form
          className="flex min-h-0 flex-col"
          onSubmit={(event) => {
            event.preventDefault();
            if (busy) return;
            setBusy(true);
            setError(null);
            void onRename(summary, title).then((problem) => {
              setBusy(false);
              if (problem === null) onClose();
              else setError(problem);
            });
          }}
        >
          <DialogHeader>
            <DialogTitle>Rename design</DialogTitle>
          </DialogHeader>
          <DialogPanel>
            <div className="flex flex-col gap-1.5">
              <Label htmlFor={`${id}-title`}>Title</Label>
              <Input
                ref={field}
                id={`${id}-title`}
                value={title}
                maxLength={DESIGN_TITLE_MAX}
                placeholder="Untitled"
                onFocus={(event) => event.currentTarget.select()}
                onChange={(event) => setTitle(event.target.value)}
              />
              {error ? (
                <p role="alert" className="text-destructive-foreground text-sm">
                  {error}
                </p>
              ) : null}
            </div>
          </DialogPanel>
          <DialogFooter>
            <Button type="button" variant="outline" disabled={busy} onClick={onClose}>
              Cancel
            </Button>
            <Button type="submit" disabled={busy} data-testid="rename-design-save">
              {busy ? "Saving…" : "Save"}
            </Button>
          </DialogFooter>
        </form>
      </DialogPopup>
    </Dialog>
  );
}

function DeleteDesignDialog({
  summary,
  open,
  onOpenChange,
  onDelete,
  returnFocus,
}: {
  summary: DesignSummary;
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onDelete: (summary: DesignSummary) => Promise<string | null>;
  returnFocus?: RefObject<HTMLElement | null> | undefined;
}) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  return (
    <AlertDialog
      open={open}
      onOpenChange={(next) => {
        if (busy) return;
        if (next) setError(null);
        onOpenChange(next);
      }}
    >
      <AlertDialogPopup {...(returnFocus ? { finalFocus: returnFocus } : {})}>
        <AlertDialogHeader>
          <AlertDialogTitle>Delete “{summary.title || "Untitled"}”?</AlertDialogTitle>
          <AlertDialogDescription>
            {summary.ref.owner.kind === "project"
              ? `This deletes the design, its history and its saved versions from ${summary.ownerLabel}.`
              : "This deletes the design, its history and its saved versions from your Playground."}
          </AlertDialogDescription>
        </AlertDialogHeader>
        {error ? (
          <p role="alert" className="px-6 text-destructive-foreground text-sm">
            {error}
          </p>
        ) : null}
        <AlertDialogFooter>
          <AlertDialogClose render={<Button variant="outline" disabled={busy} />}>
            Cancel
          </AlertDialogClose>
          <Button
            variant="destructive"
            disabled={busy}
            data-testid="design-delete-confirm"
            onClick={() => {
              setBusy(true);
              setError(null);
              void onDelete(summary).then((problem) => {
                setBusy(false);
                if (problem === null) onOpenChange(false);
                else setError(problem);
              });
            }}
          >
            {busy ? "Deleting…" : "Delete"}
          </Button>
        </AlertDialogFooter>
      </AlertDialogPopup>
    </AlertDialog>
  );
}

/** The gallery card's "…" menu for one design, with its Rename and Delete dialogs. */
export function DesignActionsMenu({
  summary,
  projects,
  canWrite,
  handlers,
}: {
  summary: DesignSummary;
  projects: readonly GalleryProject[];
  canWrite: boolean;
  handlers: DesignActionHandlers;
}) {
  const trigger = useRef<HTMLButtonElement>(null);
  const dialogs = useDesignMenuDialogs(summary, handlers, trigger);
  return (
    <>
      <Menu>
        <MenuTrigger
          ref={trigger}
          render={
            <Button
              variant="ghost"
              size="icon-sm"
              aria-label={`Actions for ${summary.title || "Untitled"}`}
              data-testid="design-card-menu"
            />
          }
        >
          <EllipsisIcon aria-hidden />
        </MenuTrigger>
        <MenuPopup align="end" side="bottom" className="min-w-48">
          <DesignMenuItems
            summary={summary}
            projects={projects}
            canWrite={canWrite}
            handlers={handlers}
            onRequestRename={dialogs.requestRename}
            onRequestDelete={dialogs.requestDelete}
          />
        </MenuPopup>
      </Menu>
      {dialogs.dialogs}
    </>
  );
}
