import { useNavigate } from "@tanstack/react-router";
import { scopeThreadRef } from "@specweave-studio/client-runtime/environment";
import { ChevronDownIcon, ChevronUpIcon, MessageSquareIcon, SearchIcon, XIcon } from "lucide-react";
import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import { createPortal } from "react-dom";

import { openCommandPalette, isCommandPaletteOpen } from "../../commandPaletteBus";
import { isTerminalFocused } from "../../lib/terminalFocus";
import { useThreadShells } from "../../state/entities";
import { buildThreadRouteParams } from "../../threadRoutes";
import { searchSidebarThreads } from "../Sidebar.logic";
import { Button } from "../ui/button";
import {
  FIND_CURRENT_HIGHLIGHT,
  FIND_HIGHLIGHT,
  FIND_SCOPE_ATTRIBUTE,
  collectFindRanges,
  findCountLabel,
  pickFindScope,
  scrollContainerOf,
  scrollRangeIntoView,
  stepMatchIndex,
} from "./conversationFind.logic";
import { setConversationFindState } from "./conversationFindStore";

const THREAD_MATCH_LIMIT = 5;
const RESCAN_DELAY_MS = 120;

function isFindShortcut(event: KeyboardEvent): boolean {
  return (
    (event.metaKey || event.ctrlKey) &&
    !event.altKey &&
    !event.shiftKey &&
    event.key.toLowerCase() === "f"
  );
}

function isFindNextShortcut(event: KeyboardEvent): boolean {
  return (event.metaKey || event.ctrlKey) && !event.altKey && event.key.toLowerCase() === "g";
}

function highlightRegistry(): HighlightRegistry | null {
  return typeof CSS !== "undefined" && CSS.highlights && typeof Highlight !== "undefined"
    ? CSS.highlights
    : null;
}

function clearHighlights(): void {
  const registry = highlightRegistry();
  registry?.delete(FIND_HIGHLIGHT);
  registry?.delete(FIND_CURRENT_HIGHLIGHT);
}

function sameRange(a: Range | undefined, b: Range): boolean {
  return (
    a !== undefined &&
    a.startContainer === b.startContainer &&
    a.startOffset === b.startOffset &&
    a.endContainer === b.endContainer
  );
}

/** The first match at or below the top of what the reader is looking at. */
function firstVisibleMatch(ranges: readonly Range[], scope: HTMLElement): number {
  if (ranges.length === 0) return -1;
  const container = scrollContainerOf(scope) ?? scope;
  const top = container.getBoundingClientRect().top;
  const index = ranges.findIndex((range) => range.getBoundingClientRect().bottom >= top);
  return index === -1 ? 0 : index;
}

interface BarPosition {
  readonly top: number;
  readonly right: number;
}

function barPositionFor(scope: HTMLElement): BarPosition {
  const own = scope.getBoundingClientRect();
  const container = scrollContainerOf(scope)?.getBoundingClientRect();
  const top = Math.max(own.top, container?.top ?? own.top, 0);
  const right = Math.min(own.right, container?.right ?? own.right, window.innerWidth);
  return { top: top + 8, right: Math.max(window.innerWidth - right, 0) + 16 };
}

/**
 * Cmd/Ctrl+F find bar for the conversation on screen: highlights every hit in the
 * coordinator or thread transcript, steps through them, and lists threads whose names match.
 * Conversations opt in with `data-conversation-find-scope`; elsewhere the shortcut is left
 * to the page (pull requests, keybinding settings) or does nothing.
 */
export function ConversationFindBar() {
  const [scope, setScope] = useState<HTMLElement | null>(null);
  const [query, setQuery] = useState("");
  const [ranges, setRanges] = useState<Range[]>([]);
  const [capped, setCapped] = useState(false);
  const [current, setCurrent] = useState(-1);
  const [position, setPosition] = useState<BarPosition | null>(null);
  const inputRef = useRef<HTMLInputElement | null>(null);
  const lastInteractionRef = useRef<Node | null>(null);
  const restoreFocusRef = useRef<HTMLElement | null>(null);
  const focusPendingRef = useRef(false);
  const [, setFocusToken] = useState(0);
  const rangesRef = useRef<Range[]>([]);
  const currentRef = useRef(-1);
  useLayoutEffect(() => {
    rangesRef.current = ranges;
    currentRef.current = current;
  }, [current, ranges]);
  const open = scope !== null;

  const close = useCallback(() => {
    setScope(null);
    setRanges([]);
    setCurrent(-1);
    clearHighlights();
    setConversationFindState({ query: "", scope: null });
    const restore = restoreFocusRef.current;
    restoreFocusRef.current = null;
    if (restore?.isConnected) restore.focus({ preventScroll: true });
  }, []);

  useEffect(() => {
    const remember = (event: Event) => {
      if (event.target instanceof Node) lastInteractionRef.current = event.target;
    };
    window.addEventListener("pointerdown", remember, true);
    window.addEventListener("focusin", remember, true);
    return () => {
      window.removeEventListener("pointerdown", remember, true);
      window.removeEventListener("focusin", remember, true);
    };
  }, []);

  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.defaultPrevented || event.isComposing) return;
      if (isFindShortcut(event)) {
        if (isTerminalFocused() || isCommandPaletteOpen()) return;
        const target = pickFindScope(document, lastInteractionRef.current);
        if (!target) return;
        event.preventDefault();
        event.stopPropagation();
        if (!inputRef.current?.contains(document.activeElement)) {
          const active = document.activeElement;
          restoreFocusRef.current = active instanceof HTMLElement ? active : null;
        }
        setScope(target);
        const selection = window.getSelection()?.toString().trim() ?? "";
        if (selection.length > 0 && !selection.includes("\n") && selection.length <= 200) {
          setQuery(selection);
        }
        focusPendingRef.current = true;
        setFocusToken((token) => token + 1);
        return;
      }
      if (open && isFindNextShortcut(event)) {
        event.preventDefault();
        event.stopPropagation();
        setCurrent((index) =>
          stepMatchIndex(index, rangesRef.current.length, event.shiftKey ? -1 : 1),
        );
      }
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [open]);

  // A conversation that unmounts (route change, panel closed) takes the find bar with it.
  useEffect(() => {
    if (!scope) return;
    const observer = new MutationObserver(() => {
      if (!scope.isConnected || !scope.hasAttribute(FIND_SCOPE_ATTRIBUTE)) close();
    });
    observer.observe(document.body, { childList: true, subtree: true });
    return () => observer.disconnect();
  }, [close, scope]);

  useLayoutEffect(() => {
    if (!scope) return;
    const update = () => setPosition(barPositionFor(scope));
    update();
    const observer = new ResizeObserver(update);
    observer.observe(scrollContainerOf(scope) ?? scope);
    window.addEventListener("resize", update);
    window.addEventListener("scroll", update, { capture: true, passive: true });
    return () => {
      observer.disconnect();
      window.removeEventListener("resize", update);
      window.removeEventListener("scroll", update, { capture: true });
    };
  }, [scope]);

  // Focus as soon as the input exists, so keys typed right after Cmd+F land in it.
  useLayoutEffect(() => {
    const input = inputRef.current;
    if (!focusPendingRef.current || !input) return;
    focusPendingRef.current = false;
    input.focus();
    input.select();
  });

  useEffect(() => {
    if (!scope) return;
    setConversationFindState({ query, scope });
  }, [query, scope]);

  // Scan on query change; rescan (keeping the current hit) as the transcript streams,
  // folds open, or a virtualized list mounts the rows that hold matches.
  useEffect(() => {
    if (!scope) return;
    let timer: number | undefined;
    const scan = (fresh: boolean) => {
      const result = collectFindRanges(scope, query);
      const previous = rangesRef.current[currentRef.current];
      setRanges(result.ranges);
      setCapped(result.capped);
      // Rows a virtualized list mounts for the query arrive after the first scan.
      if (fresh || currentRef.current < 0) {
        const first = firstVisibleMatch(result.ranges, scope);
        setCurrent(first);
        const range = result.ranges[first];
        if (range) scrollRangeIntoView(range);
        return;
      }
      const kept = previous ? result.ranges.findIndex((range) => sameRange(previous, range)) : -1;
      setCurrent(kept >= 0 ? kept : Math.min(currentRef.current, result.ranges.length - 1));
    };
    scan(true);
    if (query.trim().length === 0) return;
    const observer = new MutationObserver(() => {
      window.clearTimeout(timer);
      timer = window.setTimeout(() => scan(false), RESCAN_DELAY_MS);
    });
    observer.observe(scope, { childList: true, subtree: true, characterData: true });
    return () => {
      observer.disconnect();
      window.clearTimeout(timer);
    };
  }, [query, scope]);

  useEffect(() => {
    const registry = highlightRegistry();
    if (!registry || !open) return;
    const active = ranges[current];
    registry.set(FIND_HIGHLIGHT, new Highlight(...ranges.filter((range) => range !== active)));
    if (active) registry.set(FIND_CURRENT_HIGHLIGHT, new Highlight(active));
    else registry.delete(FIND_CURRENT_HIGHLIGHT);
  }, [current, open, ranges]);

  useEffect(() => clearHighlights, []);

  const step = (direction: 1 | -1) => {
    const next = stepMatchIndex(current, ranges.length, direction);
    setCurrent(next);
    const range = ranges[next];
    if (range) scrollRangeIntoView(range);
  };

  const navigate = useNavigate();
  const threads = useThreadShells(open);
  const threadMatches = useMemo(() => {
    if (!open || query.trim().length === 0) return [];
    const live = threads
      .filter((thread) => thread.archivedAt === null)
      .toSorted((a, b) => b.updatedAt.localeCompare(a.updatedAt));
    return searchSidebarThreads(live, query).slice(0, THREAD_MATCH_LIMIT);
  }, [open, query, threads]);

  if (!open || !position) return null;

  const trimmed = query.trim();
  return createPortal(
    <div
      role="search"
      aria-label="Find in conversation"
      data-conversation-find-bar=""
      className="fixed z-50 w-80 max-w-[calc(100vw-2rem)] rounded-lg border bg-popover text-popover-foreground shadow-lg"
      style={{ top: position.top, right: position.right }}
    >
      <div className="flex items-center gap-1 p-1.5">
        <SearchIcon className="ml-1 size-3.5 shrink-0 text-muted-foreground" aria-hidden />
        <input
          ref={inputRef}
          value={query}
          onChange={(event) => setQuery(event.target.value)}
          onKeyDown={(event) => {
            if (event.key === "Escape") {
              event.preventDefault();
              event.stopPropagation();
              close();
            } else if (event.key === "Enter" && !event.nativeEvent.isComposing) {
              event.preventDefault();
              if (event.metaKey || event.ctrlKey) {
                const first = threadMatches[0];
                if (first) {
                  close();
                  void navigate({
                    to: "/$environmentId/$threadId",
                    params: buildThreadRouteParams(scopeThreadRef(first.environmentId, first.id)),
                  });
                }
                return;
              }
              step(event.shiftKey ? -1 : 1);
            }
          }}
          placeholder="Find in conversation"
          aria-label="Find in conversation"
          spellCheck={false}
          className="min-w-0 flex-1 bg-transparent px-1 py-1 text-sm outline-none placeholder:text-muted-foreground"
        />
        {trimmed.length > 0 ? (
          <span
            className="shrink-0 px-1 text-xs tabular-nums text-muted-foreground"
            aria-live="polite"
            data-conversation-find-count=""
          >
            {findCountLabel(current, ranges.length, capped)}
          </span>
        ) : null}
        <Button
          variant="ghost"
          size="icon-xs"
          aria-label="Previous match"
          title="Previous match (Shift+Enter)"
          disabled={ranges.length === 0}
          onClick={() => step(-1)}
        >
          <ChevronUpIcon />
        </Button>
        <Button
          variant="ghost"
          size="icon-xs"
          aria-label="Next match"
          title="Next match (Enter)"
          disabled={ranges.length === 0}
          onClick={() => step(1)}
        >
          <ChevronDownIcon />
        </Button>
        <Button
          variant="ghost"
          size="icon-xs"
          aria-label="Close find"
          title="Close (Esc)"
          onClick={close}
        >
          <XIcon />
        </Button>
      </div>
      {trimmed.length > 0 ? (
        <div className="border-t p-1 text-sm" aria-label="Threads">
          {threadMatches.length > 0 ? (
            <ul className="flex flex-col">
              {threadMatches.map((thread, index) => (
                <li key={`${thread.environmentId}:${thread.id}`}>
                  <button
                    type="button"
                    className="flex w-full items-center gap-2 rounded-md px-2 py-1 text-left hover:bg-accent focus-visible:bg-accent focus-visible:outline-none"
                    onClick={() => {
                      close();
                      void navigate({
                        to: "/$environmentId/$threadId",
                        params: buildThreadRouteParams(
                          scopeThreadRef(thread.environmentId, thread.id),
                        ),
                      });
                    }}
                  >
                    <MessageSquareIcon
                      className="size-3.5 shrink-0 text-muted-foreground"
                      aria-hidden
                    />
                    <span className="min-w-0 flex-1 truncate">{thread.title}</span>
                    {index === 0 ? (
                      <kbd className="shrink-0 text-3xs text-muted-foreground">⌘↵</kbd>
                    ) : null}
                  </button>
                </li>
              ))}
            </ul>
          ) : null}
          <button
            type="button"
            className="flex w-full items-center gap-2 rounded-md px-2 py-1 text-left text-muted-foreground hover:bg-accent hover:text-foreground focus-visible:bg-accent focus-visible:outline-none"
            onClick={() => {
              close();
              openCommandPalette({ query: trimmed });
            }}
          >
            <SearchIcon className="size-3.5 shrink-0" aria-hidden />
            <span className="min-w-0 flex-1 truncate">Search all threads for “{trimmed}”</span>
          </button>
        </div>
      ) : null}
    </div>,
    document.body,
  );
}
