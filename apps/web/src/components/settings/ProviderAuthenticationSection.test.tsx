import type { ReactElement } from "react";
import {
  ProviderInstanceId,
  ProviderDriverKind,
  type ProviderAuthState,
  type ServerProvider,
} from "@specweave-studio/contracts";
import { beforeEach, describe, expect, it, vi } from "vite-plus/test";
import { visitElements } from "../../test/reactElementTree";
import { reactHookHarness as hooks } from "../../test/reactHookHarness";

const state = vi.hoisted(() => ({
  auth: null as ProviderAuthState | null,
  queryError: null as string | null,
  command: vi.fn(),
  copy: vi.fn(),
  open: vi.fn(),
}));
vi.mock("react", async (original) => {
  const actual = await original<typeof import("react")>();
  const { reactHookHarness } = await import("../../test/reactHookHarness");
  return {
    ...actual,
    useSyncExternalStore: (_subscribe: unknown, getSnapshot: () => unknown) => getSnapshot(),
    useState: reactHookHarness.useState,
    useRef: reactHookHarness.useRef,
  };
});
vi.mock("react/compiler-runtime", async () => {
  const { reactHookHarness } = await import("../../test/reactHookHarness");
  return { c: reactHookHarness.useMemoCache };
});
vi.mock("../../state/query", () => ({
  useEnvironmentQuery: () => ({ data: state.auth, error: state.queryError }),
}));
vi.mock("../../state/server", () => ({
  serverEnvironment: {
    providerAuthState: (target: unknown) => target,
    startProviderAuth: "start",
    respondProviderAuth: "respond",
    completeProviderAuth: "complete",
    cancelProviderAuth: "cancel",
    logoutProviderAuth: "logout",
  },
}));
vi.mock("../../state/use-atom-command", () => ({
  useAtomCommand: (command: string) => (target: unknown) => state.command(command, target),
}));
vi.mock("../../hooks/useCopyToClipboard", () => ({
  writeTextToClipboard: (...args: unknown[]) => state.copy(...args),
}));
vi.mock("../../localApi", () => ({
  ensureLocalApi: () => ({ shell: { openExternal: state.open } }),
}));
vi.mock("@specweave-studio/client-runtime/state/runtime", () => ({
  isAtomCommandInterrupted: () => false,
  squashAtomCommandFailure: () => new Error("Sign-in failed"),
}));
vi.mock("./settingsLayout", () => ({ SettingsRow: () => null }));
import { CopilotSignInHints, type CopilotHostChoice } from "./CopilotSignInHints";
import { ProviderAuthenticationSection } from "./ProviderAuthenticationSection";

const provider = {
  instanceId: ProviderInstanceId.make("copilot-m1"),
  driver: ProviderDriverKind.make("acpRegistry"),
  displayName: "GitHub Copilot",
  enabled: true,
  installed: true,
  version: null,
  status: "ready",
  auth: { status: "unknown" },
  setup: { canAuthenticate: true, canInstall: false },
  checkedAt: "2026-10-14T00:00:00.000Z",
  models: [],
  slashCommands: [],
  skills: [],
} as ServerProvider;
function render(overrides: Partial<Parameters<typeof ProviderAuthenticationSection>[0]> = {}) {
  hooks.beginRender();
  return ProviderAuthenticationSection({
    environmentId: "m1" as never,
    environmentLabel: "M1",
    instanceId: "copilot-m1" as never,
    provider,
    readOnly: false,
    ...overrides,
  });
}
function text(value: unknown): string {
  if (typeof value === "string") return value;
  if (Array.isArray(value)) return value.map(text).join(" ");
  if (value && typeof value === "object" && "props" in value)
    return text((value as ReactElement<{ children: unknown }>).props.children);
  return "";
}
function button(tree: unknown, name: string) {
  return visitElements(
    tree,
    (element) =>
      typeof element.props.onClick === "function" &&
      (element.props["aria-label"] === name || text(element.props.children).trim() === name),
  );
}
function click(tree: unknown, name: string) {
  const element = button(tree, name);
  expect(element, name).not.toBeNull();
  (element!.props.onClick as () => void)();
}
const flush = async () => {
  await Promise.resolve();
  await Promise.resolve();
  await Promise.resolve();
};
beforeEach(() => {
  hooks.reset();
  state.command.mockReset().mockResolvedValue({ _tag: "Success" });
  state.copy.mockReset().mockResolvedValue(undefined);
  state.open.mockReset().mockResolvedValue(undefined);
  state.queryError = null;
  state.auth = {
    instanceId: provider.instanceId,
    phase: "waiting",
    flowId: "flow-m1",
    authorizationUrl: null,
    expiresAt: null,
    message: null,
    methods: [{ id: "github", name: "GitHub", type: "terminal", description: null }],
    interaction: {
      type: "terminal",
      id: "pty-m1",
      output: "Confirm native credential storage",
      deviceCode: { url: "https://github.com/login/device", userCode: "MONE-1111" },
    } as ProviderAuthState["interaction"],
  };
});

describe("provider device consent", () => {
  it("only sends the chosen Copilot host when the server confirms owner access", async () => {
    state.auth = {
      ...state.auth!,
      phase: "idle",
      flowId: null,
      copilotExistingSignIns: { vscodeCopilot: false, ghAccounts: [] },
      copilotCanSelectHost: true,
    };
    const hostPicker = (tree: unknown) =>
      visitElements(tree, (element) => element.type === CopilotSignInHints);
    const pick = hostPicker(render())?.props.onHostChange as (choice: CopilotHostChoice) => void;
    pick({ choice: "other", typed: "company.ghe.com" });
    state.auth = { ...state.auth, copilotCanSelectHost: false };
    const remote = render();
    expect(hostPicker(remote)?.props.onHostChange).toBeUndefined();
    click(remote, "Sign in");
    await flush();
    expect(state.command).toHaveBeenCalledWith("start", {
      environmentId: "m1",
      input: { instanceId: "copilot-m1" },
    });
    state.auth = { ...state.auth, copilotCanSelectHost: true };
    click(render(), "Sign in");
    await flush();
    expect(state.command).toHaveBeenLastCalledWith("start", {
      environmentId: "m1",
      input: { instanceId: "copilot-m1", host: "company.ghe.com" },
    });
  });

  it("opens only on an explicit controlling-client action and copies the code separately from the URL", async () => {
    const tree = render();
    expect(state.open).not.toHaveBeenCalled();
    expect(state.command).not.toHaveBeenCalled();
    expect(JSON.stringify(tree)).toContain("Device sign-in for M1");
    click(tree, "Copy code");
    click(tree, "Open browser");
    await flush();
    expect(state.copy).toHaveBeenCalledWith("MONE-1111", "Provider sign-in code");
    expect(state.open).toHaveBeenCalledWith("https://github.com/login/device");
    expect(state.command).not.toHaveBeenCalled();
  });

  it.each(["succeeded", "cancelled", "failed"] as const)(
    "hides stale code, URL and terminal in %s state",
    (phase) => {
      state.auth = { ...state.auth!, phase, authorizationUrl: "https://github.com/login/device" };
      const tree = render();
      expect(button(tree, "Open browser")).toBeNull();
      expect(button(tree, "Copy code")).toBeNull();
      expect(JSON.stringify(tree)).not.toContain("MONE-1111");
      expect(
        visitElements(tree, (element) => typeof element.props.onResponse === "function"),
      ).toBeNull();
    },
  );

  it("keeps cancellation and retry bound to the selected environment and instance", async () => {
    click(render(), "Cancel sign-in");
    await flush();
    expect(state.command).toHaveBeenCalledWith("cancel", {
      environmentId: "m1",
      input: { instanceId: "copilot-m1", flowId: "flow-m1" },
    });
    state.auth = {
      ...state.auth!,
      phase: "failed",
      message: "Device sign-in is unsupported. Update Copilot.",
    };
    click(render(), "Retry sign-in");
    await flush();
    expect(state.command).toHaveBeenLastCalledWith("start", {
      environmentId: "m1",
      input: { instanceId: "copilot-m1" },
    });
  });

  it("does not show an old copy completion on a replacement flow", async () => {
    let finish!: () => void;
    state.copy.mockImplementationOnce(
      () =>
        new Promise<void>((resolve) => {
          finish = resolve;
        }),
    );
    click(render(), "Copy code");
    state.auth = { ...state.auth!, flowId: "replacement-m1" };
    render();
    finish();
    await flush();
    expect(JSON.stringify(render())).not.toContain("Code copied");
  });

  it("keeps device actions disabled when settings are read-only or disconnected", () => {
    for (const disconnected of [false, true]) {
      state.queryError = disconnected ? "Environment disconnected" : null;
      const tree = render({ readOnly: !disconnected });
      for (const name of ["Open browser", "Copy sign-in link", "Copy code", "Cancel sign-in"])
        expect(button(tree, name)?.props.disabled).toBe(true);
    }
    expect(state.open).not.toHaveBeenCalled();
    expect(state.copy).not.toHaveBeenCalled();
  });

  it.each([false, true])(
    "refuses a sign-in link that is not a web address (consent required: %s)",
    async (requiresConsent) => {
      const pendingTab = { opener: {}, location: { href: "" }, close: vi.fn() };
      const open = vi.fn().mockReturnValue(pendingTab);
      vi.stubGlobal("window", { open });
      try {
        state.auth = {
          ...state.auth!,
          interaction: {
            type: "browser",
            id: "browser-m1",
            url: "javascript:alert(document.domain)",
            requiresConsent,
          },
        };
        click(render(), "Open browser");
        await flush();
        expect(pendingTab.location.href).toBe("");
        expect(state.open).not.toHaveBeenCalled();
        expect(state.command).not.toHaveBeenCalled();
        expect(JSON.stringify(render())).toContain("not a web address");
        click(render(), "Copy sign-in link");
        await flush();
        expect(state.copy).not.toHaveBeenCalled();
        expect(state.command).not.toHaveBeenCalled();
        expect(JSON.stringify(render())).toContain("so it was not copied");
      } finally {
        vi.unstubAllGlobals();
      }
    },
  );

  it("names the GitHub login the instance is signed in as", () => {
    state.auth = { ...state.auth!, phase: "succeeded", interaction: null };
    const tree = render({
      provider: { ...provider, auth: { status: "authenticated", login: "work-account" } },
    }) as ReactElement<{ description: unknown }>;
    expect(text(tree.props.description).replace(/\s+/g, " ")).toContain(
      "Signed in as work-account",
    );
    expect(button(tree, "Change account")).not.toBeNull();
  });
});

describe("sign-in states on a remote machine", () => {
  const remote = { environmentId: "m3" as never, environmentLabel: "m3" };
  const idle = (patch: Partial<ProviderAuthState> = {}): ProviderAuthState => ({
    instanceId: provider.instanceId,
    phase: "idle",
    flowId: null,
    authorizationUrl: null,
    expiresAt: null,
    message: null,
    methods: [
      { id: "oauth-personal", name: "Log in with Google", type: "agent", description: null },
    ],
    ...patch,
  });
  const row = (tree: unknown) => {
    const props = (tree as ReactElement<Record<string, unknown>>).props;
    return { description: text(props.description), status: text(props.status) };
  };
  const hints = (tree: unknown) =>
    visitElements(tree, (element) => "found" in element.props)!.props.found;
  const existing = { vscodeCopilot: false, ghAccounts: [{ host: "github.com", account: "sam" }] };

  it("shows a provider already verified on that machine as signed in, with no sign-in to do", () => {
    state.auth = idle({ copilotExistingSignIns: existing });
    const tree = render({
      ...remote,
      provider: { ...provider, auth: { status: "authenticated" } },
    });
    expect(row(tree)).toEqual({ description: "Signed in.", status: "" });
    expect(button(tree, "Sign in")).toBeNull();
    expect(button(tree, "Retry sign-in")).toBeNull();
    expect(button(tree, "Change account")).not.toBeNull();
    expect(hints(tree)).toBeUndefined();
    expect(state.command).not.toHaveBeenCalled();
  });

  it("clears the earlier failure when the sign-in is verified afterwards", () => {
    state.auth = idle({ phase: "failed", message: "The ACP agent could not complete sign-in." });
    const before = render(remote);
    expect(row(before).status).toBe("The ACP agent could not complete sign-in.");
    expect(button(before, "Retry sign-in")).not.toBeNull();
    const after = render({
      ...remote,
      provider: { ...provider, auth: { status: "authenticated" } },
    });
    expect(row(after)).toEqual({ description: "Signed in.", status: "" });
    expect(button(after, "Retry sign-in")).toBeNull();
  });

  it("keeps the reason when an account change fails on a signed-in provider", async () => {
    const signedIn = { ...remote, provider: { ...provider, auth: { status: "authenticated" } } };
    state.auth = idle();
    state.command.mockResolvedValue({ _tag: "Success", value: { flowId: "flow-change" } });
    click(render(signedIn as never), "Change account");
    await flush();
    const failed = (flowId: string) =>
      idle({ phase: "failed", flowId: flowId as never, message: "Copilot did not accept it." });
    state.auth = failed("flow-change");
    const tree = render(signedIn as never);
    expect(row(tree)).toEqual({ description: "Signed in.", status: "Copilot did not accept it." });
    expect(button(tree, "Change account")).not.toBeNull();
    // Another flow's failure (started elsewhere, or before this sign-in) is not this change's.
    state.auth = failed("flow-elsewhere");
    expect(row(render(signedIn as never)).status).toBe("");
  });

  it("does not take a sign-in started while signed out for an account change", async () => {
    state.auth = idle();
    state.command.mockResolvedValue({ _tag: "Success", value: { flowId: "flow-first" } });
    click(render(remote), "Sign in");
    await flush();
    state.auth = idle({ phase: "failed", flowId: "flow-first" as never, message: "Old failure." });
    const later = render({
      ...remote,
      provider: { ...provider, auth: { status: "authenticated" } },
    });
    expect(row(later)).toEqual({ description: "Signed in.", status: "" });
  });

  it("says unknown or not installed before anything about sign-in methods", () => {
    const noSignIn = { ...provider, setup: { canAuthenticate: false, canInstall: false } };
    state.auth = idle({ methods: [] });
    state.queryError = "m3 is not connected.";
    const unread = row(render({ ...remote, provider: noSignIn }));
    expect(unread.description).toBe("Could not read the sign-in state on m3.");
    state.queryError = null;
    // The driver reports no in-app sign-in for a program that is not there.
    const missing = render({ ...remote, provider: { ...noSignIn, installed: false } });
    expect(row(missing).description).toBe("Not installed on m3 yet.");
    expect(JSON.stringify(missing)).not.toContain("No in-app sign-in advertised");
    // Installed, with no sign-in of its own, keeps the docs wording.
    expect(row(render({ ...remote, provider: noSignIn })).description).toBe(
      "No in-app sign-in advertised. Follow the provider's docs to finish setup.",
    );
  });

  it("never says installed above a failure that says the program is missing", () => {
    state.auth = idle({
      phase: "failed",
      message: "Copilot CLI is not installed or not prepared on this machine.",
      retryable: false,
    });
    const tree = render({ ...remote, provider: { ...provider, installed: false } });
    expect(row(tree)).toEqual({
      description: "Not installed on m3 yet.",
      status: "Copilot CLI is not installed or not prepared on this machine.",
    });
  });

  it("keeps Check again when the failed attempt listed no sign-in methods", () => {
    state.auth = idle({
      phase: "failed",
      methods: [],
      message: "Prepare this ACP agent before signing in.",
      retryable: false,
    });
    const tree = render(remote);
    expect(button(tree, "Check again")).not.toBeNull();
    expect(row(tree).description).toBe("Installed on m3. Not signed in yet.");
  });

  it("says installed, not signed in, for a provider that only has its program on that machine", () => {
    state.auth = idle({ copilotExistingSignIns: existing });
    const unverified = render(remote);
    expect(row(unverified).description).toBe("Installed on m3. Sign-in not verified yet.");
    expect(button(unverified, "Sign in")).not.toBeNull();
    expect(hints(unverified)).toEqual(existing);
    const signedOut = render({
      ...remote,
      provider: { ...provider, auth: { status: "unauthenticated" } },
    });
    expect(row(signedOut).description).toBe("Installed on m3. Not signed in yet.");
    expect(JSON.stringify(signedOut)).not.toContain("Signed in.");
    // A finished browser page alone changes nothing: no flow succeeded.
    state.auth = idle({ authorizationUrl: "https://accounts.google.com/o/oauth2/v2/auth" });
    expect(row(render(remote)).description).toBe("Installed on m3. Sign-in not verified yet.");
  });

  it("names a state it could not read, and a program that is not there", () => {
    state.auth = idle();
    state.queryError = "m3 is not connected.";
    expect(row(render(remote)).description).toBe("Could not read the sign-in state on m3.");
    state.queryError = null;
    const missing = render({ ...remote, provider: { ...provider, installed: false } });
    expect(row(missing).description).toBe("Not installed on m3 yet.");
  });

  it("offers Check again when only an install or update can fix the failure", async () => {
    state.auth = idle({
      phase: "failed",
      message: "Copilot CLI 1.0.94 is too old: sign-in needs Copilot CLI 1.0.95 or newer.",
      retryable: false,
    });
    const tree = render(remote);
    expect(button(tree, "Retry sign-in")).toBeNull();
    click(tree, "Check again");
    await flush();
    expect(state.command).toHaveBeenLastCalledWith("start", {
      environmentId: "m3",
      input: { instanceId: "copilot-m1" },
    });
  });
});

describe("an account the provider refuses", () => {
  const refusedProvider = {
    ...provider,
    instanceId: ProviderInstanceId.make("gemini-m1"),
    displayName: "Gemini CLI",
    auth: { status: "unauthenticated", refusal: "personal_account_unsupported" },
  } as ServerProvider;
  const refusedAuth = (): ProviderAuthState => ({
    instanceId: refusedProvider.instanceId,
    phase: "failed",
    flowId: null,
    authorizationUrl: null,
    expiresAt: null,
    message: "Google accepted the sign-in, but no longer serves Gemini CLI.",
    retryable: false,
    refusal: "personal_account_unsupported",
    methods: [
      { id: "oauth-personal", name: "Log in with Google", type: "agent", description: null },
      { id: "env-config", name: "Use environment", type: "credentials", description: null },
      { id: "gemini-api-key", name: "Gemini API key", type: "credentials", description: null },
      { id: "vertex-ai", name: "Vertex AI", type: "agent", description: null },
    ],
  });
  const renderRefused = () =>
    render({ instanceId: refusedProvider.instanceId, provider: refusedProvider });

  it("offers the API-key method and Antigravity instead of a retry that cannot work", async () => {
    state.auth = refusedAuth();
    const tree = renderRefused();
    expect(button(tree, "Retry sign-in")).toBeNull();
    expect(button(tree, "Check again")).toBeNull();
    expect(JSON.stringify(tree)).toContain("https://antigravity.google");
    click(tree, "Use an API key");
    await flush();
    // The method that names an API key, never the environment-variable one listed first.
    expect(state.command).toHaveBeenLastCalledWith("start", {
      environmentId: "m1",
      input: { instanceId: "gemini-m1", methodId: "gemini-api-key" },
    });
  });

  it("still signs in with another method picked from the list", async () => {
    state.auth = refusedAuth();
    const picker = visitElements(
      renderRefused(),
      (element) => typeof element.props.onValueChange === "function",
    );
    expect(picker).not.toBeNull();
    (picker!.props.onValueChange as (value: string) => void)("vertex-ai");
    const tree = renderRefused();
    expect(button(tree, "Use an API key")).toBeNull();
    click(tree, "Sign in");
    await flush();
    expect(state.command).toHaveBeenLastCalledWith("start", {
      environmentId: "m1",
      input: { instanceId: "gemini-m1", methodId: "vertex-ai" },
    });
  });
});
