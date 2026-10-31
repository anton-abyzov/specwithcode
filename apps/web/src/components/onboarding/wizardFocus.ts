/**
 * Setup opens on the step, never on the update notice above it, so Enter or
 * Space on arrival cannot restart the app.
 */
export function firstStepControl(): HTMLElement | null {
  return document.querySelector<HTMLElement>(
    '[data-slot="dialog-popup"] [data-slot="dialog-panel"] :is(button, input, select, textarea, a[href]):not(:disabled)',
  );
}
