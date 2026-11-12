// @vitest-environment jsdom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vite-plus/test";
import { DEFAULT_SERVER_SETTINGS, type DesktopBridge } from "@specweave-studio/contracts";

const state = vi.hoisted(() => ({
  allowed: false,
  language: "",
  voice: {} as typeof DEFAULT_SERVER_SETTINGS.voice,
  openMicrophone: vi.fn(),
  update: vi.fn(),
}));
vi.mock("@effect/atom-react", () => ({ useAtomValue: () => ({}) }));
vi.mock("../../state/server", () => ({ primaryServerConfigAtom: {} }));
vi.mock("../../env", () => ({ isElectron: true }));
vi.mock("../../hooks/useSettings", () => ({
  useClientSettings: (select: (settings: object) => unknown) =>
    select({ voiceCallsAllowed: state.allowed, dictationLanguage: state.language }),
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
  state.language = "";
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

/** One spoken phrase through the open microphone: a second of voice, then the silence that ends it. */
async function sayPhrase() {
  const onFrame = state.openMicrophone.mock.calls[0]![0] as (frame: Float32Array) => void;
  await act(async () => {
    for (let index = 0; index < 20; index += 1) onFrame(new Float32Array(1024).fill(0.5));
    for (let index = 0; index < 20; index += 1) onFrame(new Float32Array(1024));
  });
}

it("listens in the language chosen in Settings", async () => {
  state.allowed = true;
  state.language = "ru-RU";
  vi.mocked(bridge.transcribeVoice!).mockResolvedValue("");
  await mount();
  await act(async () => call.start());
  await sayPhrase();
  expect(bridge.transcribeVoice).toHaveBeenCalledWith(
    expect.objectContaining({ locale: "ru-RU", pinLanguage: true }),
  );
});

it("leaves the language to the computer when none is chosen", async () => {
  state.allowed = true;
  vi.mocked(bridge.transcribeVoice!).mockResolvedValue("");
  await mount();
  await act(async () => call.start());
  await sayPhrase();
  expect(bridge.transcribeVoice).toHaveBeenCalledOnce();
  expect(vi.mocked(bridge.transcribeVoice!).mock.calls[0]![0]).not.toHaveProperty("pinLanguage");
});

it.each(["win32"])("shows no call controls in the %s app", async (platform) => {
  bridge.getClientPlatform = () => platform;
  await mount();
  expect(call.available).toBe(false);
  expect(container.querySelector('[aria-label="Start voice call"]')).toBeNull();
  expect(container.textContent).not.toContain("Voice settings");
  expect(bridge.getVoiceStatus).not.toHaveBeenCalled();
});

it("shows the call in the macOS app", async () => {
  bridge.getClientPlatform = () => "darwin";
  await mount();
  expect(call.available).toBe(true);
  expect(container.querySelector('[aria-label="Start voice call"]')).not.toBeNull();
});

it("disables the call with a reason when an older desktop build reports no platform", async () => {
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

it("shows voice on Linux and names the machine correctly", async () => {
  window.desktopBridge = { ...bridge, getClientPlatform: () => "linux" } as DesktopBridge;
  state.allowed = false;
  await mount();
  expect(container.querySelector('[aria-label="Start voice call"]')).not.toBeNull();
  const { voiceHostName, canHostVoiceCall } = await import("../../studio/voiceCallSupport");
  expect(voiceHostName()).toBe("this computer");
  expect(canHostVoiceCall()).toBe(true);
  expect(canHostVoiceCall({ ...bridge, getClientPlatform: () => "win32" } as DesktopBridge)).toBe(
    false,
  );
});

it("asks before a download even when calls were already allowed", async () => {
  state.allowed = true;
  bridge.getVoiceStatus = vi.fn(async () => ({ ...ready, setupBytes: 1000 }));
  await mount();
  await act(async () => call.start());
  expect(call.consentOpen).toBe(true);
  expect(bridge.requestVoiceAccess).not.toHaveBeenCalled();
});
