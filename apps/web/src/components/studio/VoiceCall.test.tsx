// @vitest-environment jsdom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vite-plus/test";
import { DEFAULT_SERVER_SETTINGS, type DesktopBridge } from "@specweave-studio/contracts";

const state = vi.hoisted(() => ({
  allowed: false,
  voice: {} as typeof DEFAULT_SERVER_SETTINGS.voice,
  openMicrophone: vi.fn(),
  update: vi.fn(),
}));
vi.mock("@effect/atom-react", () => ({ useAtomValue: () => ({}) }));
vi.mock("../../state/server", () => ({ primaryServerConfigAtom: {} }));
vi.mock("../../env", () => ({ isElectron: true }));
vi.mock("../../hooks/useSettings", () => ({
  useClientSettings: () => state.allowed,
  usePrimarySettings: () => state.voice,
  useUpdateClientSettings: () => state.update,
}));
vi.mock("../../state/environments", () => ({ usePrimaryEnvironmentId: () => "fixture" }));
vi.mock("../../connection/runtime", () => ({ connectionAtomRuntime: {} }));
vi.mock("../../rpc/atomRegistry", () => ({ appAtomRegistry: {} }));
vi.mock("@specweave-studio/client-runtime/state/runtime", () => ({
  createEnvironmentRpcCommand: () => ({}),
  runAtomCommand: vi.fn(),
  squashAtomCommandFailure: vi.fn(),
}));
vi.mock("../../studio/voiceCallAudio", () => ({
  openCallMicrophone: (...args: unknown[]) => state.openMicrophone(...args),
  playCallAudio: vi.fn(),
}));
vi.mock("./VoiceSettings", () => ({ VoiceSettings: () => <span>Voice settings</span> }));
import { useVoiceCall, VoiceCallButton, VoiceCallBar, type VoiceCall } from "./VoiceCall";

let root: Root;
let container: HTMLDivElement;
let call: VoiceCall;
let bridge: NonNullable<Window["desktopBridge"]>;
const ready = { supported: true, microphone: "granted" as const, reason: null };
function Harness() {
  call = useVoiceCall(async () => null);
  return (
    <>
      <VoiceCallButton call={call} disabled={false} />
      <VoiceCallBar call={call} />
    </>
  );
}
async function mount() {
  await act(async () => {
    root.render(<Harness />);
  });
}
beforeEach(() => {
  state.allowed = false;
  state.voice = DEFAULT_SERVER_SETTINGS.voice;
  state.update.mockReset();
  state.openMicrophone.mockReset().mockResolvedValue({ sampleRate: 16000, close: vi.fn() });
  bridge = {
    getVoiceStatus: vi.fn(async () => ready),
    requestVoiceAccess: vi.fn(async () => ready),
    setVoiceCallActive: vi.fn(async () => undefined),
    transcribeVoice: vi.fn(),
    synthesizeVoice: vi.fn(),
    openMicrophoneSettings: vi.fn(),
  } as unknown as DesktopBridge;
  window.desktopBridge = bridge;
  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
});
afterEach(async () => {
  await act(async () => root.unmount());
  container.remove();
  delete window.desktopBridge;
});

it("a fresh user can use free macOS speech with no ElevenLabs key, after consent", async () => {
  await mount();
  expect(call.unavailableReason).toBeNull();
  await act(async () => call.start());
  expect(call.consentOpen).toBe(true);
  expect(bridge.requestVoiceAccess).not.toHaveBeenCalled();
  await act(async () => call.allow());
  expect(state.update).toHaveBeenCalledWith({ voiceCallsAllowed: true });
  expect(state.openMicrophone).toHaveBeenCalledOnce();
  expect(call.state.phase).toBe("listening");
});

it("disables the call on unsupported desktop platforms with a reason", async () => {
  vi.mocked(bridge.getVoiceStatus!).mockResolvedValue({
    ...ready,
    supported: false,
    reason: "Voice calls need the SpecWithCode app on macOS.",
  });
  await mount();
  expect(
    container.querySelector<HTMLButtonElement>('[aria-label="Start voice call"]')!.disabled,
  ).toBe(true);
  expect(call.unavailableReason).toContain("macOS");
  expect(state.openMicrophone).not.toHaveBeenCalled();
});

it("blocks incomplete ElevenLabs configuration before recording or provider work", async () => {
  state.voice = { ...DEFAULT_SERVER_SETTINGS.voice, provider: "elevenlabs", elevenLabsApiKey: "" };
  state.allowed = true;
  await mount();
  expect(call.unavailableReason).toContain("free macOS voice");
  await act(async () => call.start());
  expect(bridge.requestVoiceAccess).not.toHaveBeenCalled();
  expect(state.openMicrophone).not.toHaveBeenCalled();
});

it("waits for native preparation before opening the microphone", async () => {
  state.allowed = true;
  let finish!: (value: typeof ready) => void;
  vi.mocked(bridge.requestVoiceAccess!).mockImplementation(
    () =>
      new Promise((resolve) => {
        finish = resolve;
      }),
  );
  await mount();
  await act(async () => call.start());
  expect(call.state.phase).toBe("connecting");
  expect(state.openMicrophone).not.toHaveBeenCalled();
  await act(async () => finish(ready));
  expect(state.openMicrophone).toHaveBeenCalledOnce();
});

it("hang-up while native preparation is pending never opens the microphone", async () => {
  state.allowed = true;
  let finish!: (value: typeof ready) => void;
  vi.mocked(bridge.requestVoiceAccess!).mockImplementation(
    () =>
      new Promise((resolve) => {
        finish = resolve;
      }),
  );
  await mount();
  await act(async () => call.start());
  await act(async () => call.end());
  await act(async () => finish(ready));
  expect(state.openMicrophone).not.toHaveBeenCalled();
  expect(call.state.phase).toBe("ended");
});

it("shows native setup failures without recording or switching to cloud speech", async () => {
  state.allowed = true;
  vi.mocked(bridge.requestVoiceAccess!).mockResolvedValue({
    ...ready,
    supported: false,
    reason: "On-device speech is not available in this build.",
  });
  await mount();
  await act(async () => call.start());
  expect(container.textContent).toContain("On-device speech is not available in this build.");
  expect(state.openMicrophone).not.toHaveBeenCalled();
  expect(bridge.synthesizeVoice).not.toHaveBeenCalled();
});
