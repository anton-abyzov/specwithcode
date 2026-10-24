import { DEFAULT_SERVER_SETTINGS } from "@specweave-studio/contracts";
export const mode = new URLSearchParams(location.search).get("mode") ?? "fresh";
export const isElectron = true;
export const primaryServerConfigAtom = {};
export const connectionAtomRuntime = {};
export const appAtomRegistry = {};
export const useAtomValue = () => ({});
export const usePrimaryEnvironmentId = () => "isolated-fixture";
export const useClientSettings = () => false;
export const useUpdateClientSettings = () => () => {
  document.body.dataset.consent = "true";
};
export const usePrimarySettings = () =>
  mode === "cloud-missing"
    ? { ...DEFAULT_SERVER_SETTINGS.voice, provider: "elevenlabs", elevenLabsApiKey: "" }
    : DEFAULT_SERVER_SETTINGS.voice;
export const createEnvironmentRpcCommand = () => ({});
export const runAtomCommand = async () => {
  throw new Error("No cloud requests allowed in this fixture");
};
export const squashAtomCommandFailure = (failure: unknown) => failure;
export const openCallMicrophone = async () => {
  document.body.dataset.microphone = "opened";
  return {
    sampleRate: 16000,
    close: () => {
      document.body.dataset.microphone = "closed";
    },
  };
};
export const playCallAudio = async () => {};
export const VoiceSettings = () => (
  <span style={{ color: "#929292", fontSize: 13 }}>Voice settings</span>
);
