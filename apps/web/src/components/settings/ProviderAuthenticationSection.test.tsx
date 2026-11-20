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
