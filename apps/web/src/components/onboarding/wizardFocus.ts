/**
 * Setup opens on the step, never on the update notice above it, so Enter or
 * Space on arrival cannot restart the app.
 */
export function firstStepControl(): HTMLElement | null {
  return document.querySelector<HTMLElement>(
    '[data-slot="dialog-popup"] [data-slot="dialog-panel"] :is(button, input, select, textarea, a[href]):not(:disabled)',
  );
}

/**
 * Where a step starts: its first field that must be filled, else its primary
 * button, else its first control.
 */
export function stepStartControl(): HTMLElement | null {
  const popup = '[data-slot="dialog-popup"]';
  return (
    document.querySelector<HTMLElement>(
      `${popup} [data-slot="dialog-panel"] :is(input, textarea, select):required:not(:disabled)`,
    ) ??
    document.querySelector<HTMLElement>(`${popup} [data-wizard-primary]:not(:disabled)`) ??
    firstStepControl()
  );
}
