/**
 * Small page actions every table shares: copying with a toast, and jumping
 * to a token row with a short flash so the eye finds it.
 */
import { toastManager } from "../../../ui/toast";

export const FLASH_MS = 1_200;

export async function copyText(value: string): Promise<void> {
  try {
    await navigator.clipboard.writeText(value);
    toastManager.add({ type: "success", title: `${value} copied` });
  } catch {
    toastManager.add({ type: "error", title: "Could not copy", description: value });
  }
}

const rowSelector = (name: string) =>
  `[data-token-row="${typeof CSS !== "undefined" && CSS.escape ? CSS.escape(name) : name}"]`;

/** Scrolls a token's row into view and flashes it; says so when the system has no such token. */
export function goToToken(name: string, root: ParentNode = document): boolean {
  const row = root.querySelector<HTMLElement>(rowSelector(name));
  if (row === null) {
    toastManager.add({ type: "info", title: `${name} is not in this system` });
    return false;
  }
  const reduced =
    typeof window.matchMedia === "function" &&
    window.matchMedia("(prefers-reduced-motion: reduce)").matches;
  row.scrollIntoView?.({ block: "center", behavior: reduced ? "auto" : "smooth" });
  row.dataset.flash = "true";
  window.setTimeout(() => {
    delete row.dataset.flash;
  }, FLASH_MS);
  return true;
}
