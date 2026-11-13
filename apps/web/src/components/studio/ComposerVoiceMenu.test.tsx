// @vitest-environment jsdom
import { act } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, expect, it, vi } from "vite-plus/test";
vi.mock("./VoiceCall", () => ({
  VoiceConsentDialog: ({ open }: { open: boolean }) =>
    open ? <div role="dialog">Consent</div> : null,
}));
vi.mock("./VoiceSettings", () => ({
  VoiceSettings: ({ controlledOpen }: { controlledOpen: boolean }) =>
    controlledOpen ? <div role="dialog">Voice settings</div> : null,
}));
import { ComposerVoiceMenu } from "./ComposerVoiceMenu";
import type { VoiceDictation } from "./VoiceDictation";
import type { VoiceCall } from "./VoiceCall";
const roots: ReturnType<typeof createRoot>[] = [];
afterEach(async () => {
  for (const root of roots.splice(0)) await act(async () => root.unmount());
  document.body.innerHTML = "";
});
async function mount(
  overrides: Partial<VoiceDictation> = {},
  callOverrides: Partial<VoiceCall> = {},
  disabled = false,
) {
  (globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;
  const dictation = {
    available: true,
    active: false,
    phase: "idle",
    start: vi.fn(),
    stop: vi.fn(),
    consentOpen: false,
    ...overrides,
  } as unknown as VoiceDictation;
  const call = {
    available: true,
    active: false,
    unavailableReason: null,
    start: vi.fn(),
    end: vi.fn(),
    consentOpen: false,
    ...callOverrides,
  } as unknown as VoiceCall;
  const container = document.createElement("div");
  document.body.append(container);
  const root = createRoot(container);
  roots.push(root);
  await act(async () =>
    root.render(<ComposerVoiceMenu dictation={dictation} call={call} disabled={disabled} />),
  );
  expect(container.querySelectorAll("button")).toHaveLength(1);
  // An icon on the composer's line: no words beside it; its name says Voice.
  expect(container.querySelector("button")!.textContent).toBe("");
  // A running call or dictation is in the name (a menu button is not a toggle).
  expect(container.querySelector("button")!.getAttribute("aria-label")).toBe(
    call.active ? "Voice, in a call" : dictation.active ? "Voice, dictating" : "Voice",
  );
  expect(container.querySelector("button")!.hasAttribute("aria-pressed")).toBe(false);
  await act(async () => container.querySelector<HTMLButtonElement>("button")!.click());
  return { dictation, call };
}
function item(label: string) {
  return [...document.querySelectorAll<HTMLElement>('[role="menuitem"]')].find((el) =>
    el.textContent?.includes(label),
  )!;
}
it("names all voice actions and starts dictation", async () => {
  const { dictation, call } = await mount();
  expect(item("Call the coordinator")).toBeTruthy();
  expect(item("Voice settings")).toBeTruthy();
  await act(async () => item("Dictate into the message").click());
  expect(dictation.start).toHaveBeenCalledOnce();
  expect(call.start).not.toHaveBeenCalled();
});
it("keeps settings mounted after closing the menu", async () => {
  await mount();
  await act(async () => item("Voice settings").click());
  expect(document.querySelector('[role="dialog"]')?.textContent).toBe("Voice settings");
});
it("allows stopping a recording while sending is blocked and prevents a simultaneous call", async () => {
  const { dictation } = await mount({ active: true }, {}, true);
  expect(item("Call the coordinator").getAttribute("aria-disabled")).toBe("true");
  await act(async () => item("Stop dictating").click());
  expect(dictation.stop).toHaveBeenCalledOnce();
});
it("allows ending an active call while blocked", async () => {
  const { call } = await mount({}, { active: true }, true);
  expect(item("Dictate into the message").getAttribute("aria-disabled")).toBe("true");
  await act(async () => item("End voice call").click());
  expect(call.end).toHaveBeenCalledOnce();
});
