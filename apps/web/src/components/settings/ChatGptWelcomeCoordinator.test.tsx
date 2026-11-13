// @vitest-environment jsdom
import { act, type ReactNode } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vite-plus/test";

let presentations = new Map<string, unknown>();
vi.mock("@effect/atom-react", () => ({ useAtomValue: () => presentations }));
vi.mock("../../state/presentation", () => ({
  environmentPresentations: { presentationsAtom: {} },
}));
vi.mock("../../studio/machineNickname", () => ({
  useMachineNicknames: () => (_id: string, label: string) => label,
}));
vi.mock("./ChatGptUsageButton", () => ({ ChatGptUsageButton: () => null }));
vi.mock("../ui/dialog", () => ({
  Dialog: ({ open, children }: { open: boolean; children: ReactNode }) =>
    open ? <div data-testid="welcome">{children}</div> : null,
  DialogPopup: ({ children }: { children: ReactNode }) => <>{children}</>,
  DialogHeader: ({ children }: { children: ReactNode }) => <>{children}</>,
  DialogTitle: ({ children }: { children: ReactNode }) => <h2>{children}</h2>,
  DialogDescription: ({ children }: { children: ReactNode }) => <p>{children}</p>,
  DialogFooter: ({ children }: { children: ReactNode }) => <>{children}</>,
}));

import { ChatGptWelcomeCoordinator } from "./ChatGptWelcomeCoordinator";
import {
  CHATGPT_WELCOME_PENDING_TTL_MS,
  clearChatGptSignIn,
  noteChatGptSignInStarted,
} from "./chatGptWelcomeState";

const machine = (label: string, profileId?: string) => ({
  connection: { phase: "connected" },
  entry: { target: { label } },
  serverConfig: {
    providers: [
      {
        instanceId: "codex",
        displayName: "Codex",
        auth:
          profileId === undefined
            ? { status: "unauthenticated" }
            : { status: "authenticated", subscriptionSharing: true, profileId },
      },
    ],
  },
});

let root: Root;
let container: HTMLDivElement;
const render = () =>
  act(() => {
    root.render(<ChatGptWelcomeCoordinator />);
  });
const shown = () => container.querySelector('[data-testid="welcome"]') !== null;
const clickContinue = () =>
  act(() => {
    [...container.querySelectorAll("button")]
      .find((button) => button.textContent === "Continue")
      ?.click();
  });

beforeEach(() => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  localStorage.clear();
  presentations = new Map();
  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
});

afterEach(() => {
  act(() => root.unmount());
  container.remove();
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

describe("ChatGptWelcomeCoordinator", () => {
  it("stays closed when another machine's ChatGPT sign-in reaches this window", () => {
    // M5 signed in; M4's window sees M5 connected with sharing, but never started a sign-in.
    presentations = new Map([
      ["env-m4", machine("M4", "m4-profile")],
      ["env-m5", machine("M5", "new-m5-profile")],
    ]);
    render();
    expect(shown()).toBe(false);
  });

  it("stays closed when a synced or refreshed snapshot connects a profile here", () => {
    render();
    presentations = new Map([["env-m4", machine("M4", "synced-profile")]]);
    render();
    expect(shown()).toBe(false);
  });

  it("shows once after a sign-in this window started, then never again", () => {
    presentations = new Map([["env-m4", machine("M4")]]);
    render();
    act(() => noteChatGptSignInStarted("env-m4", "codex"));
    expect(shown()).toBe(false);

    // The sign-in finishes: the instance now has a ChatGPT profile.
    presentations = new Map([["env-m4", machine("M4", "profile-a")]]);
    render();
    expect(shown()).toBe(true);
    expect(container.textContent).toContain("Your ChatGPT plan is connected");
    expect(container.textContent).toContain("Codex on M4");

    clickContinue();
    expect(shown()).toBe(false);

    // Signing in again to the same account does not repeat the welcome.
    presentations = new Map([["env-m4", machine("M4")]]);
    render();
    act(() => noteChatGptSignInStarted("env-m4", "codex"));
    presentations = new Map([["env-m4", machine("M4", "profile-a")]]);
    render();
    expect(shown()).toBe(false);
    act(() => root.unmount());
    root = createRoot(container);
    render();
    expect(shown()).toBe(false);
  });

  it("waits for a Change account sign-in to finish instead of greeting the old account", () => {
    presentations = new Map([["env-m4", machine("M4", "old-profile")]]);
    render();
    act(() => noteChatGptSignInStarted("env-m4", "codex"));
    expect(shown()).toBe(false);

    presentations = new Map([["env-m4", machine("M4", "new-profile")]]);
    render();
    expect(shown()).toBe(true);
    clickContinue();
    expect(shown()).toBe(false);
  });

  it("shows only for the machine this window signed in, not for other machines", () => {
    presentations = new Map([
      ["env-m4", machine("M4")],
      ["env-m5", machine("M5", "m5-profile")],
    ]);
    render();
    act(() => noteChatGptSignInStarted("env-m4", "codex"));
    presentations = new Map([
      ["env-m4", machine("M4", "m4-profile")],
      ["env-m5", machine("M5", "m5-profile")],
    ]);
    render();
    expect(container.textContent).toContain("Codex on M4");
    clickContinue();
    expect(shown()).toBe(false);
  });

  it("drops a cancelled or stale sign-in", () => {
    presentations = new Map([["env-m4", machine("M4")]]);
    render();
    act(() => {
      noteChatGptSignInStarted("env-m4", "codex");
      clearChatGptSignIn("env-m4", "codex");
    });
    presentations = new Map([["env-m4", machine("M4", "profile-a")]]);
    render();
    expect(shown()).toBe(false);

    presentations = new Map([["env-m4", machine("M4")]]);
    render();
    vi.useFakeTimers({ toFake: ["Date"] });
    act(() => noteChatGptSignInStarted("env-m4", "codex"));
    vi.setSystemTime(Date.now() + CHATGPT_WELCOME_PENDING_TTL_MS + 1);
    presentations = new Map([["env-m4", machine("M4", "profile-a")]]);
    render();
    expect(shown()).toBe(false);
  });
});
