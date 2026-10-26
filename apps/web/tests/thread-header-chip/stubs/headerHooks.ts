// The header's commands and navigation, inert: the fixture checks layout, hover and focus only.
export function useThreadActionMenu() {
  return { openMenu: () => {} };
}
export const threadEnvironment = { updateMetadata: {} };
export function useOrchestrationCommand() {
  return async () => ({ _tag: "Success" });
}
export function useOpenThread() {
  return { openThread: () => {} };
}
export function usePrimaryEnvironmentId() {
  return "env-m4";
}
