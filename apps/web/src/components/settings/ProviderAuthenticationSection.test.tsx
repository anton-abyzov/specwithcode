import type { ReactElement } from "react";
import type { ProviderAuthState, ServerProvider } from "@specweave-studio/contracts";
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
  return { ...actual, useState: reactHookHarness.useState, useRef: reactHookHarness.useRef };
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
  instanceId: "copilot-m1",
  driver: "acpRegistry",
  displayName: "GitHub Copilot",
  enabled: true,
  installed: true,
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
});
