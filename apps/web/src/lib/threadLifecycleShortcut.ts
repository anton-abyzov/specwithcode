/** A lifecycle key press is deliberate, never a repeating toggle. */
const pendingThreads = new Set<string>();

interface LifecycleShortcutContext {
  readonly editableFocus?: boolean;
  readonly terminalFocus?: boolean;
  readonly modelPickerOpen?: boolean;
}

export function runThreadLifecycleShortcut(
  event: KeyboardEvent,
  options: {
    readonly threadKey: string;
    readonly context: LifecycleShortcutContext;
    readonly run: () => Promise<unknown>;
  },
): Promise<boolean> {
  const target = event.target instanceof Element ? event.target : null;
  if (
    event.defaultPrevented ||
    event.isComposing ||
    options.context.editableFocus ||
    options.context.terminalFocus ||
    options.context.modelPickerOpen ||
    target?.closest(
      'input, textarea, select, [contenteditable]:not([contenteditable="false"]), [role="textbox"], .xterm, [data-terminal-id]',
    ) ||
    document.querySelector(
      '[role="dialog"][aria-modal="true"], [role="alertdialog"][aria-modal="true"], dialog[open]',
    )
  )
    return Promise.resolve(false);
  event.preventDefault();
  event.stopPropagation();
  if (event.repeat || pendingThreads.has(options.threadKey)) return Promise.resolve(false);
  pendingThreads.add(options.threadKey);
  return Promise.resolve()
    .then(options.run)
    .then(() => true)
    .finally(() => {
      pendingThreads.delete(options.threadKey);
    });
}
