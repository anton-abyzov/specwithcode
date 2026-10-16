/**
 * The element focused before Settings opened, so closing it returns there.
 * Settings is a route, so the opener may unmount (a menu item) or remount (a
 * composer on the page Settings covered); an id or label finds the new copy.
 */
let opener: HTMLElement | null = null;

export const SETTINGS_DIALOG_SELECTOR = "[data-settings-dialog]";
const TRANSIENT_SURFACES =
  '[role="dialog"], [role="alertdialog"], [role="menu"], [role="listbox"], [data-slot$="popup"]';

export function rememberSettingsOpener(element: Element | null): void {
  if (!(element instanceof HTMLElement) || element === document.body) return;
  // A menu item or palette row unmounts as Settings opens; keep its trigger.
  if (element.closest(`${SETTINGS_DIALOG_SELECTOR}, ${TRANSIENT_SURFACES}`)) return;
  opener = element;
}

export function readSettingsOpener(): HTMLElement | null {
  return opener;
}

function findReplacement(element: HTMLElement): HTMLElement | null {
  if (element.id) return document.getElementById(element.id);
  const label = element.getAttribute("aria-label");
  if (label) {
    return document.querySelector<HTMLElement>(
      `${element.tagName.toLowerCase()}[aria-label="${CSS.escape(label)}"]`,
    );
  }
  return null;
}

export function resolveSettingsReturnTarget(element: HTMLElement | null): HTMLElement | null {
  if (element === null) return null;
  const target = element.isConnected ? element : findReplacement(element);
  if (!target || target.closest(SETTINGS_DIALOG_SELECTOR) || target.closest("[inert]")) return null;
  return target;
}

/** Retries for a few frames while the page under Settings mounts again. */
export function restoreSettingsFocus(element: HTMLElement | null, frames = 10): void {
  if (element === null) return;
  const attempt = (left: number) => {
    const target = resolveSettingsReturnTarget(element);
    if (target) {
      target.focus({ preventScroll: true });
      if (document.activeElement === target) return;
    }
    if (left > 0) requestAnimationFrame(() => attempt(left - 1));
  };
  requestAnimationFrame(() => attempt(frames));
}
