/** Marks the popup of every AppSheet (Settings, Usage). */
export const APP_SHEET_SELECTOR = "[data-app-sheet]";

/**
 * Whether a sheet covers the app. The page underneath stays mounted, so its window
 * key listeners check this; the event path is not enough, because the sheet's own
 * menus and dialogs portal next to its popup, not inside it.
 */
export function isAppSheetOpen(doc: Document = document): boolean {
  return doc.querySelector(APP_SHEET_SELECTOR) !== null;
}
