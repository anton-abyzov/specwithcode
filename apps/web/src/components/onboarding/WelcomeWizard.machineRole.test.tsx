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
}));
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
vi.mock("../../connection/onboarding", () => ({ connectPairing: vi.fn() }));
vi.mock("../../state/terminal", () => ({ terminalEnvironment: {} }));
const cloud = vi.hoisted(() => ({ configured: false, signedIn: false }));
vi.mock("../clerk/useStudioConnectAuthPrompt", () => ({
  useStudioConnectAuthPrompt: () => ({ authPrompt: null, openAuthPrompt: vi.fn() }),
}));
vi.mock("@clerk/react", () => ({
  useAuth: () => ({ isLoaded: true, isSignedIn: cloud.signedIn }),
}));
vi.mock("../../cloud/publicConfig", () => ({ hasCloudPublicConfig: () => cloud.configured }));
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

import { FleetInviteFailure } from "../../studio/fleet";
import { WelcomeWizard, type WelcomeMachineRole } from "./WelcomeWizard";

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
/** The choice buttons hold a title and a sentence; match by title. */
async function choose(title: string) {
  const button = [...document.querySelectorAll("button")].find((element) =>
    element.textContent?.trim().startsWith(title),
  );
  expect(button, `choice ${title}`).toBeDefined();
  await act(async () => button!.click());
}
/** Joining requires explicitly approving the main machine by its environment ID. */
async function approveMainMachine(id = "approved-main") {
  const input = [...document.querySelectorAll("label")]
    .find((element) => element.textContent?.includes("Main machine environment ID"))
    ?.querySelector("input");
  expect(input, "main machine environment ID input").toBeDefined();
  const setValue = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!;
  await act(async () => {
    setValue.call(input!, id);
    input!.dispatchEvent(new Event("input", { bubbles: true }));
  });
}
const makeLine = () =>
  [...document.querySelectorAll("button")].find(
    (element) => element.textContent?.trim() === "Make the line",
  );
const heading = () => document.querySelector("h1")?.textContent ?? "";
const line = () =>
  document.querySelector<HTMLInputElement>(
    'input[aria-label="Invitation line for the main machine"]',
  );
function role(overrides: Partial<WelcomeMachineRole> = {}): WelcomeMachineRole {
  return { offer: true, role: null, onChange: vi.fn(async () => undefined), ...overrides };
}

const tailscaleRunning = {
  state: "running",
  backendState: "Running",
  magicDns: true,
  platform: "darwin",
  homebrew: true,
  // A server that knows SpecWithCode Connect, so the request names `via`.
  connect: { linked: false, origin: null },
};

const invitation = {
  code: "swc-machine-synthetic-line",
  url: "https://m4.tailnet.ts.net",
  label: "Computer",
  expiresAt: "2027-10-18T00:00:00.000Z",
  sessionId: "synthetic-invite-session",
};

it("sets this machine up as the main one with the regular setup, unchanged", async () => {
  const machineRole = role();
  await act(async () =>
    root.render(<WelcomeWizard localAvailable machineRole={machineRole} onDone={vi.fn()} />),
  );
  expect(heading()).toBe("How will you use this machine?");
  await choose("Start as a main machine");
  expect(machineRole.onChange).toHaveBeenCalledExactlyOnceWith("main");
  expect(heading()).toBe("Connect your computers");
  expect(mocks.invite).not.toHaveBeenCalled();
});

it("opens focused on the first choice, not on the close button", async () => {
  await act(async () =>
    root.render(<WelcomeWizard localAvailable machineRole={role()} onDone={vi.fn()} />),
  );
  await act(async () => new Promise<void>((resolve) => requestAnimationFrame(() => resolve())));
  expect(document.activeElement?.textContent?.trim()).toMatch(/^Start as a main machine/);
});

it("decides later: opens the app with nothing chosen or set up", async () => {
  const machineRole = role();
  const onDone = vi.fn();
  await act(async () =>
    root.render(<WelcomeWizard localAvailable machineRole={machineRole} onDone={onDone} />),
  );
  expect(document.body.textContent).toContain("Invite this machine under Settings > Connections");
  await click("Decide later");
  expect(mocks.complete).toHaveBeenCalledOnce();
  expect(onDone).toHaveBeenCalledExactlyOnceWith(undefined);
  expect(machineRole.onChange).not.toHaveBeenCalled();
  expect(mocks.invite).not.toHaveBeenCalled();
});

const closeSetup = () =>
  document.querySelector<HTMLButtonElement>('button[aria-label="Close setup"]');

it.each([
  ["the choice", role()],
  ["a joined machine's status", role({ offer: false, role: "joined" })],
  ["the regular setup", role({ offer: false })],
])("closes setup from %s and opens the app", async (_, machineRole) => {
  const onDone = vi.fn();
  await act(async () =>
    root.render(<WelcomeWizard localAvailable machineRole={machineRole} onDone={onDone} />),
  );
  expect(closeSetup()).not.toBeNull();
  await act(async () => closeSetup()!.click());
  expect(mocks.complete).toHaveBeenCalledOnce();
  expect(onDone).toHaveBeenCalledExactlyOnceWith(undefined);
  expect(machineRole.onChange).not.toHaveBeenCalled();
});

it("keeps Escape inside setup, where the agent terminal also uses it", async () => {
  const onDone = vi.fn();
  await act(async () =>
    root.render(<WelcomeWizard localAvailable machineRole={role()} onDone={onDone} />),
  );
  await act(async () => {
    document.activeElement?.dispatchEvent(
      new KeyboardEvent("keydown", { key: "Escape", bubbles: true }),
    );
  });
  expect(heading()).toBe("How will you use this machine?");
  expect(mocks.complete).not.toHaveBeenCalled();
  expect(onDone).not.toHaveBeenCalled();
});

it("keeps pairing required without a server on this machine", async () => {
  await act(async () => root.render(<WelcomeWizard localAvailable={false} onDone={vi.fn()} />));
  expect(closeSetup()).toBeNull();
});

it("joins existing machines: makes the line once, then opens to this machine's status", async () => {
  mocks.invite.mockResolvedValue(invitation);
  const machineRole = role();
  const onDone = vi.fn();
  await act(async () =>
    root.render(<WelcomeWizard localAvailable machineRole={machineRole} onDone={onDone} />),
  );
  await choose("Connect to an existing one");
  expect(heading()).toBe("Connect this machine to your main machine");
  expect(document.body.textContent).toContain("Sign in to SpecWithCode Connect on this machine.");
  expect(document.body.textContent).not.toContain("Tailscale on both");
  expect(machineRole.onChange).not.toHaveBeenCalled();
  expect(makeLine()?.disabled).toBe(true);
  await approveMainMachine();
  await click("Make the line");
  expect(mocks.invite).toHaveBeenCalledExactlyOnceWith("test-env", {
    label: "",
    coordinatorEnvironmentId: "approved-main",
    via: "auto",
  });
  expect(line()?.value).toBe("swc-machine-synthetic-line");
  expect(machineRole.onChange).toHaveBeenCalledExactlyOnceWith("joined");
  expect(document.body.textContent).toContain("Settings > Connections > Add a machine");
  await click("Copy");
  expect(mocks.copy).toHaveBeenCalledWith("swc-machine-synthetic-line", undefined);
  await click("I pasted it");
  expect(heading()).toBe("This machine is ready for your main machine");
  expect(line()).toBeNull();
  expect(document.body.textContent).not.toContain("swc-machine-synthetic-line");
  // Agents and projects are skipped: setup never completes the regular way.
  expect(mocks.complete).not.toHaveBeenCalled();
  expect(onDone).not.toHaveBeenCalled();
});

it("says in plain words when Tailscale is missing and keeps the choice open", async () => {
  mocks.invite.mockRejectedValue(
    new FleetInviteFailure(
      "tailscale_missing",
      "Tailscale is not installed on this machine. Install it from tailscale.com/download, open it and sign in, then try again.",
    ),
  );
  const machineRole = role();
  await act(async () =>
    root.render(<WelcomeWizard localAvailable machineRole={machineRole} onDone={vi.fn()} />),
  );
  await choose("Connect to an existing one");
  await approveMainMachine();
  await click("Make the line");
  const alert = document.querySelector('[role="alert"]');
  expect(alert?.textContent).toContain("Tailscale is not installed");
  expect(alert?.textContent).toContain("tailscale.com/download");
  expect(line()).toBeNull();
  expect(machineRole.onChange).not.toHaveBeenCalled();
  await click("Back");
  expect(heading()).toBe("How will you use this machine?");
});

it("opens a joined machine to its status, with a way to the full setup", async () => {
  const machineRole = role({ offer: false, role: "joined" });
  await act(async () =>
    root.render(<WelcomeWizard localAvailable machineRole={machineRole} onDone={vi.fn()} />),
  );
  expect(heading()).toBe("This machine is ready for your main machine");
  expect(line()).toBeNull();
  await click("Set this machine up as a main machine instead");
  expect(machineRole.onChange).toHaveBeenCalledExactlyOnceWith("main");
  expect(heading()).toBe("Connect your computers");
});

it("never offers the choice to someone who already finished first run", async () => {
  await act(async () =>
    root.render(
      <WelcomeWizard localAvailable machineRole={role({ offer: false })} onDone={vi.fn()} />,
    ),
  );
  expect(heading()).toBe("Connect your computers");
  expect(document.body.textContent).not.toContain("Connect to an existing one");
});

it("never offers the choice without a server on this machine", async () => {
  await act(async () => root.render(<WelcomeWizard localAvailable={false} onDone={vi.fn()} />));
  expect(heading()).toBe("Connect your computers");
  expect(document.body.textContent).not.toContain("Connect to an existing one");
});

it("offers to install Tailscale when it is missing and enables the line once it is there", async () => {
  vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
  try {
    mocks.tailscale.mockResolvedValue({
      state: "not_installed",
      backendState: null,
      magicDns: false,
      platform: "darwin",
      homebrew: true,
    });
    await act(async () =>
      root.render(<WelcomeWizard localAvailable machineRole={role()} onDone={vi.fn()} />),
    );
    await choose("Connect to an existing one");
    await approveMainMachine();
    expect(document.body.textContent).toContain("Tailscale is not installed");
    const make = makeLine;
    expect(make()?.disabled).toBe(true);
    await click("Install Tailscale");
    expect(mocks.openExternal).toHaveBeenCalledExactlyOnceWith(
      "https://tailscale.com/download/mac",
    );
    const brew = document.querySelector<HTMLInputElement>(
      'input[aria-label="Command that installs Tailscale with Homebrew"]',
    );
    expect(brew?.value).toBe("brew install --cask tailscale");
    // The app never installs it; it only looks again until it is there.
    mocks.tailscale.mockResolvedValue(tailscaleRunning);
    await act(async () => vi.advanceTimersByTimeAsync(3_000));
    expect(document.body.textContent).not.toContain("Tailscale is not installed");
    expect(make()?.disabled).toBe(false);
    expect(mocks.signIn).not.toHaveBeenCalled();
    expect(mocks.invite).not.toHaveBeenCalled();
  } finally {
    vi.useRealTimers();
  }
});

it("signs in to Tailscale from the app and opens the sign-in page", async () => {
  mocks.tailscale.mockResolvedValue({
    state: "signed_out",
    backendState: "NeedsLogin",
    magicDns: false,
    platform: "darwin",
    homebrew: false,
  });
  mocks.signIn.mockResolvedValue("https://login.tailscale.com/a/synthetic");
  await act(async () =>
    root.render(<WelcomeWizard localAvailable machineRole={role()} onDone={vi.fn()} />),
  );
  await choose("Connect to an existing one");
  expect(document.body.textContent).toContain("Tailscale is not signed in");
  expect(document.querySelector('input[aria-label^="Command that installs"]')).toBeNull();
  await click("Sign in to Tailscale");
  expect(mocks.signIn).toHaveBeenCalledExactlyOnceWith("test-env");
  expect(mocks.openExternal).toHaveBeenCalledExactlyOnceWith(
    "https://login.tailscale.com/a/synthetic",
  );
  await click("Open the sign-in page again");
  expect(mocks.openExternal).toHaveBeenCalledTimes(2);
  expect(mocks.invite).not.toHaveBeenCalled();
});

it("explains when signing in needs the person's own administrator step", async () => {
  mocks.tailscale.mockResolvedValue({
    state: "signed_out",
    backendState: "Stopped",
    magicDns: false,
    platform: "linux",
    homebrew: false,
  });
  mocks.signIn.mockRejectedValue(
    new FleetInviteFailure(
      "tailscale_needs_admin",
      "Tailscale needs administrator rights to sign in here. Run `sudo tailscale up` yourself, then come back.",
    ),
  );
  await act(async () =>
    root.render(<WelcomeWizard localAvailable machineRole={role()} onDone={vi.fn()} />),
  );
  await choose("Connect to an existing one");
  expect(document.body.textContent).toContain("Tailscale is turned off");
  await click("Sign in to Tailscale");
  expect(document.querySelector('[role="alert"]')?.textContent).toContain("sudo tailscale up");
  expect(mocks.openExternal).not.toHaveBeenCalled();
});

it("asks for SpecWithCode Connect first and enables the line once Connect is linked", async () => {
  vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
  cloud.configured = true;
  try {
    mocks.tailscale.mockResolvedValue({
      state: "not_installed",
      backendState: null,
      magicDns: false,
      platform: "linux",
      homebrew: false,
      connect: { linked: false, origin: null },
    });
    await act(async () =>
      root.render(<WelcomeWizard localAvailable machineRole={role()} onDone={vi.fn()} />),
    );
    await choose("Connect to an existing one");
    await approveMainMachine();
    expect(document.body.textContent).toContain("Link SpecWithCode Connect first");
    expect(document.body.textContent).toContain("Sign in to SpecWithCode Connect");
    expect(document.body.textContent).not.toContain("Tailscale is not installed");
    expect(document.body.textContent).not.toContain("Install Tailscale");
    expect(makeLine()?.disabled).toBe(true);
    // Signing in and publishing happen in Connect; the app looks again until it is linked.
    mocks.tailscale.mockResolvedValue({
      state: "not_installed",
      backendState: null,
      magicDns: false,
      platform: "linux",
      homebrew: false,
      connect: { linked: true, origin: "https://prod-0123456789abcdef.spec-weave.com" },
    });
    await act(async () => vi.advanceTimersByTimeAsync(3_000));
    expect(document.body.textContent).not.toContain("Link SpecWithCode Connect first");
    expect(makeLine()?.disabled).toBe(false);
    expect(mocks.signIn).not.toHaveBeenCalled();
    expect(mocks.invite).not.toHaveBeenCalled();
  } finally {
    cloud.configured = false;
    vi.useRealTimers();
  }
});

it("tells a signed-in person to turn on Connect for this machine in Settings", async () => {
  cloud.configured = true;
  cloud.signedIn = true;
  try {
    mocks.tailscale.mockResolvedValue({
      state: "not_installed",
      backendState: null,
      magicDns: false,
      platform: "linux",
      homebrew: false,
      connect: { linked: false, origin: null },
    });
    await act(async () =>
      root.render(<WelcomeWizard localAvailable machineRole={role()} onDone={vi.fn()} />),
    );
    await choose("Connect to an existing one");
    expect(document.body.textContent).toContain(
      "Turn on SpecWithCode Connect for this machine under Settings > Connections > SpecWithCode Connect.",
    );
  } finally {
    cloud.configured = false;
    cloud.signedIn = false;
  }
});
