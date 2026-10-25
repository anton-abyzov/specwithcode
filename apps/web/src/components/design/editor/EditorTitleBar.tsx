/**
 * The editor header's left side: where the design lives ("EasyChamp /
 * Designs /"), its title field and the save state. The owner crumb returns to
 * the project with its Designs tab open; "Designs" opens the gallery scoped
 * to that owner. A Playground design's crumb is a menu that also offers
 * "Connect to a project…" where the design can move.
 */
import { useRouter } from "@tanstack/react-router";
import { ChevronDownIcon, FolderSymlinkIcon, ShapesIcon } from "lucide-react";
import { useEffect, useState, type MouseEvent } from "react";

import { cn } from "~/lib/utils";

import { ProjectFavicon } from "../../ProjectFavicon";
import { Menu, MenuItem, MenuPopup, MenuTrigger } from "../../ui/menu";
import type { DesignShareInfo } from "./backend";
import type { DesignSaveState } from "./designSession";
import { useFieldDraft } from "./fieldDraft";
import { ownerLinks, plainClick } from "./ownerLinks";

const CRUMB =
  "inline-flex h-7 min-w-0 shrink items-center gap-1.5 rounded-md px-1.5 text-[13px] text-muted-foreground outline-none transition-colors duration-[120ms] ease-out-quint hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring motion-reduce:transition-none";

function Separator() {
  return (
    <span aria-hidden className="shrink-0 text-[13px] text-muted-foreground select-none">
      /
    </span>
  );
}

export function OwnerCrumbs({
  share,
  onConnect = null,
}: {
  share: DesignShareInfo;
  /** Playground designs only: opens "Connect to a project"; null where the design cannot move. */
  onConnect?: (() => void) | null;
}) {
  const router = useRouter();
  const links = ownerLinks(share);
  const owner = share.ownerProject ?? null;
  const go = (event: MouseEvent, route: Parameters<typeof router.navigate>[0]) => {
    if (!plainClick(event)) return;
    event.preventDefault();
    void router.navigate(route);
  };
  return (
    <nav
      aria-label="Design location"
      className="flex min-w-0 shrink items-center"
      data-testid="design-breadcrumb"
    >
      {owner !== null ? (
        <>
          {links.project !== null ? (
            <a
              href={links.project.href}
              className={cn(CRUMB, "max-w-48 min-w-12")}
              title={owner.label}
              data-testid="design-crumb-project"
              onClick={(event) => go(event, links.project!.route as never)}
            >
              {owner.icon ? (
                <ProjectFavicon project={owner.icon} className="size-3.5 shrink-0" />
              ) : null}
              <span className="truncate">{owner.label}</span>
            </a>
          ) : (
            <span className={cn(CRUMB, "max-w-48 hover:text-muted-foreground")}>
              <span className="truncate">{owner.label}</span>
            </span>
          )}
          <Separator />
        </>
      ) : null}
      {owner === null && onConnect !== null ? (
        <Menu>
          <MenuTrigger
            render={
              <button
                type="button"
                className={cn(CRUMB, "shrink-0")}
                data-testid="design-crumb-designs"
              />
            }
          >
            <ShapesIcon aria-hidden className="size-3.5 shrink-0" />
            <span className="truncate">Playground</span>
            <ChevronDownIcon aria-hidden className="size-3 shrink-0" />
          </MenuTrigger>
          <MenuPopup align="start" side="bottom" className="min-w-52">
            <MenuItem onClick={() => void router.navigate(links.designs.route as never)}>
              <ShapesIcon aria-hidden />
              Playground designs
            </MenuItem>
            <MenuItem data-testid="design-connect-to-project" onClick={onConnect}>
              <FolderSymlinkIcon aria-hidden />
              Connect to a project…
            </MenuItem>
          </MenuPopup>
        </Menu>
      ) : (
        <a
          href={links.designs.href}
          className={cn(CRUMB, "shrink-0")}
          data-testid="design-crumb-designs"
          onClick={(event) => go(event, links.designs.route as never)}
        >
          {owner === null ? <ShapesIcon aria-hidden className="size-3.5 shrink-0" /> : null}
          <span className="truncate">{owner === null ? "Playground" : "Designs"}</span>
        </a>
      )}
      <Separator />
    </nav>
  );
}

/** Reads as text at rest; a hairline box on hover and the input ring on focus. */
export function TitleField({
  title,
  onRename,
}: {
  title: string;
  onRename: (title: string) => void;
}) {
  const field = useFieldDraft(title);
  return (
    <input
      aria-label="Design title"
      {...field.inputProps}
      maxLength={180}
      title={title}
      className="h-7 max-w-[40ch] min-w-16 shrink-[4] truncate rounded-md border border-transparent bg-transparent px-1.5 field-sizing-content text-sm font-medium outline-none transition-[background-color,border-color,box-shadow] duration-[120ms] ease-out-quint hover:border-foreground/10 hover:bg-foreground/4 focus-visible:border-ring focus-visible:bg-background focus-visible:ring-[3px] focus-visible:ring-ring/16 motion-reduce:transition-none"
      onBlur={(event) => {
        const next = event.currentTarget.value.trim();
        field.end();
        if (next !== "" && next !== title) onRename(next);
      }}
      onKeyDown={(event) => {
        if (event.key === "Enter") event.currentTarget.blur();
        if (event.key === "Escape") {
          field.set(title);
          event.currentTarget.blur();
        }
      }}
    />
  );
}

const SAVE_LABELS: Record<DesignSaveState, string> = {
  saved: "Saved",
  saving: "Saving…",
  pending: "Unsaved changes",
  conflict: "Waiting for your choice",
  error: "Not saved",
};

/**
 * A dot and a word in a fixed slot, so the header never shifts. The word
 * crossfades between states and settles to muted 2 s after a save lands.
 */
export function SaveState({
  state,
  label = true,
  roomy = false,
}: {
  state: DesignSaveState;
  /** The words beside the dot; screen readers hear them either way. */
  label?: boolean;
  roomy?: boolean;
}) {
  const [settled, setSettled] = useState(state === "saved");
  useEffect(() => {
    if (state !== "saved") {
      setSettled(false);
      return;
    }
    const timer = window.setTimeout(() => setSettled(true), 2000);
    return () => window.clearTimeout(timer);
  }, [state]);
  const tone =
    state === "error"
      ? "text-destructive-foreground"
      : state === "conflict"
        ? "text-warning-foreground"
        : settled
          ? "text-muted-foreground"
          : "text-foreground/70";
  return (
    <span
      className={cn(
        "ml-1 inline-flex shrink-0 items-center gap-1.5",
        label && (roomy ? "w-36" : "w-28"),
      )}
      role="status"
      title={SAVE_LABELS[state]}
      data-testid="save-state"
      data-state={state}
    >
      <span
        aria-hidden
        className={cn(
          "size-1.5 shrink-0 rounded-full transition-colors duration-150 ease-out-quint",
          state === "saved"
            ? "bg-muted-foreground/50"
            : state === "error"
              ? "bg-destructive"
              : state === "conflict"
                ? "bg-warning"
                : "bg-primary",
        )}
      />
      <span
        key={state}
        className={cn(
          "save-state-label truncate text-xs font-medium transition-colors duration-300 ease-out-quint",
          !label && "sr-only",
          tone,
        )}
      >
        {SAVE_LABELS[state]}
      </span>
    </span>
  );
}
