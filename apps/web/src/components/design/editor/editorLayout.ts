/** The canvas never gets narrower than this while a narrower arrangement exists. */
export const MIN_CANVAS_WIDTH = 480;
/**
 * Arrangements that leave the canvas this much room are preferred: zoom to
 * fit (48 px padding a side) shows a 1920 px slide at 25% or more.
 */
export const COMFORTABLE_CANVAS_WIDTH = 584;
export const MIN_CHAT_WIDTH = 280;
export const RAIL_WIDTH = 208;
export const COMPACT_RAIL_WIDTH = 72;
export const SIDE_PANEL_WIDTH = 256;

/**
 * What the editor header shows, by the header's own width: the app sidebar
 * takes from the window, so window breakpoints would clip Share.
 */
export interface HeaderLayout {
  /** Undo, Redo, History, Export, Implement, Present and the system picker; else in More. */
  readonly tools: boolean;
  /** The owner breadcrumb; else "Connect to a project…" moves into More. */
  readonly crumbs: boolean;
  /** The save state's words beside its dot. */
  readonly saveLabel: boolean;
  /** Room for the wider system picker and save state. */
  readonly roomy: boolean;
}

export const HEADER_TOOLS_WIDTH = 720;
export const HEADER_CRUMBS_WIDTH = 880;
export const HEADER_SAVE_LABEL_WIDTH = 1024;
export const HEADER_ROOMY_WIDTH = 1280;

export function headerLayout(width: number): HeaderLayout {
  return {
    tools: width >= HEADER_TOOLS_WIDTH,
    crumbs: width >= HEADER_CRUMBS_WIDTH,
    saveLabel: width >= HEADER_SAVE_LABEL_WIDTH,
    roomy: width >= HEADER_ROOMY_WIDTH,
  };
}

export interface EditorLayout {
  /** "overlay": the thread does not fit beside the canvas and opens over it on request. */
  readonly chat: "column" | "overlay" | "hidden";
  readonly chatWidth: number;
  readonly rail: "full" | "compact" | null;
  /** "overlay": the properties or comments panel opens over the canvas on request. */
  readonly side: "column" | "overlay";
  readonly canvasWidth: number;
}

/**
 * How the editor's columns share `width`: the thread, the slide rail, the
 * canvas and the side panel. Takes the first arrangement, in order of
 * preference, that leaves the canvas comfortable room, else the first that
 * leaves it its minimum, else the narrowest. The thread shrinks before the
 * rail turns into a strip, both go before the side panel leaves its column.
 */
export function editorLayout({
  width,
  chatWidth,
  chatOpen,
  slides,
}: {
  width: number;
  /** The width the person chose for the thread. */
  chatWidth: number;
  /** False when the person hid the thread ("Canvas only"). */
  chatOpen: boolean;
  slides: boolean;
}): EditorLayout {
  const fullRail = slides ? ("full" as const) : null;
  const compactRail = slides ? ("compact" as const) : null;
  const railWidth = (rail: EditorLayout["rail"]) =>
    rail === "full" ? RAIL_WIDTH : rail === "compact" ? COMPACT_RAIL_WIDTH : 0;
  const offChat = chatOpen ? ("overlay" as const) : ("hidden" as const);
  const arrange = (
    chat: EditorLayout["chat"],
    rail: EditorLayout["rail"],
    side: EditorLayout["side"],
    room = chatWidth,
  ): EditorLayout => {
    // The divider and the side panel's border take a pixel each.
    const chatPixels = chat === "column" ? room + 1 : 0;
    const sidePixels = side === "column" ? SIDE_PANEL_WIDTH + 1 : 0;
    return {
      chat,
      chatWidth: room,
      rail,
      side,
      canvasWidth: width - chatPixels - railWidth(rail) - sidePixels,
    };
  };
  const shrunk = (rail: EditorLayout["rail"], target: number) =>
    Math.max(
      MIN_CHAT_WIDTH,
      Math.min(chatWidth, width - target - railWidth(rail) - SIDE_PANEL_WIDTH - 2),
    );
  const candidates = (target: number): EditorLayout[] => [
    ...(chatOpen
      ? [
          arrange("column", fullRail, "column"),
          arrange("column", fullRail, "column", shrunk(fullRail, target)),
          arrange("column", compactRail, "column", shrunk(compactRail, target)),
        ]
      : []),
    arrange(offChat, fullRail, "column"),
    arrange(offChat, compactRail, "column"),
    arrange(offChat, fullRail, "overlay"),
    arrange(offChat, compactRail, "overlay"),
  ];
  for (const target of [COMFORTABLE_CANVAS_WIDTH, MIN_CANVAS_WIDTH]) {
    const fit = candidates(target).find((layout) => layout.canvasWidth >= target);
    if (fit !== undefined) return fit;
  }
  return arrange(offChat, compactRail, "overlay");
}
