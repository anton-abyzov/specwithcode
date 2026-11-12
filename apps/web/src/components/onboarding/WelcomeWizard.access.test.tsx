// @vitest-environment jsdom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vite-plus/test";

import { en } from "../../i18n/messages/en";

const mocks = vi.hoisted(() => ({
  answer: null as "accepted" | "declined" | null,
  machineRole: null as "main" | "joined" | null,
  defaultRuntimeMode: undefined as string | undefined,
  teamRules: undefined as unknown,
  accept: vi.fn(),
  decline: vi.fn(),
  undo: vi.fn(),
}));
vi.mock("../../onboarding/accessRecommendation", () => ({
  useFullAccessRecommendation: () => ({
    answer: mocks.answer,
    machineRole: mocks.machineRole,
    hydrated: true,
    accept: mocks.accept,
    decline: mocks.decline,
    undo: mocks.undo,
  }),
}));
vi.mock("../../state/environments", () => ({
  useEnvironments: () => ({
    environments: [
      {
        environmentId: "test-env",
        label: "Computer",
        serverConfig:
          mocks.defaultRuntimeMode === undefined && mocks.teamRules === undefined
            ? null
            : {
                settings: { defaultRuntimeMode: mocks.defaultRuntimeMode ?? "approval-required" },
                teamRules: mocks.teamRules,
              },
      },
    ],
  }),
  usePrimaryEnvironment: () => ({ environmentId: "test-env", serverConfig: null }),
}));
// The other steps have their own tests; here each is one button on to the next.
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
vi.mock("./ProjectsStep", () => ({
  ImportStep: (props: { onBack: () => void }) => (
    <button type="button" onClick={props.onBack}>
      Projects back
    </button>
  ),
}));
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

let root: Root;
let container: HTMLDivElement;

beforeEach(() => {
  vi.clearAllMocks();
  mocks.answer = null;
  mocks.machineRole = null;
  mocks.defaultRuntimeMode = undefined;
  mocks.teamRules = undefined;
  mocks.accept.mockResolvedValue(new Map([["test-env", "approval-required"]]));
  mocks.decline.mockResolvedValue(undefined);
  mocks.undo.mockResolvedValue(true);
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
    (element) => element.textContent?.trim().startsWith(label) === true,
  );
async function click(label: string) {
  const target = button(label);
  expect(target, `button ${label}`).toBeDefined();
  await act(async () => target!.click());
}
async function openAccess() {
  await act(async () => root.render(<WelcomeWizard localAvailable onDone={vi.fn()} />));
  await click("Connection continue");
  await click("Agents continue");
}

it("shows Access after Agents and before Projects, with what Full access allows and what still stops", async () => {
  await openAccess();
  const text = document.body.textContent ?? "";
  expect(text).toContain(en["wizard.access.title"]);
  expect(text).toContain(en["wizard.access.recommended"]);
  for (const key of [
    "wizard.access.allowCommands",
    "wizard.access.allowFiles",
    "wizard.access.allowNetwork",
    "wizard.access.stillStops",
    "wizard.access.supervisedDescription",
  ] as const) {
    expect(text).toContain(en[key]);
  }
  const bar = [...document.querySelectorAll('[aria-label="Setup progress"] li [aria-label]')];
  expect(bar.map((stage) => stage.getAttribute("aria-label")?.split(",")[0])).toEqual([
    en["wizard.stage.connect"],
    en["wizard.stage.agents"],
    en["wizard.stage.access"],
    en["wizard.stage.projects"],
  ]);
  expect(bar[2]?.getAttribute("aria-current")).toBe("step");
  // The primary is the recommended action and the Enter target.
  const primary = document.querySelector<HTMLButtonElement>("[data-wizard-primary]");
  expect(primary?.textContent).toContain(en["wizard.access.use"]);
  expect(button(en["wizard.access.keepSupervised"])).toBeDefined();
});

it("Use Full access saves it for the machines being set up and moves on to Projects", async () => {
  await openAccess();
  await click(en["wizard.access.use"]);
  expect(mocks.accept).toHaveBeenCalledWith(["test-env"]);
  expect(mocks.decline).not.toHaveBeenCalled();
  expect(button("Projects back")).toBeDefined();
});

it("Keep Supervised records the answer only and moves on to Projects", async () => {
  await openAccess();
  await click(en["wizard.access.keepSupervised"]);
  expect(mocks.decline).toHaveBeenCalledOnce();
  expect(mocks.accept).not.toHaveBeenCalled();
  expect(button("Projects back")).toBeDefined();
});

it("stays on the step and says so when saving fails", async () => {
  mocks.accept.mockResolvedValue(null);
  await openAccess();
  await click(en["wizard.access.use"]);
  expect(document.body.textContent).toContain(en["wizard.access.saveFailed"]);
  expect(button("Projects back")).toBeUndefined();
  expect(button(en["wizard.access.use"])?.disabled).toBe(false);
});

it("going back after accepting and keeping Supervised puts the earlier access back", async () => {
  await openAccess();
  await click(en["wizard.access.use"]);
  await click("Projects back");
  await click(en["wizard.access.keepSupervised"]);
  expect(mocks.undo).toHaveBeenCalledWith(new Map([["test-env", "approval-required"]]));
  expect(mocks.decline).not.toHaveBeenCalled();
  expect(button("Projects back")).toBeDefined();
});

it.each([
  ["it was answered before", () => (mocks.answer = "declined")],
  ["it was accepted before", () => (mocks.answer = "accepted")],
  ["the saved role is joined", () => (mocks.machineRole = "joined")],
  ["new chats already start on Full access", () => (mocks.defaultRuntimeMode = "full-access")],
  [
    "team rules cap access below Full access",
    () => (mocks.teamRules = { status: "active", ceiling: "approval-required" }),
  ],
])("leaves the step out when %s", async (_reason, arrange) => {
  arrange();
  await act(async () => root.render(<WelcomeWizard localAvailable onDone={vi.fn()} />));
  expect(document.querySelector('[aria-label^="Access, step"]')).toBeNull();
  await click("Connection continue");
  await click("Agents continue");
  expect(button("Projects back")).toBeDefined();
  // The same setup without that reason asks.
  await act(async () => root.unmount());
  mocks.answer = null;
  mocks.machineRole = null;
  mocks.defaultRuntimeMode = undefined;
  mocks.teamRules = undefined;
  root = createRoot(container);
  await openAccess();
  expect(document.querySelector('[aria-label^="Access, step"]')).not.toBeNull();
});
