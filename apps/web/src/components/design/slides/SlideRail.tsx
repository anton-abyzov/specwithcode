import type { DesignDocument, DesignOperation, DesignSystem } from "@specweave-studio/contracts";
import type { SlideLayoutId } from "@specweave-studio/shared/slideLayouts";
import { EllipsisIcon, EyeOffIcon, PlusIcon } from "lucide-react";
import { useEffect, useRef, useState, type KeyboardEvent } from "react";
import { Button } from "~/components/ui/button";
import { Menu, MenuPopup, MenuTrigger } from "~/components/ui/menu";
import { Popover, PopoverPopup, PopoverTrigger } from "~/components/ui/popover";
import { Tooltip, TooltipPopup, TooltipTrigger } from "~/components/ui/tooltip";
import { cn } from "~/lib/utils";
import {
  addSlideAfter,
  deleteSlide,
  duplicateSlide,
  moveSlide,
  setSlideSkipped,
  type SlideChange,
} from "./slideActions";
import { SlideMenuItems, type SlideAction } from "./SlideMenu";
import { SlideLayoutGrid, SlideThumbnail } from "./SlideThumbnail";

/**
 * The drag payload type. Only this type is set, so a slide dropped on a text
 * field (the composer) inserts nothing.
 */
export const SLIDE_DRAG_TYPE = "application/x-specwithcode-slide";

const THUMB_WIDTH = 144;
const COMPACT_THUMB_WIDTH = 48;
/** The More button's left edge: item padding, number column and gap, thumbnail, less button and inset. */
const MORE_LEFT = 6 + 16 + 6 + THUMB_WIDTH - 24 - 4;

/**
 * The slide list of a slides document, beside the one design canvas. Click to
 * show a slide; drag, or Alt+Up and Alt+Down, to reorder; the slide menu
 * (the "More" button, right-click or Shift+F10) has the rest. `compact` is a
 * strip of small thumbnails for narrow windows, with the menu on right-click
 * and Shift+F10.
 */
export function SlideRail({
  document,
  pageId,
  system,
  readOnly,
  compact = false,
  onSelect,
  onCommit,
}: {
  document: DesignDocument;
  pageId: string;
  system: DesignSystem | null;
  readOnly: boolean;
  compact?: boolean;
  onSelect: (pageId: string) => void;
  onCommit: (operations: DesignOperation[]) => boolean;
}) {
  const list = useRef<HTMLOListElement>(null);
  const [dragging, setDragging] = useState<string | null>(null);
  /** Insertion slot 0..n in the current order while a drag hovers the list. */
  const [slot, setSlot] = useState<number | null>(null);
  const [menu, setMenu] = useState<{ pageId: string; anchor: HTMLElement } | null>(null);
  const [layoutsOpen, setLayoutsOpen] = useState(false);
  const focusAfter = useRef<string | null>(null);
  const pages = document.pages;

  // Keep keyboard focus on the slide that moved or was created.
  useEffect(() => {
    const id = focusAfter.current;
    if (id === null) return;
    focusAfter.current = null;
    list.current?.querySelector<HTMLElement>(`[data-slide="${id}"]`)?.focus();
  });

  const apply = (change: SlideChange | null, focus = true) => {
    if (change === null || readOnly) return;
    if (!onCommit(change.operations)) return;
    onSelect(change.pageId);
    if (focus) focusAfter.current = change.pageId;
  };

  const run = (action: SlideAction, id: string, focus = true) => {
    const index = pages.findIndex((page) => page.id === id);
    const page = pages[index];
    if (page === undefined) return;
    switch (action) {
      case "duplicate":
        return apply(duplicateSlide(document, id), focus);
      case "add-after":
        return apply(addSlideAfter(document, id, system), focus);
      case "move-up":
        return apply(moveSlide(document, id, index - 1), focus);
      case "move-down":
        return apply(moveSlide(document, id, index + 1), focus);
      case "skip":
        return apply(setSlideSkipped(document, id, page.skipped !== true), focus);
      case "delete":
        return apply(deleteSlide(document, id), focus);
    }
  };

  const addLayout = (layout: SlideLayoutId) => {
    setLayoutsOpen(false);
    apply(addSlideAfter(document, pageId, system, layout));
  };

  const onKeyDown = (event: KeyboardEvent<HTMLElement>, id: string, index: number) => {
    // Keys typed in a menu portaled from this slide bubble here through React; they are not ours.
    if (!event.currentTarget.contains(event.target as Node)) return;
    const mod = event.metaKey || event.ctrlKey;
    let handled = true;
    if (event.key === "Enter" || event.key === " ") onSelect(id);
    else if (event.altKey && event.key === "ArrowUp") run("move-up", id);
    else if (event.altKey && event.key === "ArrowDown") run("move-down", id);
    else if (event.key === "ArrowUp" || event.key === "ArrowLeft") focusSlide(index - 1);
    else if (event.key === "ArrowDown" || event.key === "ArrowRight") focusSlide(index + 1);
    else if (event.key === "Home") focusSlide(0);
    else if (event.key === "End") focusSlide(pages.length - 1);
    else if (mod && (event.key === "d" || event.key === "D")) run("duplicate", id);
    else if (event.key === "Delete" || event.key === "Backspace") run("delete", id);
    else if ((event.shiftKey && event.key === "F10") || event.key === "ContextMenu") {
      if (!readOnly) setMenu({ pageId: id, anchor: event.currentTarget });
    } else handled = false;
    if (handled) {
      event.preventDefault();
      event.stopPropagation();
    }
  };

  const focusSlide = (index: number) => {
    const target = pages[Math.max(0, Math.min(pages.length - 1, index))];
    if (target === undefined) return;
    onSelect(target.id);
    focusAfter.current = target.id;
  };

  const slotFor = (clientY: number) => {
    const items = [...(list.current?.querySelectorAll<HTMLElement>("[data-slide]") ?? [])];
    for (const [index, item] of items.entries()) {
      const box = item.getBoundingClientRect();
      if (clientY < box.top + box.height / 2) return index;
    }
    return items.length;
  };

  const drop = () => {
    if (dragging !== null && slot !== null) {
      const from = pages.findIndex((page) => page.id === dragging);
      apply(moveSlide(document, dragging, slot > from ? slot - 1 : slot), false);
    }
    setDragging(null);
    setSlot(null);
  };

  const menuPage = menu === null ? undefined : pages.find((page) => page.id === menu.pageId);

  return (
    <nav
      aria-label="Slides"
      data-testid="slide-rail"
      data-compact={compact ? "true" : undefined}
      className={cn(
        "flex shrink-0 flex-col border-r border-border/70 bg-background",
        compact ? "w-18" : "w-52",
      )}
    >
      <ol
        ref={list}
        aria-label="Slides"
        className={cn(
          "flex min-h-0 flex-1 flex-col gap-1 overflow-y-auto py-3",
          compact ? "px-1.5" : "px-2",
        )}
        onDragOver={(event) => {
          if (dragging === null) return;
          event.preventDefault();
          event.dataTransfer.dropEffect = "move";
          setSlot(slotFor(event.clientY));
        }}
        onDragLeave={(event) => {
          if (!event.currentTarget.contains(event.relatedTarget as Node | null)) setSlot(null);
        }}
        onDrop={(event) => {
          event.preventDefault();
          drop();
        }}
      >
        {pages.map((page, index) => {
          const current = page.id === pageId;
          const skipped = page.skipped === true;
          return (
            <li key={page.id} className="group relative">
              {slot === index && dragging !== null && <DropLine edge="top" />}
              {slot === pages.length && index === pages.length - 1 && dragging !== null && (
                <DropLine edge="bottom" />
              )}
              <div
                role="button"
                tabIndex={current ? 0 : -1}
                aria-current={current ? "true" : undefined}
                aria-label={`Slide ${index + 1}${skipped ? ", skipped" : ""}`}
                aria-keyshortcuts="Enter Alt+ArrowUp Alt+ArrowDown Shift+F10"
                data-testid="slide-item"
                data-slide={page.id}
                data-skipped={skipped ? "true" : undefined}
                draggable={!readOnly}
                onClick={() => onSelect(page.id)}
                onKeyDown={(event) => onKeyDown(event, page.id, index)}
                onContextMenu={(event) => {
                  if (readOnly) return;
                  event.preventDefault();
                  onSelect(page.id);
                  setMenu({ pageId: page.id, anchor: event.currentTarget });
                }}
                onDragStart={(event) => {
                  event.dataTransfer.effectAllowed = "move";
                  event.dataTransfer.setData(SLIDE_DRAG_TYPE, page.id);
                  setDragging(page.id);
                }}
                onDragEnd={() => {
                  setDragging(null);
                  setSlot(null);
                }}
                className={cn(
                  "flex cursor-default rounded-lg outline-none focus-visible:ring-2 focus-visible:ring-ring",
                  compact ? "flex-col items-center gap-0.5 p-1" : "gap-1.5 p-1.5",
                  current ? "bg-accent" : "hover:bg-accent/60",
                  dragging === page.id && "opacity-40",
                )}
              >
                <span
                  className={cn(
                    "shrink-0 text-xs tabular-nums",
                    compact ? "order-last leading-none" : "w-4 pt-0.5 text-right",
                    current ? "text-foreground" : "text-muted-foreground",
                  )}
                >
                  {index + 1}
                </span>
                <span className="relative">
                  <SlideThumbnail
                    page={page}
                    width={compact ? COMPACT_THUMB_WIDTH : THUMB_WIDTH}
                    className={cn(
                      "rounded-sm ring-1",
                      current ? "ring-2 ring-primary" : "ring-border/80",
                      skipped && "opacity-40",
                    )}
                  />
                  {skipped && (
                    <span
                      className={cn(
                        "absolute grid place-items-center rounded-sm bg-background/90 text-muted-foreground shadow-xs",
                        compact ? "top-0.5 left-0.5 size-4" : "top-1 left-1 size-5",
                      )}
                    >
                      <EyeOffIcon className="size-3" />
                    </span>
                  )}
                </span>
              </div>
              {!readOnly && !compact && (
                // Beside the slide, not inside it: one control per element, and the menu's keys
                // never reach the slide's own shortcuts.
                <span
                  className={cn(
                    "absolute top-2.5 rounded-md opacity-0 shadow-xs group-hover:opacity-100 focus-within:opacity-100 has-data-[popup-open]:opacity-100",
                    current && "opacity-100",
                  )}
                  style={{ left: MORE_LEFT }}
                >
                  <Menu>
                    <MenuTrigger
                      render={
                        <Button
                          variant="secondary"
                          size="icon-xs"
                          tabIndex={current ? 0 : -1}
                          aria-label={`More for slide ${index + 1}`}
                          data-testid="slide-more"
                          onClick={() => onSelect(page.id)}
                        />
                      }
                    >
                      <EllipsisIcon />
                    </MenuTrigger>
                    <MenuPopup align="start" className="min-w-52">
                      <SlideMenuItems
                        index={index}
                        count={pages.length}
                        skipped={skipped}
                        onAction={(action) => run(action, page.id)}
                      />
                    </MenuPopup>
                  </Menu>
                </span>
              )}
            </li>
          );
        })}
      </ol>
      {!readOnly && (
        <div className={cn("border-t border-border/70", compact ? "p-1.5" : "p-2")}>
          <Popover open={layoutsOpen} onOpenChange={setLayoutsOpen}>
            {compact ? (
              <Tooltip>
                <TooltipTrigger
                  render={
                    <PopoverTrigger
                      render={
                        <Button
                          variant="outline"
                          size="icon-sm"
                          className="w-full"
                          aria-label="New slide"
                          data-testid="new-slide"
                        />
                      }
                    />
                  }
                >
                  <PlusIcon />
                </TooltipTrigger>
                <TooltipPopup side="right">New slide</TooltipPopup>
              </Tooltip>
            ) : (
              <PopoverTrigger
                render={
                  <Button variant="outline" size="sm" className="w-full" data-testid="new-slide" />
                }
              >
                <PlusIcon />
                New slide
              </PopoverTrigger>
            )}
            <PopoverPopup side="right" align="end" className="w-[30rem]">
              <p className="mb-2 text-sm font-medium">
                Add a slide after slide {pages.findIndex((page) => page.id === pageId) + 1}
              </p>
              <SlideLayoutGrid system={system} width={136} columns={3} onPick={addLayout} />
            </PopoverPopup>
          </Popover>
        </div>
      )}
      {menu !== null && menuPage !== undefined && (
        <Menu open onOpenChange={(open) => !open && setMenu(null)}>
          <MenuPopup anchor={menu.anchor} align="start" className="min-w-52">
            <SlideMenuItems
              index={pages.indexOf(menuPage)}
              count={pages.length}
              skipped={menuPage.skipped === true}
              onAction={(action) => run(action, menuPage.id)}
            />
          </MenuPopup>
        </Menu>
      )}
    </nav>
  );
}

function DropLine({ edge }: { edge: "top" | "bottom" }) {
  return (
    <span
      aria-hidden
      data-testid="slide-drop-line"
      className={cn(
        "pointer-events-none absolute inset-x-1 z-10 h-0.5 rounded-full bg-primary",
        edge === "top" ? "-top-0.5" : "-bottom-0.5",
      )}
    />
  );
}
