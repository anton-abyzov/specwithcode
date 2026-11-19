/* The window for the remote-coordinator case: served by "this-mac" (M5), showing linux-mini. */
export * from "../../src/state/environments";

const LABELS: Record<string, string> = { "this-mac": "M5", "linux-mini": "linux-mini" };

export function usePrimaryEnvironmentId() {
  return "this-mac" as never;
}

export function useEnvironment(environmentId: string | null | undefined) {
  if (!environmentId) return null;
  return { environmentId, label: LABELS[environmentId] ?? environmentId } as never;
}

