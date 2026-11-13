/* Dictation as the desktop app offers it; the browser fixture has no desktop bridge. */
export * from "../../src/components/studio/VoiceDictation";

export function useVoiceDictation() {
  return {
    available: true,
    active: false,
    phase: "idle",
    start: async () => {},
    stop: async () => {},
    consentOpen: false,
    setupBytes: 0,
    cancelConsent: () => {},
    allow: () => {},
  } as never;
}
