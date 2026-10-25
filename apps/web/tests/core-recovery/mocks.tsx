// Stand-ins for the drawer's stores and RPCs. Each view sets `window.fixture`.
declare global {
  interface Window {
    fixture: {
      readonly projection: unknown;
      readonly titles: Record<string, string>;
      readonly results: Record<string, unknown>;
    };
    calls: Array<[string, unknown]>;
  }
}

export const useThreadProjection = () => ({ projection: window.fixture.projection });
export const useThreadShell = (ref: { readonly threadId?: string } | null) => ({
  title: (ref?.threadId && window.fixture.titles[ref.threadId]) || "Another thread",
});
export const threadEnvironment = {
  cancelQueuedRun: "cancel",
  promoteQueuedRun: "promote",
  reorderQueuedRun: "reorder",
};
export const useAtomCommand = (command: string) => async (value: { readonly input: unknown }) => {
  window.calls.push([command, value.input]);
  return window.fixture.results[command] ?? { _tag: "Success", value: { sequence: 1 } };
};
export const useAssetUrls = () => [];
export const isAtomCommandInterrupted = () => false;
export const squashAtomCommandFailure = (result: { readonly error: unknown }) => result.error;
export type AtomCommandResult<_A, _E> = unknown;
