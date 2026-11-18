// @vitest-environment jsdom
import type { FirstRunResumeMarker } from "@specweave-studio/contracts";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vite-plus/test";

const mocks = vi.hoisted(() => ({
  environments: [] as { environmentId: string; label: string; serverConfig: unknown }[],
  primaryId: "this-mac" as string | null,
  save: vi.fn(async (_marker: unknown) => undefined),
  take: vi.fn(async (): Promise<unknown> => null),
}));
// Mac apps' own test covers the checklist; here Quit & Reopen is one button.
vi.mock("./MacAppsRow", () => ({
  MacAppsRow: (props: { onBeforeRelaunch?: () => Promise<unknown> }) => (
    <li data-access-row="mac-apps">
      <button type="button" onClick={() => void props.onBeforeRelaunch?.()}>
        Quit and reopen
      </button>
    </li>
  ),
}));
vi.mock("./ChromeAccessRow", () => ({
  ChromeAccessRow: () => <li data-access-row="browser" />,
}));
vi.mock("../access/FullDiskAccess", () => ({
  FullDiskAccessRow: () => null,
  FirstRunFullDiskAccess: () => null,
}));
vi.mock("../../onboarding/accessRecommendation", () => ({
  useFullAccessRecommendation: () => ({
    answer: "declined",
    machineRole: null,
    hydrated: true,
    accept: vi.fn(),
    decline: vi.fn(),
    undo: vi.fn(),
  }),
}));
vi.mock("../../state/environments", () => ({
  useEnvironments: () => ({ environments: mocks.environments }),
  usePrimaryEnvironment: () =>
    mocks.primaryId === null ? null : { environmentId: mocks.primaryId, serverConfig: null },
}));
vi.mock("./ConnectionStep", () => ({
  ConnectionStep: (props: { onContinue: () => void }) => (
    <button type="button" onClick={props.onContinue}>
      Connection continue
    </button>
  ),
}));
vi.mock("./AgentsStep", () => ({
  AgentsStep: (props: { onContinue: () => void }) => (
    <button type="button" onClick={props.onContinue}>
      Agents continue
    </button>
  ),
}));
vi.mock("./ProjectsStep", () => ({ ImportStep: () => null }));
vi.mock("./SignInFirstStep", () => ({ SignInFirstStep: () => null }));
vi.mock("./FirstRunUpdateNotice", () => ({ FirstRunUpdateNotice: () => null }));
vi.mock("../github/StarOnGitHub", () => ({ StarOnGitHubLink: () => null }));
vi.mock("../settings/LanguageSelect", () => ({ LanguageSelect: () => null }));
vi.mock("../settings/ChatGptWelcomeCoordinator", () => ({ ChatGptWelcomeCoordinator: () => null }));
vi.mock("../../onboarding/firstRun", () => ({ useCompleteOnboarding: () => vi.fn() }));
vi.mock("../../onboarding/useProjectScans", () => ({ useProjectScans: () => [] }));
vi.mock("../../cloud/publicConfig", () => ({ hasCloudPublicConfig: () => false }));
vi.mock("../ui/toast", () => ({ toastManager: { add: vi.fn(), close: vi.fn(), update: vi.fn() } }));

import { WelcomeWizard } from "./WelcomeWizard";

const machine = (environmentId: string, label: string) => ({
  environmentId,
  label,
  serverConfig: {
    environment: { platform: { os: "darwin" } },
    settings: { defaultRuntimeMode: "approval-required" },
  },
});
const marker = (overrides: Partial<FirstRunResumeMarker> = {}): FirstRunResumeMarker => ({
  step: "access",
  environmentId: "this-mac",
  setupIds: ["this-mac", "studio"],
  at: Date.now() - 20_000,
  ...overrides,
});

let root: Root;
let container: HTMLDivElement;
beforeEach(() => {
  vi.clearAllMocks();
  mocks.environments = [machine("this-mac", "This Mac"), machine("studio", "Studio")];
  mocks.primaryId = "this-mac";
  mocks.take.mockResolvedValue(null);
  Object.defineProperty(window, "desktopBridge", {
    configurable: true,
    value: {
      saveFirstRunResume: mocks.save,
      takeFirstRunResume: mocks.take,
      // The Mac apps row shows where the desktop app reads this Mac's permissions.
      getComputerUsePermissions: async () => ({ screenRecording: false, accessibility: false }),
    },
  });
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
  Reflect.deleteProperty(window, "desktopBridge");
  vi.unstubAllGlobals();
});

const step = () => document.querySelector("[data-wizard-step]")?.getAttribute("data-wizard-step");
const render = async (firstRun = true) => {
  await act(async () =>
    root.render(<WelcomeWizard localAvailable firstRun={firstRun} onDone={vi.fn()} />),
  );
};
const click = async (label: string) => {
  const target = [...document.querySelectorAll("button")].find((element) =>
    element.textContent?.trim().startsWith(label),
  );
  expect(target, `button ${label}`).toBeDefined();
  await act(async () => target!.click());
};

it("Quit & Reopen from Access saves the step and the machines being set up", async () => {
  await render();
  await click("Connection continue");
  await click("Agents continue");
  expect(step()).toBe("access");
  await click("Quit and reopen");
  expect(mocks.save).toHaveBeenCalledWith(
    expect.objectContaining({
      step: "access",
      environmentId: "this-mac",
      setupIds: ["this-mac", "studio"],
    }),
  );
});

it("after reopening, setup opens on Access for the same machines", async () => {
  mocks.take.mockResolvedValue(marker());
  await render();
  expect(mocks.take).toHaveBeenCalledTimes(1);
  expect(step()).toBe("access");
  expect(document.querySelector("[data-access-row='mac-apps']")).not.toBeNull();
});

it("waits for every machine it names before reopening on Access", async () => {
  mocks.environments = [machine("this-mac", "This Mac")];
  mocks.take.mockResolvedValue(marker());
  await render();
  expect(step()).toBe("connection");
  mocks.environments = [machine("this-mac", "This Mac"), machine("studio", "Studio")];
  await render();
  expect(step()).toBe("access");
  expect(mocks.take).toHaveBeenCalledTimes(1);
});

it.each([
  ["older than ten minutes", marker({ at: Date.now() - 11 * 60_000 })],
  ["for another machine", marker({ environmentId: "studio" })],
])("a marker %s is ignored", async (_name, given) => {
  mocks.take.mockResolvedValue(given);
  await render();
  expect(step()).toBe("connection");
});

it("asks only on a first run, once this machine is known", async () => {
  mocks.primaryId = null;
  await render();
  expect(mocks.take).not.toHaveBeenCalled();
  mocks.primaryId = "this-mac";
  await render(false);
  expect(mocks.take).not.toHaveBeenCalled();
  await render(true);
  await render(true);
  expect(mocks.take).toHaveBeenCalledTimes(1);
});

it("a browser tab never asks", async () => {
  Reflect.deleteProperty(window, "desktopBridge");
  await render();
  expect(mocks.take).not.toHaveBeenCalled();
});

it("after reopening, Files and commands shows the saved answer without Change", async () => {
  mocks.take.mockResolvedValue(marker({ filesIds: ["this-mac", "studio"] }));
  await render();
  expect(step()).toBe("access");
  const files = document.querySelector("[data-access-row='files']");
  expect(files?.textContent).toContain("Settings > General");
  const buttons = [...(files?.querySelectorAll("button") ?? [])].map((b) => b.textContent?.trim());
  expect(buttons).not.toContain("Change");
});

it("after reopening, Files and commands stays away when it had no answer", async () => {
  mocks.take.mockResolvedValue(marker());
  await render();
  expect(step()).toBe("access");
  expect(document.querySelector("[data-access-row='files']")).toBeNull();
});
