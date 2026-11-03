// @vitest-environment jsdom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vite-plus/test";
import type { DesktopBridge } from "@specweave-studio/contracts";

const state = vi.hoisted(() => ({
  allowed: true,
  update: vi.fn(),
  frame: null as null | ((frame: Float32Array) => void),
  close: vi.fn(),
  openMicrophone: vi.fn(),
}));
vi.mock("../../env", () => ({ isElectron: true }));
vi.mock("../../hooks/useSettings", () => ({
  useClientSettings: () => state.allowed,
  useUpdateClientSettings: () => state.update,
}));
vi.mock("../../studio/voiceCallAudio", () => ({
  openCallMicrophone: (...args: unknown[]) => state.openMicrophone(...args),
}));
vi.mock("./CoordinatorQuestionCard", () => ({ COORDINATOR_PROMPT_ID: "project-prompt" }));
vi.mock("./VoiceCall", () => ({
  useVoiceSetupPercent: () => null,
  VoiceConsentDialog: ({ open, onAllow }: { open: boolean; onAllow: () => void }) =>
    open ? (
      <button type="button" onClick={onAllow}>
        allow
      </button>
    ) : null,
}));
import {
  insertDictatedText,
  useVoiceDictation,
  VoiceDictationBar,
  VoiceDictationButton,
  type VoiceDictation,
} from "./VoiceDictation";

let root: Root;
let container: HTMLDivElement;
let dictation: VoiceDictation;
let prompt = "";
let bridge: DesktopBridge;
const ready = { supported: true, microphone: "granted" as const, reason: null };

function Harness({ scope }: { scope: string }) {
  dictation = useVoiceDictation((update) => {
    prompt = update(prompt);
  }, scope);
  return (
    <>
      <VoiceDictationButton dictation={dictation} disabled={false} />
      <VoiceDictationBar dictation={dictation} />
    </>
  );
}
const mount = (scope = "a") =>
  act(async () => {
    root.render(<Harness scope={scope} />);
  });
const flush = () =>
  act(async () => {
    for (let index = 0; index < 8; index += 1) await Promise.resolve();
  });
/** 100 ms of loud frames, then enough silence to end the phrase. */
async function speakOnePhrase() {
  const loud = new Float32Array(1024).fill(0.3);
  const quiet = new Float32Array(1024);
  await act(async () => {
    for (let index = 0; index < 20; index += 1) state.frame?.(loud);
    for (let index = 0; index < 60; index += 1) state.frame?.(quiet);
  });
  await flush();
}

beforeEach(() => {
  prompt = "";
  state.allowed = true;
  state.update.mockReset();
  state.close.mockReset();
  state.frame = null;
  state.openMicrophone.mockReset().mockImplementation(async (onFrame) => {
    state.frame = onFrame;
    return { sampleRate: 16_000, close: state.close };
  });
  bridge = {
    getClientPlatform: () => "linux",
    getVoiceStatus: vi.fn(async () => ({ ...ready, setupBytes: 0 })),
    requestVoiceAccess: vi.fn(async () => ready),
    setVoiceCallActive: vi.fn(async () => undefined),
    transcribeVoice: vi.fn(async () => "merge the SpecWeave PR"),
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

describe("insertDictatedText", () => {
  it("adds one space between words and none in an empty box", () => {
    expect(insertDictatedText("", "hello").value).toBe("hello");
    expect(insertDictatedText("well", "hello").value).toBe("well hello");
    expect(insertDictatedText("well ", "hello").value).toBe("well hello");
  });

  it("replaces a selection, keeps punctuation tight and reports the caret", () => {
    expect(insertDictatedText("say XX now", "hello", 4, 6)).toEqual({
      value: "say hello now",
      caret: 9,
    });
    expect(insertDictatedText("say.", "hello", 3).value).toBe("say hello.");
  });
});

describe("dictation", () => {
  it("does not touch the microphone until consent is given", async () => {
    state.allowed = false;
    await mount();
    await act(async () => dictation.start());
    expect(bridge.setVoiceCallActive).not.toHaveBeenCalled();
    expect(state.openMicrophone).not.toHaveBeenCalled();
    await act(async () => dictation.allow());
    await flush();
    expect(state.update).toHaveBeenCalledWith({ voiceCallsAllowed: true });
    expect(state.openMicrophone).toHaveBeenCalledTimes(1);
  });

  it("declares itself active before opening the microphone", async () => {
    const order: string[] = [];
    vi.mocked(bridge.setVoiceCallActive!).mockImplementation(async ({ active }) => {
      order.push(`active ${active}`);
    });
    state.openMicrophone.mockImplementation(async (onFrame) => {
      order.push("open");
      state.frame = onFrame;
      return { sampleRate: 16_000, close: state.close };
    });
    await mount();
    await act(async () => dictation.start());
    await flush();
    expect(order).toEqual(["active true", "open"]);
  });

  it("writes each finished phrase into the box without sending, and keeps listening", async () => {
    await mount();
    await act(async () => dictation.start());
    await flush();
    expect(dictation.phase).toBe("listening");
    await speakOnePhrase();
    expect(prompt).toBe("merge the SpecWeave PR");
    await speakOnePhrase();
    expect(prompt).toBe("merge the SpecWeave PR merge the SpecWeave PR");
    expect(dictation.phase).toBe("listening");
    expect(state.close).not.toHaveBeenCalled();
  });

  it("stop closes the microphone, writes the phrase in progress and releases the window", async () => {
    await mount();
    await act(async () => dictation.start());
    await flush();
    const loud = new Float32Array(1024).fill(0.3);
    await act(async () => {
      for (let index = 0; index < 20; index += 1) state.frame?.(loud);
    });
    await act(async () => dictation.stop());
    await flush();
    expect(state.close).toHaveBeenCalledTimes(1);
    expect(prompt).toBe("merge the SpecWeave PR");
    expect(dictation.phase).toBe("idle");
    expect(bridge.setVoiceCallActive).toHaveBeenLastCalledWith({ active: false });
  });

  it("a failed phrase shows a notice and the next phrase still lands", async () => {
    vi.mocked(bridge.transcribeVoice!)
      .mockRejectedValueOnce(new Error("Speech recognition failed. Try again."))
      .mockResolvedValueOnce("second phrase");
    await mount();
    await act(async () => dictation.start());
    await flush();
    await speakOnePhrase();
    expect(container.textContent).toContain("Speech recognition failed");
    expect(dictation.phase).toBe("listening");
    await speakOnePhrase();
    expect(prompt).toBe("second phrase");
    expect(container.textContent).not.toContain("Speech recognition failed");
  });

  it("closes the microphone after three phrases in a row fail", async () => {
    vi.mocked(bridge.transcribeVoice!).mockRejectedValue(
      new Error("Speech recognition failed. Try again."),
    );
    await mount();
    await act(async () => dictation.start());
    await flush();
    await speakOnePhrase();
    await speakOnePhrase();
    expect(dictation.phase).toBe("listening");
    await speakOnePhrase();
    expect(dictation.phase).toBe("error");
    expect(dictation.error).toContain("Speech recognition failed");
  });

  it("asks first when it cannot tell whether a download is needed", async () => {
    vi.mocked(bridge.getVoiceStatus!).mockRejectedValue(new Error("no answer"));
    await mount();
    await act(async () => dictation.start());
    await flush();
    expect(dictation.consentOpen).toBe(true);
    expect(bridge.requestVoiceAccess).not.toHaveBeenCalled();
  });

  it("asks before a download even when voice was already allowed", async () => {
    vi.mocked(bridge.getVoiceStatus!).mockResolvedValue({ ...ready, setupBytes: 1000 });
    await mount();
    await act(async () => dictation.start());
    await flush();
    expect(dictation.consentOpen).toBe(true);
    expect(bridge.requestVoiceAccess).not.toHaveBeenCalled();
    expect(state.openMicrophone).not.toHaveBeenCalled();
  });

  it("says so when nothing was heard", async () => {
    await mount();
    await act(async () => dictation.start());
    await flush();
    await act(async () => dictation.stop());
    await flush();
    expect(dictation.phase).toBe("error");
    expect(container.textContent).toContain("No speech was heard");
  });

  it("stopping while it starts never opens the microphone", async () => {
    let finishAccess = (_status: typeof ready) => {};
    vi.mocked(bridge.requestVoiceAccess!).mockImplementation(
      () =>
        new Promise((resolve) => {
          finishAccess = resolve;
        }),
    );
    await mount();
    await act(async () => dictation.start());
    await act(async () => dictation.stop());
    await act(async () => finishAccess(ready));
    await flush();
    expect(state.openMicrophone).not.toHaveBeenCalled();
    expect(dictation.phase).toBe("idle");
  });

  it("leaving the project closes the microphone and drops queued text", async () => {
    let finishText = (_text: string) => {};
    vi.mocked(bridge.transcribeVoice!).mockImplementation(
      () =>
        new Promise((resolve) => {
          finishText = resolve;
        }),
    );
    await mount("a");
    await act(async () => dictation.start());
    await flush();
    await speakOnePhrase();
    await mount("b");
    expect(state.close).toHaveBeenCalledTimes(1);
    expect(bridge.setVoiceCallActive).toHaveBeenLastCalledWith({ active: false });
    await act(async () => finishText("too late"));
    await flush();
    expect(prompt).toBe("");
  });

  it("surfaces a microphone failure and closes nothing it never opened", async () => {
    state.openMicrophone.mockRejectedValue(
      new Error("No microphone was found. Plug in a headset or USB microphone."),
    );
    await mount();
    await act(async () => dictation.start());
    await flush();
    expect(dictation.phase).toBe("error");
    expect(container.textContent).toContain("Plug in a headset");
    expect(bridge.setVoiceCallActive).toHaveBeenLastCalledWith({ active: false });
  });

  it("is hidden on Windows", async () => {
    window.desktopBridge = { ...bridge, getClientPlatform: () => "win32" } as DesktopBridge;
    await mount();
    expect(container.querySelector("button")).toBeNull();
  });
});
