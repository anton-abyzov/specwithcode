export type ChatLayoutMode = "workspace" | "embedded";
/** The project worker is a containing block, not a second window title bar. */
export const chatControlAnchor = (mode: ChatLayoutMode) =>
  mode === "embedded"
    ? "absolute top-0 right-2"
    : "fixed top-[var(--workspace-controls-top)] right-[var(--workspace-controls-right)]";
export const chatUsesPanelSheet = (
  mode: ChatLayoutMode,
  paneWidth: number | null,
  viewportSheet: boolean,
) => (mode === "embedded" ? (paneWidth ?? 0) <= 980 : viewportSheet);
