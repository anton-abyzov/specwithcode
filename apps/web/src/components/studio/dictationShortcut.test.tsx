// @vitest-environment jsdom
import { act, useRef } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vite-plus/test";
import type { DesktopBridge, ResolvedKeybindingsConfig } from "@specweave-studio/contracts";
import {
  compileResolvedKeybindingsConfig,
  DEFAULT_RESOLVED_KEYBINDINGS,
} from "@specweave-studio/shared/keybindings";

const state = vi.hoisted(() => ({
  settings: {
    voiceCallsAllowed: true,
    dictationLanguage: "",
    dictationMode: "toggle" as "auto" | "toggle" | "hold",
  },
  frame: null as null | ((frame: Float32Array) => void),
  openMicrophone: vi.fn(),
}));
vi.mock("../../env", () => ({ isElectron: true }));
vi.mock("../../hooks/useSettings", () => ({
  useClientSettings: (select: (settings: typeof state.settings) => unknown) =>
    select(state.settings),
  useUpdateClientSettings: () => vi.fn(),
}));
vi.mock("../../studio/voiceCallAudio", () => ({
  openCallMicrophone: (...args: unknown[]) => state.openMicrophone(...args),
}));
vi.mock("./CoordinatorQuestionCard", () => ({ COORDINATOR_PROMPT_ID: "project-prompt" }));
vi.mock("./VoiceCall", () => ({
  useVoiceSetupPercent: () => null,
  VoiceConsentDialog: () => null,
}));
import {
  DICTATION_HOLD_MS,
  isVoiceCallLive,
  markVoiceCallLive,
  resetDictationTargetsForTest,
  useDictationShortcut,
} from "./dictationShortcut";
import {
  DICTATION_SILENCE_STOP_MS,
  useVoiceDictation,
  type VoiceDictation,
} from "./VoiceDictation";

let root: Root;
let container: HTMLDivElement;
let bridge: DesktopBridge;
const sessions: Record<string, VoiceDictation> = {};
const written: Record<string, string[]> = {};
const ready = { supported: true, microphone: "granted" as const, reason: null };

/** One composer: the coordinator's or a thread's, each with its own box. */
function Composer({
  name,
  keybindings,
  disabled = false,
}: {
  name: string;
  keybindings: ResolvedKeybindingsConfig;
  disabled?: boolean;
}) {
  const ref = useRef<HTMLFormElement | null>(null);
  const dictation = useVoiceDictation(() => undefined, name, {
    insert: (text) => {
      (written[name] ??= []).push(text);
    },
  });
  sessions[name] = dictation;
  useDictationShortcut({ dictation, root: ref, keybindings, disabled });
  return (
    <form ref={ref} data-name={name}>
      <textarea aria-label={name} />
    </form>
  );
}

const mount = (keybindings: ResolvedKeybindingsConfig = DEFAULT_RESOLVED_KEYBINDINGS) =>
  act(async () => {
    root.render(
      <>
        <Composer name="coordinator" keybindings={keybindings} />
        <Composer name="thread" keybindings={keybindings} />
      </>,
    );
  });
const flush = () =>
  act(async () => {
    for (let index = 0; index < 12; index += 1) await Promise.resolve();
  });
const box = (name: string) =>
  container.querySelector<HTMLTextAreaElement>(`[aria-label="${name}"]`)!;

/** Ctrl+Shift+D: `mod` is Ctrl off the Mac, and jsdom reports no Mac platform. */
async function press(type: "keydown" | "keyup" = "keydown", init: KeyboardEventInit = {}) {
  const event = new KeyboardEvent(type, {
    key: "D",
    code: "KeyD",
    ctrlKey: type === "keydown",
    shiftKey: type === "keydown",
    bubbles: true,
    cancelable: true,
    ...init,
  });
  await act(async () => {
    (document.activeElement ?? document.body).dispatchEvent(event);
  });
  await flush();
  return event;
}

async function speak() {
  const loud = new Float32Array(1024).fill(0.3);
  const quiet = new Float32Array(1024);
  await act(async () => {
    for (let index = 0; index < 20; index += 1) state.frame?.(loud);
    for (let index = 0; index < 60; index += 1) state.frame?.(quiet);
  });
  await flush();
}

beforeEach(() => {
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  resetDictationTargetsForTest();
  state.settings = { voiceCallsAllowed: true, dictationLanguage: "", dictationMode: "toggle" };
  state.frame = null;
  for (const key of Object.keys(written)) delete written[key];
  state.openMicrophone.mockReset().mockImplementation(async (onFrame) => {
    state.frame = onFrame;
    return { sampleRate: 16_000, close: vi.fn() };
  });
  bridge = {
    getClientPlatform: () => "linux",
    getSystemLocale: () => "en-US",
    getVoiceStatus: vi.fn(async () => ({ ...ready, setupBytes: 0 })),
    requestVoiceAccess: vi.fn(async () => ready),
    setVoiceCallActive: vi.fn(async () => undefined),
    transcribeVoice: vi.fn(async () => "hello there"),
  } as unknown as DesktopBridge;
  window.desktopBridge = bridge;
  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
  // jsdom lays nothing out; a composer on screen has a box.
  vi.spyOn(HTMLElement.prototype, "getClientRects").mockImplementation(function (
    this: HTMLElement,
  ) {
    return (this.isConnected && !this.hidden ? [{}] : []) as unknown as DOMRectList;
  });
});
afterEach(async () => {
  await act(async () => root.unmount());
  container.remove();
  delete window.desktopBridge;
  vi.restoreAllMocks();
});

describe("dictation shortcut", () => {
  it("defaults to Mod+Shift+D outside the terminal", () => {
    const rule = DEFAULT_RESOLVED_KEYBINDINGS.find(
      (binding) => binding.command === "composer.dictation.toggle",
    );
    expect(rule?.shortcut).toMatchObject({ key: "d", modKey: true, shiftKey: true });
  });

  it("starts and stops dictation in the coordinator composer it is pressed in", async () => {
    await mount();
    box("coordinator").focus();
    const first = await press();
    expect(first.defaultPrevented).toBe(true);
    expect(sessions.coordinator!.phase).toBe("listening");
    expect(sessions.thread!.active).toBe(false);
    await speak();
    expect(written.coordinator).toEqual(["hello there"]);
    await press();
    expect(sessions.coordinator!.phase).toBe("idle");
  });

  it("works the same in a thread composer, and toggles only once per press", async () => {
    await mount();
    box("thread").focus();
    await press();
    expect(sessions.thread!.phase).toBe("listening");
    expect(sessions.coordinator!.active).toBe(false);
    expect(state.openMicrophone).toHaveBeenCalledTimes(1);
    await speak();
    expect(written.thread).toEqual(["hello there"]);
    expect(written.coordinator).toBeUndefined();
  });

  it("goes to the composer used last when focus is elsewhere, and stops the one dictating", async () => {
    await mount();
    box("thread").focus();
    box("thread").blur();
    await press();
    expect(sessions.thread!.phase).toBe("listening");
    box("coordinator").focus();
    // The press stops the session that is running, wherever focus went.
    await press();
    // Nothing was said, so it ends on "No speech was heard" rather than idle.
    expect(sessions.thread!.active).toBe(false);
    expect(sessions.coordinator!.active).toBe(false);
  });

  it("dictates while held in Hold mode and stops on release", async () => {
    state.settings.dictationMode = "hold";
    await mount();
    box("coordinator").focus();
    await press();
    expect(sessions.coordinator!.phase).toBe("listening");
    // Key repeat while held changes nothing.
    await press("keydown", { repeat: true });
    expect(sessions.coordinator!.phase).toBe("listening");
    await press("keyup");
    expect(sessions.coordinator!.phase).not.toBe("listening");
  });

  it("in Auto mode a tap keeps listening until the next press", async () => {
    state.settings.dictationMode = "auto";
    let now = 1_000_000;
    vi.spyOn(Date, "now").mockImplementation(() => now);
    await mount();
    box("coordinator").focus();
    await press();
    now += DICTATION_HOLD_MS - 100;
    await press("keyup");
    expect(sessions.coordinator!.phase).toBe("listening");
    await speak();
    expect(written.coordinator).toEqual(["hello there"]);
    await press();
    expect(sessions.coordinator!.phase).toBe("idle");
  });

  it("in Auto mode a held key is push-to-talk and stops on release", async () => {
    state.settings.dictationMode = "auto";
    let now = 1_000_000;
    vi.spyOn(Date, "now").mockImplementation(() => now);
    await mount();
    box("thread").focus();
    await press();
    await press("keydown", { repeat: true });
    now += DICTATION_HOLD_MS + 200;
    await speak();
    await press("keyup");
    expect(sessions.thread!.active).toBe(false);
    expect(written.thread).toEqual(["hello there"]);
  });

  it("in Auto mode the keyup of a key typed before the chord is not a tap", async () => {
    state.settings.dictationMode = "auto";
    let now = 1_000_000;
    vi.spyOn(Date, "now").mockImplementation(() => now);
    await mount();
    box("thread").focus();
    await press();
    now += 50;
    await press("keyup", { key: "a", code: "KeyA" });
    expect(sessions.thread!.phase).toBe("listening");
    now += DICTATION_HOLD_MS + 200;
    await speak();
    await press("keyup");
    expect(sessions.thread!.active).toBe(false);
    expect(written.thread).toEqual(["hello there"]);
  });

  it("letting go after the microphone already stopped leaves its message", async () => {
    state.settings.dictationMode = "hold";
    let now = 1_000_000;
    vi.spyOn(Date, "now").mockImplementation(() => now);
    await mount();
    box("coordinator").focus();
    await press();
    const quiet = new Float32Array(1024);
    now += DICTATION_SILENCE_STOP_MS + 1_000;
    await act(async () => state.frame?.(quiet));
    await flush();
    expect(sessions.coordinator!.phase).toBe("error");
    await press("keyup");
    expect(sessions.coordinator!.phase).toBe("error");
  });

  it("stops a forgotten microphone after a minute of silence", async () => {
    let now = 1_000_000;
    vi.spyOn(Date, "now").mockImplementation(() => now);
    await mount();
    box("coordinator").focus();
    await press();
    await speak();
    expect(written.coordinator).toEqual(["hello there"]);
    const quiet = new Float32Array(1024);
    now += DICTATION_SILENCE_STOP_MS - 1_000;
    await act(async () => state.frame?.(quiet));
    await flush();
    expect(sessions.coordinator!.phase).toBe("listening");
    now += 2_000;
    await act(async () => state.frame?.(quiet));
    await flush();
    expect(sessions.coordinator!.phase).toBe("idle");
  });

  it("follows a rebinding from Settings > Keybindings", async () => {
    const rebound = compileResolvedKeybindingsConfig([
      { key: "alt+m", command: "composer.dictation.toggle" },
    ]);
    await mount(rebound);
    box("thread").focus();
    const old = await press();
    expect(old.defaultPrevented).toBe(false);
    expect(sessions.thread!.active).toBe(false);
    await press("keydown", {
      key: "m",
      code: "KeyM",
      ctrlKey: false,
      shiftKey: false,
      altKey: true,
    });
    expect(sessions.thread!.phase).toBe("listening");
  });

  it("uses the language chosen in Settings in every composer", async () => {
    state.settings.dictationLanguage = "ru-RU";
    await mount();
    box("thread").focus();
    await press();
    await speak();
    expect(bridge.transcribeVoice).toHaveBeenCalledWith(
      expect.objectContaining({ locale: "ru-RU", pinLanguage: true }),
    );
  });

  it("follows the system language when none is chosen", async () => {
    await mount();
    box("coordinator").focus();
    await press();
    await speak();
    const input = vi.mocked(bridge.transcribeVoice!).mock.calls[0]![0];
    expect(input.locale).toBe("en-US");
    expect(input.pinLanguage).toBeUndefined();
  });

  it("does not open the microphone during a voice call", async () => {
    await mount();
    const done = markVoiceCallLive();
    expect(isVoiceCallLive()).toBe(true);
    box("thread").focus();
    await press();
    expect(state.openMicrophone).not.toHaveBeenCalled();
    done();
  });

  it("never hands back the microphone from a composer that did not take it", async () => {
    await mount();
    box("coordinator").focus();
    await press();
    expect(sessions.coordinator!.phase).toBe("listening");
    // The thread composer closes (its thread changes); the coordinator keeps listening.
    await act(async () => {
      root.render(<Composer name="coordinator" keybindings={DEFAULT_RESOLVED_KEYBINDINGS} />);
    });
    await flush();
    expect(bridge.setVoiceCallActive).not.toHaveBeenCalledWith({ active: false });
    expect(sessions.coordinator!.phase).toBe("listening");
  });

  it("a second press while writing out waits instead of cutting the phrase", async () => {
    let finish = (_text: string) => {};
    vi.mocked(bridge.transcribeVoice!).mockImplementation(
      () =>
        new Promise((resolve) => {
          finish = resolve;
        }),
    );
    await mount();
    box("thread").focus();
    await press();
    await speak();
    await press();
    expect(sessions.thread!.phase).toBe("finishing");
    await press();
    expect(sessions.thread!.phase).toBe("finishing");
    await act(async () => finish("late words"));
    await flush();
    expect(written.thread).toEqual(["late words"]);
    expect(sessions.thread!.phase).toBe("idle");
    expect(sessions.thread!.writing).toBe(false);
  });

  it("does nothing when the focused thread composer waits on an approval or a choice", async () => {
    await act(async () => {
      root.render(
        <>
          <Composer name="coordinator" keybindings={DEFAULT_RESOLVED_KEYBINDINGS} />
          <Composer name="thread" keybindings={DEFAULT_RESOLVED_KEYBINDINGS} disabled />
        </>,
      );
    });
    box("coordinator").focus();
    box("thread").focus();
    const event = await press();
    expect(event.defaultPrevented).toBe(true);
    expect(sessions.thread!.active).toBe(false);
    expect(sessions.coordinator!.active).toBe(false);
    expect(state.openMicrophone).not.toHaveBeenCalled();
  });

  it("leaves the key to the browser where dictation cannot run", async () => {
    delete window.desktopBridge;
    await mount();
    box("thread").focus();
    const event = await press();
    expect(event.defaultPrevented).toBe(false);
  });
});
