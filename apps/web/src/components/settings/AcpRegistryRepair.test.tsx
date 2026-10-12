import type { ReactElement } from "react";
import {
  EnvironmentId,
  ProviderDriverKind,
  ProviderInstanceId,
  type ProviderInstanceConfig,
} from "@specweave-studio/contracts";
import { afterEach, beforeEach, describe, expect, it, vi } from "vite-plus/test";
import { visitElements } from "../../test/reactElementTree";
import { reactHookHarness as hooks } from "../../test/reactHookHarness";

const state = vi.hoisted(() => ({
  prepare: vi.fn(),
  refresh: vi.fn(),
  canManage: true,
  cleanup: null as (() => void) | null,
  effectTarget: null as unknown,
}));
vi.mock("react", async (original) => {
  const actual = await original<typeof import("react")>();
  const { reactHookHarness } = await import("../../test/reactHookHarness");
  return {
    ...actual,
    useState: reactHookHarness.useState,
    useRef: reactHookHarness.useRef,
    useEffect: (effect: () => () => void, dependencies: unknown[]) => {
      if (state.effectTarget !== dependencies[0]) {
        state.cleanup?.();
        state.effectTarget = dependencies[0];
        state.cleanup = effect();
      }
    },
  };
});
vi.mock("react/compiler-runtime", async () => {
  const { reactHookHarness } = await import("../../test/reactHookHarness");
  return { c: reactHookHarness.useMemoCache };
});
vi.mock("../../state/server", () => ({
  serverEnvironment: { prepareAcpRegistryAgent: "prepare", refreshProviders: "refresh" },
}));
vi.mock("../../state/session", () => ({
  useEnvironmentScope: () => state.canManage,
  readEnvironmentScope: () => state.canManage,
}));
vi.mock("../../state/use-atom-command", () => ({
  useAtomCommand: (name: string) => (name === "prepare" ? state.prepare : state.refresh),
}));
vi.mock("@specweave-studio/client-runtime/state/runtime", () => ({
  isAtomCommandInterrupted: () => false,
  squashAtomCommandFailure: () => new Error("Registry is offline. Retry later."),
}));
vi.mock("./settingsLayout", () => ({ SettingsRow: () => null }));
import { AcpRegistryRepair, repairableAcpRegistryAgentId } from "./AcpRegistryRepair";

const environmentId = EnvironmentId.make("remote-worker");
const instanceId = ProviderInstanceId.make("copilot_work");
const instance: ProviderInstanceConfig = {
  driver: ProviderDriverKind.make("acpRegistry"),
  config: { agentId: "github-copilot-cli" },
};
function render(overrides: Partial<Parameters<typeof AcpRegistryRepair>[0]> = {}) {
  hooks.beginRender();
  return AcpRegistryRepair({
    environmentId,
    instanceId,
    instance,
    readOnly: false,
    ...overrides,
  }) as ReactElement<Record<string, unknown>>;
}
function button(tree: ReactElement<Record<string, unknown>>) {
  return visitElements(tree, (element) => typeof element.props.onClick === "function")!;
}
const flush = async () => {
  await Promise.resolve();
  await Promise.resolve();
  await Promise.resolve();
};
const click = (tree: ReactElement<Record<string, unknown>>) =>
  (button(tree).props.onClick as () => void)();

describe("AcpRegistryRepair", () => {
  beforeEach(() => {
    hooks.reset();
    state.effectTarget = null;
    state.cleanup = null;
    state.canManage = true;
    state.prepare.mockReset().mockResolvedValue({
      _tag: "Success",
      value: { agentId: "github-copilot-cli", version: "2.3.4" },
    });
    state.refresh.mockReset().mockResolvedValue({ _tag: "Success" });
  });
  afterEach(() => state.cleanup?.());

  it("only offers registry-owned official Copilot and Grok instances", () => {
    expect(repairableAcpRegistryAgentId(instance)).toBe("github-copilot-cli");
    expect(
      repairableAcpRegistryAgentId({
        ...instance,
        config: { agentId: "grok-build", source: "registry" },
      }),
    ).toBe("grok-build");
    expect(
      render({
        instance: {
          ...instance,
          config: { agentId: "github-copilot-cli", commandPath: "/custom/copilot" },
        },
      }),
    ).toBeNull();
    expect(
      repairableAcpRegistryAgentId({
        ...instance,
        config: { agentId: "github-copilot-cli", source: "local" },
      }),
    ).toBeNull();
    expect(
      repairableAcpRegistryAgentId({ ...instance, config: { agentId: "third-party-copilot" } }),
    ).toBeNull();
    expect(
      repairableAcpRegistryAgentId({ ...instance, driver: ProviderDriverKind.make("grok") }),
    ).toBeNull();
  });

  it("installs only on click and refreshes exactly the original environment and instance", async () => {
    const tree = render();
    expect(state.prepare).not.toHaveBeenCalled();
    expect(state.refresh).not.toHaveBeenCalled();
    click(tree);
    await flush();
    expect(state.prepare).toHaveBeenCalledWith({
      environmentId,
      input: { agentId: "github-copilot-cli" },
    });
    expect(state.refresh).toHaveBeenCalledWith({
      environmentId,
      input: { instanceId, refreshModels: true },
    });
    expect(JSON.stringify(render())).toContain("Agent v2.3.4 installed");
    expect(instance.config).toEqual({ agentId: "github-copilot-cli" });
  });

  it("checks readonly and the live grant and prevents duplicate submissions", async () => {
    let tree = render({ readOnly: true });
    expect(button(tree).props.disabled).toBe(true);
    click(tree);
    tree = render();
    state.canManage = false;
    click(tree);
    expect(state.prepare).not.toHaveBeenCalled();
    expect(button(render()).props.disabled).toBe(true);
    state.canManage = true;
    tree = render();
    click(tree);
    click(tree);
    expect(state.prepare).toHaveBeenCalledOnce();
    await flush();
  });

  it("does not refresh until installation succeeds and exposes installation failures", async () => {
    state.prepare.mockResolvedValueOnce({ _tag: "Failure" });
    click(render());
    expect(state.refresh).not.toHaveBeenCalled();
    await flush();
    expect(state.refresh).not.toHaveBeenCalled();
    expect(JSON.stringify(render())).toContain("Registry is offline. Retry later.");
    expect(button(render()).props.disabled).toBe(false);
  });

  it("distinguishes a completed install from a failed status refresh", async () => {
    state.refresh.mockResolvedValueOnce({ _tag: "Failure" });
    click(render());
    await flush();
    expect(JSON.stringify(render())).toContain(
      "Agent installed, but provider status could not refresh",
    );
  });

  it("ignores completion after unmount without refreshing", async () => {
    let complete!: (value: unknown) => void;
    state.prepare.mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          complete = resolve;
        }),
    );
    click(render());
    state.cleanup?.();
    complete({ _tag: "Success", value: { version: "2.0.0" } });
    await flush();
    expect(state.refresh).not.toHaveBeenCalled();
  });

  it("ignores stale environment completion and lets the new environment retry", async () => {
    let complete!: (value: unknown) => void;
    state.prepare.mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          complete = resolve;
        }),
    );
    click(render());
    const nextEnvironment = EnvironmentId.make("different-worker");
    render({ environmentId: nextEnvironment });
    complete({ _tag: "Success", value: { version: "2.0.0" } });
    await flush();
    expect(state.refresh).not.toHaveBeenCalled();
    click(render({ environmentId: nextEnvironment }));
    await flush();
    expect(state.prepare).toHaveBeenLastCalledWith({
      environmentId: nextEnvironment,
      input: { agentId: "github-copilot-cli" },
    });
    expect(state.refresh).toHaveBeenCalledOnce();
  });
});
