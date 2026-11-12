// @vitest-environment jsdom
import { EnvironmentId, ProjectId, type RuntimeMode } from "@specweave-studio/contracts";
import { act, useEffect } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vite-plus/test";

import { en } from "../../i18n/messages/en";

const mocks = vi.hoisted(() => ({
  accept: vi.fn(),
  decline: vi.fn(),
  undo: vi.fn(),
  toast: vi.fn(),
  closeToast: vi.fn(),
  projectOverrides: {} as Record<string, unknown>,
}));
vi.mock("../../onboarding/accessRecommendation", () => ({
  useFullAccessRecommendation: () => ({
    answer: null,
    machineRole: null,
    hydrated: true,
    accept: mocks.accept,
    decline: mocks.decline,
    undo: mocks.undo,
  }),
}));
vi.mock("../../state/environments", () => ({
  useEnvironment: () => ({
    serverConfig: {
      settings: {
        defaultRuntimeMode: "approval-required",
        projectSettingsOverrides: mocks.projectOverrides,
      },
    },
  }),
  usePrimaryEnvironmentId: () => "main-machine",
}));
vi.mock("../ui/toast", () => ({
  toastManager: { add: mocks.toast, close: mocks.closeToast, update: vi.fn() },
}));

import {
  AccessRecommendationAnchor,
  composerAccessRecommendationFor,
  resetAccessCalloutSession,
  useComposerAccessRecommendation,
  type ComposerAccessRecommendation,
} from "./AccessRecommendation";

let root: Root;
let container: HTMLDivElement;

beforeEach(() => {
  vi.clearAllMocks();
  resetAccessCalloutSession();
  mocks.projectOverrides = {};
  vi.stubGlobal(
    "ResizeObserver",
    class {
      observe() {}
      unobserve() {}
      disconnect() {}
    },
  );
  Object.defineProperty(Element.prototype, "getAnimations", {
    configurable: true,
    value: () => [],
  });
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
});
afterEach(async () => {
  await act(async () => root.unmount());
  container.remove();
});

const button = (label: string) =>
  [...document.querySelectorAll("button")].find(
    (element) =>
      element.textContent?.trim() === label || element.getAttribute("aria-label") === label,
  );
async function click(label: string) {
  const target = button(label);
  expect(target, `button ${label}`).toBeDefined();
  await act(async () => target!.click());
}

describe("AccessRecommendationAnchor", () => {
  async function mount(
    accept: (mode: RuntimeMode) => Promise<string | null> = vi.fn(async () => null),
    hidden = false,
  ) {
    const decline = vi.fn();
    await act(async () =>
      root.render(
        <AccessRecommendationAnchor
          mode="approval-required"
          hidden={hidden}
          recommendation={{ accept, decline }}
        >
          <button type="button">Supervised</button>
        </AccessRecommendationAnchor>,
      ),
    );
    return { accept, decline };
  }

  it("rings the chip and shows the callout with the shared explanation, focused on Switch", async () => {
    await mount();
    expect(document.querySelector("[data-access-recommended]")).not.toBeNull();
    expect(document.querySelector('[data-slot="access-recommended-dot"]')).not.toBeNull();
    const text = document.body.textContent ?? "";
    expect(text).toContain(en["wizard.access.calloutTitle"]);
    expect(text).toContain(en["wizard.access.calloutIntroSupervised"]);
    expect(text).toContain(en["wizard.access.allowCommands"]);
    expect(text).toContain(en["wizard.access.stillStops"]);
    expect(button(en["wizard.access.switch"])).toBeDefined();
    expect(button(en["wizard.access.keepSupervised"])).toBeDefined();
    await act(async () => new Promise((resolve) => setTimeout(resolve, 0)));
    expect(document.activeElement?.textContent).toBe(en["wizard.access.switch"]);
  });

  it("Switch to Full access passes the chat's mode to accept", async () => {
    const { accept, decline } = await mount();
    await click(en["wizard.access.switch"]);
    expect(accept).toHaveBeenCalledWith("approval-required");
    expect(decline).not.toHaveBeenCalled();
  });

  it("keeps the callout open with the error when saving fails", async () => {
    await mount(vi.fn(async () => en["wizard.access.saveFailed"]));
    await click(en["wizard.access.switch"]);
    expect(document.querySelector('[role="alert"]')?.textContent).toBe(
      en["wizard.access.saveFailed"],
    );
    expect(button(en["wizard.access.switch"])?.disabled).toBe(false);
  });

  it.each([
    ["Keep Supervised", en["wizard.access.keepSupervised"]],
    ["the close button", en["wizard.access.close"]],
  ])("%s declines", async (_name, label) => {
    const { accept, decline } = await mount();
    await click(label);
    expect(decline).toHaveBeenCalledOnce();
    expect(accept).not.toHaveBeenCalled();
  });

  it("Escape declines", async () => {
    const { decline } = await mount();
    await act(async () => {
      document.activeElement?.dispatchEvent(
        new KeyboardEvent("keydown", { key: "Escape", bubbles: true }),
      );
    });
    expect(decline).toHaveBeenCalledOnce();
  });

  it("a press outside puts the callout away for the rest of the app session, not only this chat", async () => {
    const { decline } = await mount();
    expect(document.body.textContent).toContain(en["wizard.access.calloutTitle"]);
    // A press on the page around the chip, as in the rest of the composer.
    await act(async () => {
      const page = { bubbles: true, button: 0, pointerType: "mouse" };
      container.dispatchEvent(new PointerEvent("pointerdown", page));
      container.dispatchEvent(new MouseEvent("mousedown", page));
      container.dispatchEvent(new PointerEvent("pointerup", page));
      container.dispatchEvent(new MouseEvent("mouseup", page));
      container.click();
    });
    // The popup unmounts once its closing animation frame has run.
    await act(async () => new Promise((resolve) => setTimeout(resolve, 50)));
    expect(document.body.textContent).not.toContain(en["wizard.access.calloutTitle"]);
    expect(decline).not.toHaveBeenCalled();
    // Another chat's composer mounts: the chip keeps its accent, the callout stays away.
    await act(async () => root.unmount());
    root = createRoot(container);
    await mount();
    expect(document.querySelector("[data-access-recommended]")).not.toBeNull();
    expect(document.body.textContent).not.toContain(en["wizard.access.calloutTitle"]);
  });

  it("leaves focus in the message box when the person is typing", async () => {
    const box = document.createElement("textarea");
    document.body.append(box);
    box.focus();
    await mount();
    await act(async () => new Promise((resolve) => setTimeout(resolve, 0)));
    expect(document.body.textContent).toContain(en["wizard.access.calloutTitle"]);
    expect(document.activeElement).toBe(box);
    box.remove();
  });

  it("waits while the chip is folded away", async () => {
    await mount(undefined, true);
    expect(document.body.textContent).not.toContain(en["wizard.access.calloutTitle"]);
  });
});

describe("useComposerAccessRecommendation", () => {
  const probe: { value: ComposerAccessRecommendation | null } = { value: null };
  function Probe(props: {
    projectId: string | null;
    chatKey?: string;
    onChatModeChange: (mode: RuntimeMode) => void;
  }) {
    const recommendation = useComposerAccessRecommendation({
      environmentId: EnvironmentId.make("other-machine"),
      projectId: props.projectId === null ? null : ProjectId.make(props.projectId),
      chatKey: props.chatKey ?? "chat-a",
      newChatMode: "approval-required",
      chatStarted: false,
      onChatModeChange: props.onChatModeChange,
    });
    useEffect(() => {
      probe.value = recommendation;
    });
    return null;
  }

  it("saves the main machine's default, switches the chat, and Undo puts both back", async () => {
    const before = vi.fn();
    await act(async () => root.render(<Probe projectId={null} onChatModeChange={before} />));
    expect(probe.value!.input).toMatchObject({ settingsKnown: true, projectSetsMode: false });
    const previous = new Map([["main-machine", "approval-required"]]);
    mocks.accept.mockResolvedValue(previous);
    mocks.undo.mockResolvedValue(true);
    await act(async () => expect(await probe.value!.accept("approval-required")).toBeNull());
    expect(mocks.accept).toHaveBeenCalledWith(["main-machine"]);
    expect(before).toHaveBeenCalledWith("full-access");
    const notice = mocks.toast.mock.calls[0]![0];
    expect(notice.title).toBe(en["wizard.access.onTitle"]);
    // The chat has re-rendered on Full access by the time Undo is pressed.
    const after = vi.fn();
    await act(async () => root.render(<Probe projectId={null} onChatModeChange={after} />));
    await act(async () => notice.actionProps.onClick());
    expect(mocks.undo).toHaveBeenCalledWith(previous);
    expect(after).toHaveBeenCalledWith("approval-required");
  });

  it("Undo after moving to another chat restores the default and leaves that chat alone", async () => {
    await act(async () => root.render(<Probe projectId={null} onChatModeChange={vi.fn()} />));
    const previous = new Map([["main-machine", "approval-required"]]);
    mocks.accept.mockResolvedValue(previous);
    mocks.undo.mockResolvedValue(true);
    await act(async () => expect(await probe.value!.accept("approval-required")).toBeNull());
    const notice = mocks.toast.mock.calls[0]![0];
    const otherChat = vi.fn();
    await act(async () =>
      root.render(<Probe projectId={null} chatKey="chat-b" onChatModeChange={otherChat} />),
    );
    await act(async () => notice.actionProps.onClick());
    expect(mocks.undo).toHaveBeenCalledWith(previous);
    expect(otherChat).not.toHaveBeenCalled();
  });

  it("reports a failed save and leaves the chat as it was", async () => {
    const change = vi.fn();
    await act(async () => root.render(<Probe projectId={null} onChatModeChange={change} />));
    mocks.accept.mockResolvedValue(null);
    await act(async () =>
      expect(await probe.value!.accept("approval-required")).toBe(en["wizard.access.saveFailed"]),
    );
    expect(change).not.toHaveBeenCalled();
    expect(mocks.toast).not.toHaveBeenCalled();
  });

  it("knows when the project sets its own permissions", async () => {
    mocks.projectOverrides = { "project-a": { defaultRuntimeMode: "approval-required" } };
    await act(async () => root.render(<Probe projectId="project-a" onChatModeChange={vi.fn()} />));
    expect(probe.value!.input.projectSetsMode).toBe(true);
  });
});

describe("composerAccessRecommendationFor", () => {
  const recommendation = (newChatMode: RuntimeMode): ComposerAccessRecommendation => ({
    input: {
      answer: null,
      settingsKnown: true,
      machineRole: null,
      projectSetsMode: false,
      chatStarted: false,
    },
    accept: vi.fn(),
    decline: vi.fn(),
    newChatMode,
  });
  const modes = [{ mode: "approval-required" as const }, { mode: "full-access" as const }];

  it("asks on a Supervised draft where new chats start Supervised", () => {
    const value = recommendation("approval-required");
    expect(composerAccessRecommendationFor(value, "approval-required", modes)).toBe(value);
  });

  it("does not ask on a draft set to Supervised by hand where new chats start on Full access", () => {
    expect(
      composerAccessRecommendationFor(recommendation("full-access"), "approval-required", modes),
    ).toBeNull();
  });

  it("does not ask when the provider has no Full access or team rules cap it", () => {
    const value = recommendation("approval-required");
    expect(
      composerAccessRecommendationFor(value, "approval-required", [{ mode: "approval-required" }]),
    ).toBeNull();
    expect(
      composerAccessRecommendationFor(value, "approval-required", [
        { mode: "approval-required" },
        { mode: "full-access", aboveTeamLimit: true },
      ]),
    ).toBeNull();
  });
});
