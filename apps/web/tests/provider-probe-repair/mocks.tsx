/**
 * The install step fixture's stand-ins, with one change: the agent search finds
 * Codex in an fnm per-shell folder, as it did on a real Linux machine.
 */
export * from "../provider-install-step/mocks";

export const useFoundAgentPath = () =>
  "/run/user/1000/fnm_multishells/665561_1795096049920/bin/codex";

// Settings layout scope helpers the shared stand-ins do not cover yet.
export const isProjectFieldSettingKey = () => false;
export const scopedSettingFieldMixed = () => false;
export const scopedSettingFieldSource = () => null;
