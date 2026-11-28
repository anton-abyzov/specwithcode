/**
 * The command palette's whiteboard rows: the Whiteboards picker the
 * `whiteboard.new` shortcut opens ("New whiteboard" first, then the project's
 * boards, newest first) and the boards a typed root query finds by name.
 */
import type { ReactNode } from "react";

import { formatRelativeTimeLabel } from "../../../timestampFormat";
import type { CommandPaletteActionItem, CommandPaletteGroup } from "../../CommandPalette.logic";
import { whiteboardSearchTerms, type WhiteboardEntry } from "./quickWhiteboard";

/** The picker view's group: the palette fills it with live rows while it is open. */
export const WHITEBOARD_PICKER_GROUP = "whiteboards";
/** The root search's group of boards found by name. */
export const WHITEBOARD_SEARCH_GROUP = "whiteboards-search";
/** Boards a root query lists; the picker lists every one. */
export const WHITEBOARD_SEARCH_LIMIT = 8;

/** One row per board, opening it on its project's page. */
export function whiteboardBoardItems(input: {
  readonly projectKey: string;
  readonly projectName: string;
  readonly boards: ReadonlyArray<WhiteboardEntry>;
  readonly icon: ReactNode;
  readonly openBoard: (path: string) => Promise<void>;
}): CommandPaletteActionItem[] {
  return input.boards.map((board) => ({
    kind: "action",
    value: `whiteboard:${input.projectKey}:${board.path}`,
    searchTerms: whiteboardSearchTerms(board),
    title: board.name.replace(/\.excalidraw$/i, ""),
    description:
      board.folder === null ? input.projectName : `${board.folder} · ${input.projectName}`,
    ...(board.modifiedAt > 0
      ? {
          timestamp: formatRelativeTimeLabel(new Date(board.modifiedAt).toISOString()),
          searchRecency: board.modifiedAt,
        }
      : {}),
    icon: input.icon,
    run: () => input.openBoard(board.path),
  }));
}

/** Keeps the first `limit` rows of one group, as the search ranked them. */
export function limitGroupItems(
  groups: ReadonlyArray<CommandPaletteGroup>,
  value: string,
  limit: number,
): CommandPaletteGroup[] {
  return groups.map((group) =>
    group.value === value && group.items.length > limit
      ? { ...group, items: group.items.slice(0, limit) }
      : group,
  );
}
