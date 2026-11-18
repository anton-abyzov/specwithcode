// @vitest-environment jsdom
import { EnvironmentId } from "@specweave-studio/contracts";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vite-plus/test";

import { en } from "../../i18n/messages/en";

const mocks = vi.hoisted(() => ({
  answer: null as "accepted" | "declined" | null,
  machineRole: null as "main" | "joined" | null,
  defaultRuntimeMode: undefined as string | undefined,
  teamRules: undefined as unknown,
  configLoaded: true,
  primaryId: "test-env",
  accept: vi.fn(),
  decline: vi.fn(),
  undo: vi.fn(),
  complete: vi.fn(),
}));
// The Full Disk Access row and first-run item have their own test.
vi.mock("../access/FullDiskAccess", () => ({
  FullDiskAccessRow: () => null,
  FirstRunFullDiskAccess: () => null,
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
      ...(mocks.primaryId === "test-env"
        ? []
        : [
            {
              environmentId: mocks.primaryId,
              label: "This computer",
              serverConfig: { settings: { defaultRuntimeMode: "approval-required" } },
            },
          ]),
      {
        environmentId: "test-env",
        label: "Computer",
        serverConfig: mocks.configLoaded
          ? {
              settings: { defaultRuntimeMode: mocks.defaultRuntimeMode ?? "approval-required" },
              teamRules: mocks.teamRules,
            }
          : null,
      },
    ],
  }),
  usePrimaryEnvironment: () => ({ environmentId: mocks.primaryId, serverConfig: null }),
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
  ImportStep: (props: { onBack: () => void; onDone: () => void }) => (
    <>
      <button type="button" onClick={props.onBack}>
        Projects back
      </button>
      <button type="button" onClick={() => props.onDone()}>
        Projects skip
      </button>
    </>
  ),
}));
vi.mock("./SignInFirstStep", () => ({ SignInFirstStep: () => null }));
vi.mock("./FirstRunUpdateNotice", () => ({ FirstRunUpdateNotice: () => null }));
vi.mock("../github/StarOnGitHub", () => ({ StarOnGitHubLink: () => null }));
vi.mock("../settings/LanguageSelect", () => ({ LanguageSelect: () => null }));
vi.mock("../settings/ChatGptWelcomeCoordinator", () => ({ ChatGptWelcomeCoordinator: () => null }));
vi.mock("../../onboarding/firstRun", () => ({
  useCompleteOnboarding: () => mocks.complete,
}));
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
  mocks.configLoaded = true;
  mocks.primaryId = "test-env";
  mocks.accept.mockResolvedValue(new Map([["test-env", "approval-required"]]));
  mocks.decline.mockResolvedValue(undefined);
  mocks.undo.mockResolvedValue(true);
  mocks.complete.mockResolvedValue(undefined);
  Reflect.deleteProperty(window, "desktopBridge");
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

const accessShown = () => document.querySelector('[aria-label^="Access, step"]') !== null;
const rowIds = () =>
  [...document.querySelectorAll("[data-access-row]")].map((row) =>
    row.getAttribute("data-access-row"),
  );
const filesRow = () => document.querySelector<HTMLElement>('[data-access-row="files"]');

it("shows Access as a list after Agents and before Projects, with Continue the only filled button", async () => {
  await openAccess();
  const bar = [...document.querySelectorAll('[aria-label="Setup progress"] li [aria-label]')];
  expect(bar.map((stage) => stage.getAttribute("aria-label")?.split(",")[0])).toEqual([
    en["wizard.stage.connect"],
    en["wizard.stage.agents"],
    en["wizard.stage.access"],
    en["wizard.stage.projects"],
  ]);
  expect(bar[2]?.getAttribute("aria-current")).toBe("step");
  // A browser tab gets only Files and commands.
  expect(rowIds()).toEqual(["files"]);
  expect(document.querySelector("h1")?.textContent).toBe("What agents can use");
  const row = filesRow()!;
  expect(row.textContent).toContain("Full access: agents edit and run without asking each time.");
  // Both answers are the row's own outline buttons; nothing starts selected.
  expect(button(en["wizard.access.use"])?.closest("[data-access-row]")).toBe(row);
  expect(button(en["wizard.access.keepSupervised"])?.closest("[data-access-row]")).toBe(row);
  const primary = [...document.querySelectorAll<HTMLButtonElement>("[data-wizard-primary]")];
  expect(primary.map((element) => element.textContent?.trim().replace(/\s+/g, ""))).toEqual([
    en["wizard.continue"],
  ]);
  expect(primary[0]!.hasAttribute("data-wizard-neutral")).toBe(true);
  // Focus moved to the step's neutral action, so Enter goes on.
  expect(document.activeElement).toBe(primary[0]);
  // "What it allows" opens today's explanation in the row.
  expect(row.textContent).not.toContain(en["wizard.access.allowCommands"]);
  await click("What it allows");
  for (const key of [
    "wizard.access.allowCommands",
    "wizard.access.allowFiles",
    "wizard.access.allowNetwork",
    "wizard.access.stillStops",
  ] as const) {
    expect(row.textContent).toContain(en[key]);
  }
});

it("Use Full access saves it for the machines being set up and stays on the step", async () => {
  await openAccess();
  await click(en["wizard.access.use"]);
  expect(mocks.accept).toHaveBeenCalledWith(["test-env"]);
  expect(mocks.decline).not.toHaveBeenCalled();
  expect(button("Projects back")).toBeUndefined();
  expect(filesRow()!.textContent).toContain("New chats start with Full access.");
  // Focus does not fall to the page: it moves to the control that replaced the pressed one.
  expect(document.activeElement).toBe(button("Change"));
  // The answer turned the recommendation off; the row and the stage stay.
  mocks.answer = "accepted";
  await act(async () => root.render(<WelcomeWizard localAvailable onDone={vi.fn()} />));
  expect(rowIds()).toEqual(["files"]);
  expect(accessShown()).toBe(true);
});

it("Keep Supervised records the answer only and stays on the step", async () => {
  await openAccess();
  await click(en["wizard.access.keepSupervised"]);
  expect(mocks.decline).toHaveBeenCalledOnce();
  expect(mocks.accept).not.toHaveBeenCalled();
  expect(filesRow()!.textContent).toContain("New chats stay Supervised.");
  expect(button("Projects back")).toBeUndefined();
});

it("stays on the step and says so when saving fails", async () => {
  mocks.accept.mockResolvedValue(null);
  await openAccess();
  await click(en["wizard.access.use"]);
  expect(filesRow()!.textContent).toContain(en["wizard.access.saveFailed"]);
  expect(button(en["wizard.access.use"])?.disabled).toBe(false);
});

it("Change after accepting, then Keep Supervised, puts the earlier access back", async () => {
  await openAccess();
  await click(en["wizard.access.use"]);
  await click("Change");
  expect(document.activeElement).toBe(button(en["wizard.access.use"]));
  await click(en["wizard.access.keepSupervised"]);
  expect(mocks.undo).toHaveBeenCalledWith(new Map([["test-env", "approval-required"]]));
  expect(mocks.decline).not.toHaveBeenCalled();
  expect(filesRow()!.textContent).toContain("New chats stay Supervised.");
});

it("Continue answers nothing and goes on; Back on Projects returns to the unanswered row", async () => {
  await openAccess();
  await click(en["wizard.continue"]);
  expect(button("Projects back")).toBeDefined();
  expect(mocks.accept).not.toHaveBeenCalled();
  expect(mocks.decline).not.toHaveBeenCalled();
  await click("Projects back");
  expect(button(en["wizard.access.use"])).toBeDefined();
});

it("walks every step on its neutral control and writes only that setup finished", async () => {
  const onDone = vi.fn();
  await act(async () => root.render(<WelcomeWizard localAvailable onDone={onDone} />));
  await click("Connection continue");
  await click("Agents continue");
  await click(en["wizard.continue"]);
  await click("Projects skip");
  expect(mocks.complete).toHaveBeenCalledOnce();
  expect(onDone).toHaveBeenCalledOnce();
  // No access mode, no answer, no undo.
  expect(mocks.accept).not.toHaveBeenCalled();
  expect(mocks.decline).not.toHaveBeenCalled();
  expect(mocks.undo).not.toHaveBeenCalled();
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
])("in a browser tab, leaves the step out when %s", async (_reason, arrange) => {
  arrange();
  await act(async () => root.render(<WelcomeWizard localAvailable onDone={vi.fn()} />));
  expect(accessShown()).toBe(false);
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
  expect(accessShown()).toBe(true);
});

it("waits for the machine's settings before showing Access, then keeps the stage", async () => {
  mocks.configLoaded = false;
  const wizard = () => <WelcomeWizard localAvailable onDone={vi.fn()} />;
  await act(async () => root.render(wizard()));
  // Not loaded yet: no guess that it starts Supervised.
  expect(accessShown()).toBe(false);
  mocks.configLoaded = true;
  await act(async () => root.render(wizard()));
  expect(accessShown()).toBe(true);
  // A later change does not take the stage away again.
  mocks.defaultRuntimeMode = "full-access";
  await act(async () => root.render(wizard()));
  expect(accessShown()).toBe(true);
});

it("names the machines and saves Full access on this machine too, whose access the others follow", async () => {
  mocks.primaryId = "main-env";
  await act(async () =>
    root.render(
      <WelcomeWizard
        localAvailable
        resumeEnvironmentId={EnvironmentId.make("test-env")}
        onDone={vi.fn()}
      />,
    ),
  );
  await click("Agents continue");
  expect(filesRow()!.textContent).toContain("On This computer, Computer.");
  await click(en["wizard.access.use"]);
  expect(mocks.accept).toHaveBeenCalledWith(["main-env", "test-env"]);
});

it("in the desktop app shows the rows for this computer, even with nothing to recommend", async () => {
  mocks.answer = "declined";
  Object.defineProperty(window, "desktopBridge", { configurable: true, value: {} });
  await act(async () => root.render(<WelcomeWizard localAvailable onDone={vi.fn()} />));
  expect(accessShown()).toBe(true);
  await click("Connection continue");
  await click("Agents continue");
  expect(rowIds()).toEqual([]);
  expect(document.querySelector("h1")?.textContent).toBe("What agents can use on this machine");
});
