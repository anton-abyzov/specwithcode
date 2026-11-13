import { DEFAULT_SERVER_SETTINGS } from "@specweave-studio/contracts";
const params = new URLSearchParams(location.search);
/** darwin, linux, windows or browser. */
export const mode = params.get("mode") ?? "darwin";
const settings = {
  voiceCallsAllowed: true,
  dictationLanguage: params.get("language") ?? "",
  dictationMode: (["auto", "hold"].includes(params.get("dictation") ?? "")
    ? params.get("dictation")
    : "toggle") as "auto" | "toggle" | "hold",
};
export const isElectron = mode !== "browser";
export const primaryServerConfigAtom = {};
export const connectionAtomRuntime = {};
export const appAtomRegistry = {};
export const useAtomValue = () => ({});
export const usePrimaryEnvironmentId = () => "isolated-fixture";
export const useClientSettings = (select: (value: typeof settings) => unknown) => select(settings);
export const useUpdateClientSettings = () => () => {};
export const usePrimarySettings = () => DEFAULT_SERVER_SETTINGS.voice;
export const createEnvironmentRpcCommand = () => ({});
export const runAtomCommand = async () => {
  throw new Error("No requests allowed in this fixture");
};
export const squashAtomCommandFailure = (failure: unknown) => failure;
/** A fake microphone: `window.speak()` sends one loud phrase and the silence that ends it. */
export const openCallMicrophone = async (onFrame: (frame: Float32Array) => void) => {
  document.body.dataset.microphone = "opened";
  (window as unknown as { speak: () => void }).speak = () => {
    const loud = new Float32Array(1024).fill(0.3);
    const quiet = new Float32Array(1024);
    for (let index = 0; index < 20; index += 1) onFrame(loud);
    for (let index = 0; index < 60; index += 1) onFrame(quiet);
  };
  return {
    sampleRate: 16000,
    close: () => {
      document.body.dataset.microphone = "closed";
    },
  };
};
export const playCallAudio = async () => {};
export const VoiceSettings = () => null;
export const COORDINATOR_PROMPT_ID = "project-prompt";
