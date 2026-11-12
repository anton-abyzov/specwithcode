// @vitest-environment jsdom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { EnvironmentId, ProjectId } from "@specweave-studio/contracts";
import { afterEach, beforeEach, expect, it, vi } from "vite-plus/test";

const mocks = vi.hoisted(() => ({
  importThreads: vi.fn(),
  createProject: vi.fn(),
  complete: vi.fn(),
  refresh: vi.fn(),
  toast: vi.fn(),
  projects: [] as Array<{ id: string; environmentId: string; workspaceRoot: string }>,
  invite: vi.fn(),
  revoke: vi.fn(),
  copy: vi.fn(),
  tailscale: vi.fn(),
  signIn: vi.fn(),
  openExternal: vi.fn(),
  linkHere: vi.fn(),
}));
vi.mock("./ProjectsFolderChoice", () => ({ ProjectsFolderChoice: () => null }));
vi.mock("../../hooks/useProjectFolderChoice", () => ({ rememberRecentFolder: () => {} }));
vi.mock("../../studio/fleet", () => {
  class FleetInviteFailure extends Error {
    constructor(
      readonly reason: string,
      message: string,
    ) {
      super(message);
    }
  }
  return {
    FleetInviteFailure,
    inviteStudioFleetMachine: mocks.invite,
    revokeStudioFleetInvitation: mocks.revoke,
    readStudioFleetTailscale: mocks.tailscale,
    signInStudioFleetTailscale: mocks.signIn,
  };
});
vi.mock("../../localApi", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../localApi")>()),
  ensureLocalApi: () => ({ shell: { openExternal: mocks.openExternal } }),
}));
vi.mock("../../hooks/useCopyToClipboard", () => ({
  useCopyToClipboard: () => ({ copyToClipboard: mocks.copy, isCopied: false }),
}));
vi.mock("../../state/session", () => ({
  useEnvironmentScope: () => true,
  useEnvironmentsWithScope: (environments: Array<{ environmentId: string }>) =>
    new Set(environments.map((entry) => entry.environmentId)),
  readEnvironmentScope: () => true,
}));
vi.mock("../../state/agentSessions", () => ({ agentSessionImport: "import" }));
vi.mock("../../state/projects", () => ({ projectEnvironment: { create: "create" } }));
vi.mock("../../state/use-atom-command", () => ({
  useAtomCommand: (command: string) =>
    command === "import"
      ? mocks.importThreads
      : command === "create"
        ? mocks.createProject
        : mocks.refresh,
}));
vi.mock("../../onboarding/firstRun", () => ({ useCompleteOnboarding: () => mocks.complete }));
vi.mock("../../state/entities", () => ({
  useProjects: () => mocks.projects,
  readProjects: () => mocks.projects,
}));
vi.mock("../../state/environments", () => {
  const environment = {
    environmentId: "test-env",
    label: "Computer",
    connection: { phase: "connected" },
  };
  return {
    useEnvironments: () => ({ environments: [environment] }),
    usePrimaryEnvironment: () => environment,
  };
});
vi.mock("../../state/server", () => ({
  serverEnvironment: {
    providersValueAtom: () => [],
    configValueAtom: () => null,
    refreshProviders: "refresh",
  },
}));
vi.mock("@effect/atom-react", () => ({ useAtomValue: (value: unknown) => value }));
vi.mock("../../onboarding/useProjectScans", () => ({
  useProjectScans: () => [
    {
      environmentId: "test-env",
      isPending: false,
      error: null,
      refresh: mocks.refresh,
      data: {
        truncated: false,
        candidates: [
          {
            path: "/project",
            title: "project",
            projectId: "test-project",
            threadCount: 29,
            lastActiveAt: new Date().toISOString(),
            sources: ["codex"],
          },
        ],
      },
    },
  ],
}));
const start = vi.hoisted(() => ({ props: null as Record<string, unknown> | null }));
vi.mock("./SignInFirstStep", () => ({
  SignInFirstStep: (props: Record<string, unknown>) => {
    start.props = props;
    return <h1>Sign-in first</h1>;
  },
}));
vi.mock("../../cloud/useCloudLinkController", () => ({
  useCloudLinkController: () => ({
    linked: false,
    publishAgentActivity: false,
    reconcileCloudState: mocks.linkHere,
  }),
}));
vi.mock("../../connection/onboarding", () => ({ connectPairing: vi.fn() }));
vi.mock("../../state/terminal", () => ({ terminalEnvironment: {} }));
const cloud = vi.hoisted(() => ({ configured: false, signedIn: false, loaded: true }));
vi.mock("../clerk/useStudioConnectAuthPrompt", () => ({
  useStudioConnectAuthPrompt: () => ({ authPrompt: null, openAuthPrompt: vi.fn() }),
}));
vi.mock("@clerk/react", () => ({
  useAuth: () => ({ isLoaded: cloud.loaded, isSignedIn: cloud.signedIn }),
}));
vi.mock("../../cloud/publicConfig", () => ({ hasCloudPublicConfig: () => cloud.configured }));
vi.mock("../../onboarding/targetEnvironment.logic", () => ({
  isOnboardingRelayEnvironment: () => false,
}));
vi.mock("../ThreadTerminalDrawer", () => ({ TerminalViewport: () => null }));
vi.mock("../settings/ChatGptWelcomeCoordinator", () => ({ ChatGptWelcomeCoordinator: () => null }));
vi.mock("../settings/CodexSetupSection", () => ({
  CodexSetupSection: () => null,
  AddManagedCodexAccountDialog: () => null,
}));
vi.mock("../cloud/CloudEnvironmentConnectList", () => ({
  CloudEnvironmentConnectRows: () => null,
}));
vi.mock("../ui/toast", () => ({
  toastManager: { add: mocks.toast, close: vi.fn(), update: vi.fn() },
}));

import { WelcomeWizard } from "./WelcomeWizard";

let root: Root;
let container: HTMLDivElement;

beforeEach(() => {
  vi.clearAllMocks();
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
  mocks.projects = [];
  mocks.complete.mockResolvedValue(undefined);
  mocks.tailscale.mockResolvedValue(tailscaleRunning);
  mocks.openExternal.mockResolvedValue(undefined);
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
});
afterEach(async () => {
  await act(async () => root.unmount());
  container.remove();
});

async function click(label: string) {
  const button = [...document.querySelectorAll("button")].find(
    (element) => element.textContent?.trim() === label,
  );
  expect(button, `button ${label}`).toBeDefined();
  await act(async () => button!.click());
}
const heading = () => document.querySelector("h1")?.textContent ?? "";
const tailscaleRunning = {
  state: "running",
  backendState: "Running",
  magicDns: true,
  platform: "darwin",
  homebrew: true,
  // A server that knows SpecWithCode Connect, so the request names `via`.
  connect: { linked: false, origin: null },
};

it("asks no question about what this machine is for", async () => {
  await act(async () => root.render(<WelcomeWizard localAvailable firstRun onDone={vi.fn()} />));
  expect(heading()).toBe("Connect your computers");
  expect(document.body.textContent).not.toContain("How will you use this");
  expect(document.body.textContent).not.toContain("Decide later");
  expect(mocks.invite).not.toHaveBeenCalled();
});

it("opens focused on the step's main button, not on the close button", async () => {
  await act(async () => root.render(<WelcomeWizard localAvailable firstRun onDone={vi.fn()} />));
  await act(async () => new Promise<void>((resolve) => requestAnimationFrame(() => resolve())));
  expect(document.activeElement?.hasAttribute("data-wizard-primary")).toBe(true);
});

const closeSetup = () =>
  document.querySelector<HTMLButtonElement>('button[aria-label="Close setup"]');

it.each([
  ["a first run", true],
  ["a setup opened again", false],
])("closes setup from %s and opens the app", async (_, firstRun) => {
  const onDone = vi.fn();
  await act(async () =>
    root.render(<WelcomeWizard localAvailable firstRun={firstRun} onDone={onDone} />),
  );
  expect(closeSetup()).not.toBeNull();
  await act(async () => closeSetup()!.click());
  expect(mocks.complete).toHaveBeenCalledOnce();
  expect(onDone).toHaveBeenCalledExactlyOnceWith(undefined);
});

const pressEscape = (target: Element) =>
  act(async () => {
    target.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true }));
  });

it("leaves setup on Escape, as the close button does", async () => {
  const onDone = vi.fn();
  await act(async () => root.render(<WelcomeWizard localAvailable firstRun onDone={onDone} />));
  await act(async () => new Promise<void>((resolve) => requestAnimationFrame(() => resolve())));
  await pressEscape(document.activeElement!);
  expect(mocks.complete).toHaveBeenCalledOnce();
  expect(onDone).toHaveBeenCalledExactlyOnceWith(undefined);
});

it("keeps Escape for a terminal inside setup", async () => {
  const onDone = vi.fn();
  await act(async () => root.render(<WelcomeWizard localAvailable firstRun onDone={onDone} />));
  const terminal = document.createElement("div");
  terminal.className = "xterm";
  terminal.append(document.createElement("textarea"));
  document.querySelector('[data-slot="dialog-panel"]')!.append(terminal);
  await pressEscape(terminal.firstElementChild!);
  expect(heading()).toBe("Connect your computers");
  expect(mocks.complete).not.toHaveBeenCalled();
  expect(onDone).not.toHaveBeenCalled();
});

const stageBar = () =>
  [...document.querySelectorAll('[aria-label="Setup progress"] li')].map(
    (item) => item.textContent?.trim().replace(/^\d+/, "") ?? "",
  );
const currentStage = () =>
  document.querySelector('[aria-label="Setup progress"] [aria-current="step"]')?.textContent ?? "";

it("shows the stage bar on every step and goes back with the footer's Back", async () => {
  await act(async () => root.render(<WelcomeWizard localAvailable firstRun onDone={vi.fn()} />));
  expect(stageBar()).toEqual(["Computers", "Agents", "Projects"]);
  expect(currentStage()).toContain("Computers");
  expect(heading()).toBe("Connect your computers");
  expect(stageBar()).toEqual(["Computers", "Agents", "Projects"]);
  // The first step of the bar has nowhere to go back to.
  expect(
    [...document.querySelectorAll("button")].some((b) => b.textContent?.trim() === "Back"),
  ).toBe(false);

  await click("Continue");
  expect(heading()).toBe("Connect your agents");
  expect(currentStage()).toContain("Agents");
  await click("Back");
  expect(heading()).toBe("Connect your computers");

  await click("Continue");
  await click("Continue");
  expect(currentStage()).toContain("Projects");
  await click("Back");
  expect(heading()).toBe("Connect your agents");
});

it("draws each step's footer below the scrolling panel, with the Enter key on its primary", async () => {
  await act(async () => root.render(<WelcomeWizard localAvailable onDone={vi.fn()} />));
  const primary = document.querySelector<HTMLButtonElement>("[data-wizard-primary]")!;
  expect(primary.textContent?.trim()).toBe("Continue");
  expect(primary.getAttribute("aria-keyshortcuts")).toBe("Enter");
  expect(primary.querySelector("kbd")?.getAttribute("data-key")).toMatch(/^(↵|Enter)$/);
  expect(primary.closest('[data-slot="wizard-footer-slot"]')).not.toBeNull();
  expect(primary.closest('[data-slot="dialog-panel"]')).toBeNull();
});

const pressEnter = (target: Element) =>
  act(async () => {
    target.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true }));
  });

it("presses the step's primary on Enter from the step, and leaves other buttons their Enter", async () => {
  await act(async () => root.render(<WelcomeWizard localAvailable onDone={vi.fn()} />));
  expect(heading()).toBe("Connect your computers");
  // A button keeps its own Enter: this one opens the pairing form.
  const pairing = [...document.querySelectorAll("button")].find((b) =>
    b.textContent?.includes("Add a computer"),
  )!;
  await pressEnter(pairing);
  expect(heading()).toBe("Connect your computers");
  // Anywhere else in the step, Enter is Continue.
  await pressEnter(document.querySelector('[data-slot="dialog-panel"] h1')!);
  expect(heading()).toBe("Connect your agents");
});

it("keeps setup open on Escape where there is no server to open", async () => {
  await act(async () => root.render(<WelcomeWizard localAvailable={false} onDone={vi.fn()} />));
  await pressEscape(document.querySelector('[data-slot="dialog-popup"]')!);
  expect(mocks.complete).not.toHaveBeenCalled();
});

it("keeps pairing required without a server on this machine", async () => {
  await act(async () => root.render(<WelcomeWizard localAvailable={false} onDone={vi.fn()} />));
  expect(closeSetup()).toBeNull();
});

it("starts at the connection step without a server on this machine", async () => {
  await act(async () => root.render(<WelcomeWizard localAvailable={false} onDone={vi.fn()} />));
  expect(heading()).toBe("Connect your computers");
  expect(document.body.textContent).not.toContain("How will you use this");
});

it("starts the desktop app with Connect at the sign-in, with no role question", async () => {
  cloud.configured = true;
  vi.stubGlobal("desktopBridge", {});
  try {
    await act(async () => root.render(<WelcomeWizard localAvailable firstRun onDone={vi.fn()} />));
    expect(heading()).toBe("Sign-in first");
    expect(document.body.textContent).not.toContain("How will you use this");
    expect(start.props).toMatchObject({ environmentId: "test-env", machineNoun: "machine" });
    // The stage bar shows from the first step on.
    expect(document.body.textContent).toContain("Agents");

    // The step that pairs other computers is one press away, and Back leads back.
    await act(async () => (start.props!.onOtherComputers as () => void)());
    expect(heading()).toBe("Connect your computers");
    await click("Back");
    expect(heading()).toBe("Sign-in first");

    // Going on from the step that pairs other computers, Back from Agents returns
    // there, where the computers picked are, not to the sign-in.
    await act(async () => (start.props!.onOtherComputers as () => void)());
    await click("Continue");
    expect(heading()).toBe("Connect your agents");
    await click("Back");
    expect(heading()).toBe("Connect your computers");
    await click("Back");
    expect(heading()).toBe("Sign-in first");

    // Continuing sets up the agents on this machine; no role is saved.
    await act(async () => (start.props!.onContinue as () => void)());
    expect(heading()).not.toBe("Sign-in first");
    expect(document.body.textContent).not.toContain("Connect your computers");
    // Going on from the sign-in, Back returns to the sign-in.
    await click("Back");
    expect(heading()).toBe("Sign-in first");
    await act(async () => (start.props!.onContinue as () => void)());
    expect(mocks.invite).not.toHaveBeenCalled();

    // Setup opened again after first run starts at the connection step.
    await act(async () => root.unmount());
    root = createRoot(container);
    await act(async () => root.render(<WelcomeWizard localAvailable onDone={vi.fn()} />));
    expect(heading()).toBe("Connect your computers");
  } finally {
    cloud.configured = false;
    vi.unstubAllGlobals();
    vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  }
});

it("starts at the connection step in a browser and in a build without Connect", async () => {
  // A browser on a machine's own server: the desktop app is what links a machine at sign-in.
  cloud.configured = true;
  try {
    await act(async () => root.render(<WelcomeWizard localAvailable firstRun onDone={vi.fn()} />));
    expect(heading()).toBe("Connect your computers");
  } finally {
    cloud.configured = false;
  }
  vi.stubGlobal("desktopBridge", {});
  try {
    await act(async () => root.unmount());
    root = createRoot(container);
    await act(async () => root.render(<WelcomeWizard localAvailable firstRun onDone={vi.fn()} />));
    expect(heading()).toBe("Connect your computers");
  } finally {
    vi.unstubAllGlobals();
    vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  }
});

it("names Connect optional and reports a sign-in that never loads, without blocking setup", async () => {
  vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
  cloud.configured = true;
  cloud.loaded = false;
  try {
    await act(async () => root.render(<WelcomeWizard localAvailable firstRun onDone={vi.fn()} />));
    expect(document.body.textContent).toContain("Optional.");
    expect(document.body.textContent).toContain("Loading sign-in…");
    expect(document.querySelector("[role=alert]")).toBeNull();
    await act(async () => vi.advanceTimersByTimeAsync(10_000));
    expect(document.body.textContent).toContain("Sign-in did not load");
    expect(document.querySelector("[role=alert]")?.textContent).toContain(
      "Setup works without Connect",
    );
    const buttons = [...document.querySelectorAll("button")];
    expect(buttons.find((button) => button.textContent?.trim() === "Retry")).toBeDefined();
    expect(buttons.find((button) => button.textContent?.trim() === "Continue")?.disabled).toBe(
      false,
    );
  } finally {
    cloud.configured = false;
    cloud.loaded = true;
    vi.useRealTimers();
  }
});

it("does not call Connect optional with no server here", async () => {
  cloud.configured = true;
  try {
    await act(async () => root.render(<WelcomeWizard localAvailable={false} onDone={vi.fn()} />));
    expect(document.body.textContent).toContain("SpecWithCode Connect");
    expect(document.body.textContent).not.toContain("Optional.");
  } finally {
    cloud.configured = false;
  }
});

const stageButton = (label: string) =>
  [...document.querySelectorAll<HTMLButtonElement>('[aria-label="Setup progress"] button')].find(
    (element) => element.textContent?.includes(label),
  );

it("returns to the connection step from the stage bar after going on from it", async () => {
  await act(async () => root.render(<WelcomeWizard localAvailable firstRun onDone={vi.fn()} />));
  await click("Continue");
  expect(heading()).toBe("Connect your agents");
  expect(stageButton("Computers"), "stage Computers").toBeDefined();
  await act(async () => stageButton("Computers")!.click());
  expect(heading()).toBe("Connect your computers");
  expect(currentStage()).toContain("Computers");
});

it("resumes at the agents of one machine, with Back to the connection step", async () => {
  await act(async () =>
    root.render(
      <WelcomeWizard
        localAvailable
        resumeEnvironmentId={EnvironmentId.make("test-env")}
        onDone={vi.fn()}
      />,
    ),
  );
  expect(heading()).toBe("Connect your agents");
  expect(currentStage()).toContain("Agents");
  await click("Back");
  expect(heading()).toBe("Connect your computers");
  await click("Continue");
  expect(heading()).toBe("Connect your agents");
});
