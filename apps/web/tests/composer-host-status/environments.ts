/* The fleet as the harness sets it: the viewed machine's label, and this device. */
export * from "../../src/state/environments";

declare global {
  interface Window {
    __fixtureMachine?: string;
  }
}

export function usePrimaryEnvironmentId() {
  return "this-mac" as never;
}

export function useEnvironment(environmentId: string | null | undefined) {
  if (!environmentId) return null;
  return { environmentId, label: window.__fixtureMachine ?? environmentId } as never;
}
