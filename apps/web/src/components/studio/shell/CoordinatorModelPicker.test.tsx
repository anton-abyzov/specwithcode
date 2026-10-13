// @vitest-environment jsdom
import { act, type ComponentProps } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vite-plus/test";

const state = vi.hoisted(() => ({
  entries: [] as Array<Record<string, unknown>>,
  navigate: vi.fn(),
  pickerProps: null as Record<string, unknown> | null,
  options: new Map<string, Array<{ slug: string; name: string; isUnavailable?: boolean }>>(),
  serverConfig: { providers: [] } as { providers: unknown[] } | undefined,
  refresh: vi.fn(),
  canRefresh: true,
  refreshCommand: Symbol("refreshProviders"),
}));

vi.mock("@tanstack/react-router", () => ({ useNavigate: () => state.navigate }));

vi.mock("../../../hooks/useSettings", () => ({ useEnvironmentSettings: () => ({}) }));
vi.mock("../../../state/environments", () => ({
  useEnvironment: () => ({ serverConfig: state.serverConfig }),
}));
vi.mock("../../../state/server", () => ({
  serverEnvironment: { refreshProviders: state.refreshCommand },
}));
vi.mock("../../../state/session", () => ({
  useEnvironmentScope: () => state.canRefresh,
  readEnvironmentScope: () => state.canRefresh,
}));
vi.mock("../../../state/use-atom-command", () => ({
  useAtomCommand: (command: unknown) => {
    if (command !== state.refreshCommand) throw new Error("Only a provider refresh is allowed");
    return state.refresh;
  },
}));
vi.mock("../../../modelSelection", () => ({
  getCustomModelOptionsByInstance: () => state.options,
}));
vi.mock("../../../providerInstances", () => ({
  deriveProviderInstanceEntries: () => state.entries,
  isProviderInstancePickerReady: (entry: {
    enabled: boolean;
    isAvailable: boolean;
    status: string;
  }) => entry.enabled && entry.isAvailable && entry.status === "ready",
  applyProviderInstanceSettings: (entries: unknown) => entries,
  sortProviderInstanceEntries: (entries: unknown) => entries,
}));
vi.mock("../../chat/ProviderModelPicker", () => ({
  ProviderModelPicker: (props: {
    triggerLabel: string;
    triggerAriaLabel: string;
    activeInstanceId: string;
    onInstanceModelChange: (id: string, model: string) => void;
  }) => {
    state.pickerProps = props;
    return (
      <button
        type="button"
        aria-label={props.triggerAriaLabel}
        data-instance={props.activeInstanceId}
        onClick={() => props.onInstanceModelChange("codex", "gpt-6")}
      >
        {props.triggerLabel}
      </button>
    );
  },
}));
vi.mock("../../chat/TraitsPicker", () => ({ TraitsPicker: () => null }));
vi.mock("./ModelBadge", () => ({ ModelBadge: () => null, ModelBadgeMark: () => null }));

import { CoordinatorModelPicker } from "./CoordinatorModelPicker";
import { MODELS_LOADING_LIMIT_MS } from "./useCoordinatorModelsLoading";

const entry = (instanceId: string, isAvailable: boolean, status = "ready") => ({
  instanceId,
  driverKind: instanceId,
  displayName: instanceId,
  enabled: true,
  isAvailable,
  status,
  models: [],
});

let container: HTMLDivElement;
let root: Root;

async function mount(
  disabled = false,
  overrides: Partial<ComponentProps<typeof CoordinatorModelPicker>> = {},
) {
  const onChange = vi.fn();
  const onOpenSettings = vi.fn();
  await act(async () =>
    root.render(
      <CoordinatorModelPicker
        environmentId={"env" as never}
        value={null}
        disabled={disabled}
        saving={false}
        onChange={onChange}
        onOpenSettings={onOpenSettings}
        {...overrides}
      />,
    ),
  );
  return { onChange, onOpenSettings };
}

const button = (label: string) =>
  [...container.querySelectorAll("button")].find(
    (candidate) => (candidate.getAttribute("aria-label") ?? candidate.textContent) === label,
  ) ?? null;

beforeEach(() => {
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
  state.navigate.mockReset();
  state.refresh.mockReset().mockResolvedValue({ _tag: "Success" });
  state.canRefresh = true;
  state.pickerProps = null;
  state.options = new Map([["codex", [{ slug: "gpt-6", name: "GPT-6" }]]]);
});

describe("CoordinatorModelPicker provider recovery", () => {
  const saved = { instanceId: "codex", model: "gpt-6" } as never;

  it("checks only the selected instance on its machine without changing the model or sending", async () => {
    state.entries = [entry("codex", false), entry("claudeAgent", true)];
    const { onChange, onOpenSettings } = await mount(false, {
      value: saved,
      environmentId: "remote-machine" as never,
    });
    expect(state.refresh).not.toHaveBeenCalled();
    expect(state.pickerProps).not.toBeNull();
    await act(async () => button("Check again")!.click());
    expect(state.refresh).toHaveBeenCalledExactlyOnceWith({
      environmentId: "remote-machine",
      input: { instanceId: "codex", refreshModels: true },
    });
    expect(onChange).not.toHaveBeenCalled();
    expect(onOpenSettings).not.toHaveBeenCalled();
    expect(state.navigate).not.toHaveBeenCalled();
  });

  it("keeps a custom instance distinct from the default provider", async () => {
    state.entries = [
      entry("codex", true),
      { ...entry("codex-work", false), driverKind: "codex" },
    ];
    await mount(false, {
      value: { instanceId: "codex-work", model: "gpt-6" } as never,
    });
    await act(async () => button("Check again")!.click());
    expect(state.refresh).toHaveBeenCalledExactlyOnceWith({
      environmentId: "env",
      input: { instanceId: "codex-work", refreshModels: true },
    });
  });

  it("allows an explicit alternate model choice while the selected provider is unavailable", async () => {
    state.entries = [entry("codex", false), entry("claudeAgent", true)];
    state.options.set("claudeAgent", [{ slug: "claude-sonnet", name: "Sonnet" }]);
    const { onChange } = await mount(false, { value: saved });
    await act(async () =>
      (state.pickerProps!.onInstanceModelChange as (id: string, model: string) => void)(
        "claudeAgent",
        "claude-sonnet",
      ),
    );
    expect(onChange).toHaveBeenCalledExactlyOnceWith({
      instanceId: "claudeAgent",
      model: "claude-sonnet",
    });
    expect(state.refresh).not.toHaveBeenCalled();
  });

  it.each([
    { entries: [] },
    { entries: [entry("codex", false)] },
    { entries: [entry("codex", true, "error")] },
  ])(
    "keeps recovery and provider setup reachable with no ready provider: $entries",
    async ({ entries }) => {
      state.entries = entries;
      const { onChange } = await mount(false, { value: saved });
      expect(button("Check again")).not.toBeNull();
      if (state.pickerProps) {
        await act(async () => (state.pickerProps!.onManageProviders as () => void)());
      } else {
        await act(async () => button("Add or manage providers")!.click());
      }
      expect(state.navigate).toHaveBeenCalledWith({
        to: "/settings/providers",
        search: expect.objectContaining({ environmentId: "env" }),
      });
      expect(onChange).not.toHaveBeenCalled();
    },
  );

  it("guards duplicate clicks before a rerender and reports pending status", async () => {
    let finish!: (value: unknown) => void;
    state.refresh.mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          finish = resolve;
        }),
    );
    state.entries = [entry("codex", false)];
    const { onChange } = await mount(false, { value: saved });
    const check = button("Check again")!;
    await act(async () => {
      check.click();
      check.click();
    });
    expect(state.refresh).toHaveBeenCalledTimes(1);
    expect(button("Checking…")!.disabled).toBe(true);
    expect(button("Checking…")!.getAttribute("aria-busy")).toBe("true");
    expect(button("Add or manage providers")!.disabled).toBe(false);
    await act(async () => finish({ _tag: "Success" }));
    expect(button("Check again")!.disabled).toBe(false);
    expect(onChange).not.toHaveBeenCalled();
  });

  it.each(["failure", "rejection"])("shows a %s and permits an explicit retry", async (kind) => {
    if (kind === "failure") state.refresh.mockResolvedValueOnce({ _tag: "Failure" });
    else state.refresh.mockRejectedValueOnce(new Error("Private transport details"));
    state.entries = [entry("codex", false)];
    await mount(false, { value: saved });
    await act(async () => button("Check again")!.click());
    expect(container.querySelector('[role="alert"]')!.textContent).toBe("Check failed");
    expect(container.textContent).not.toContain("Private transport details");
    await act(async () => button("Check again")!.click());
    expect(state.refresh).toHaveBeenCalledTimes(2);
    expect(container.querySelector('[role="alert"]')).toBeNull();
  });

  it("does not attach a previous machine's late failure to the current target", async () => {
    let finish!: (value: unknown) => void;
    state.refresh.mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          finish = resolve;
        }),
    );
    state.entries = [entry("codex", false)];
    await mount(false, { value: saved });
    await act(async () => button("Check again")!.click());
    await mount(false, { value: saved, environmentId: "other-machine" as never });
    expect(button("Check again")!.disabled).toBe(false);
    await act(async () => finish({ _tag: "Failure" }));
    expect(container.querySelector('[role="alert"]')).toBeNull();
    await act(async () => button("Check again")!.click());
    expect(state.refresh).toHaveBeenLastCalledWith({
      environmentId: "other-machine",
      input: { instanceId: "codex", refreshModels: true },
    });
  });

  it("rechecks permission at dispatch and does not show recovery without permission", async () => {
    state.entries = [entry("codex", false)];
    await mount(false, { value: saved });
    state.canRefresh = false;
    await act(async () => button("Check again")!.click());
    expect(state.refresh).not.toHaveBeenCalled();
    await mount(false, { value: saved });
    expect(button("Check again")).toBeNull();
  });

  it("does not refresh while saving, when disabled, or when the selected model is ready", async () => {
    state.entries = [entry("codex", false)];
    await mount(false, { value: saved, saving: true });
    expect(button("Check again")!.disabled).toBe(true);
    await act(async () => button("Check again")!.click());
    await mount(true, { value: saved });
    expect(button("Check again")).toBeNull();
    state.entries = [entry("codex", true)];
    await mount(false, { value: saved });
    expect(button("Check again")).toBeNull();
    expect(state.refresh).not.toHaveBeenCalled();
  });
});
afterEach(async () => {
  await act(async () => root.unmount());
  container.remove();
  state.entries = [];
  state.serverConfig = { providers: [] };
});

describe("CoordinatorModelPicker with no saved model", () => {
  it("picks a model in place when the host has one to offer", async () => {
    state.entries = [entry("claudeAgent", false), entry("codex", true)];
    const { onChange, onOpenSettings } = await mount();
    const trigger = button("Choose model for the coordinator")!;
    // The spoken name starts with the words on the control.
    expect(trigger.textContent).toBe("Choose model");
    expect(trigger.getAttribute("data-instance")).toBe("codex");
    await act(async () => trigger.click());
    expect(onChange).toHaveBeenCalledWith({ instanceId: "codex", model: "gpt-6" });
    expect(onOpenSettings).not.toHaveBeenCalled();
  });

  it("opens on a provider that is ready to list models", async () => {
    state.entries = [entry("codex", true, "warning"), entry("claudeAgent", true)];
    await mount();
    expect(button("Choose model for the coordinator")!.getAttribute("data-instance")).toBe(
      "claudeAgent",
    );
  });

  it("sends people to the settings when no provider can list models yet", async () => {
    // Enabled and installed, but not signed in: the list would open empty.
    state.entries = [entry("codex", true, "warning")];
    const { onOpenSettings } = await mount();
    expect(container.querySelector("[data-instance]")).toBeNull();
    await act(async () => button("Choose model for the coordinator")!.click());
    expect(state.navigate).toHaveBeenCalledWith({
      to: "/settings/providers",
      search: { environmentId: "env" },
    });
    expect(onOpenSettings).not.toHaveBeenCalled();
  });

  it("sends people to the settings when nothing can be listed here", async () => {
    state.entries = [entry("codex", false)];
    const { onChange, onOpenSettings } = await mount();
    await act(async () => button("Choose model for the coordinator")!.click());
    expect(state.navigate).toHaveBeenCalledWith({
      to: "/settings/providers",
      search: { environmentId: "env" },
    });
    expect(onOpenSettings).not.toHaveBeenCalled();
    expect(onChange).not.toHaveBeenCalled();
  });

  it("does not offer a choice it cannot save", async () => {
    state.entries = [entry("codex", true)];
    const { onOpenSettings } = await mount(true);
    expect(container.querySelector("[data-instance]")).toBeNull();
    await act(async () => button("Choose model for the coordinator")!.click());
    expect(button("Choose model for the coordinator")!.disabled).toBe(true);
    expect(state.navigate).not.toHaveBeenCalled();
    expect(onOpenSettings).not.toHaveBeenCalled();
  });
});

describe("CoordinatorModelPicker while the host's providers load", () => {
  it("says models are loading instead of asking for a choice", async () => {
    state.serverConfig = undefined;
    const { onOpenSettings } = await mount();
    expect(container.textContent).toBe("Loading models for the coordinator");
    expect(container.querySelector("[role=status]")).not.toBeNull();
    expect(button("Choose model for the coordinator")).toBeNull();
    expect(container.textContent).not.toContain("Choose");
    expect(onOpenSettings).not.toHaveBeenCalled();
  });

  /** What the host sends right after a restart, before Claude's first check. */
  const placeholder = {
    instanceId: "claudeAgent",
    driver: "claudeAgent",
    enabled: true,
    installed: false,
    version: null,
    status: "warning",
    auth: { status: "unknown" },
    models: [],
  };

  it("keeps saying models are loading while a provider awaits its first check", async () => {
    state.serverConfig = { providers: [placeholder] };
    state.entries = [entry("codex", true)];
    await mount();
    expect(container.textContent).toBe("Loading models for the coordinator");
    expect(button("Choose model for the coordinator")).toBeNull();
  });

  it("offers the choice once a provider that never reports has been waited out", async () => {
    vi.useFakeTimers();
    try {
      state.serverConfig = { providers: [placeholder] };
      state.entries = [entry("codex", true)];
      await mount();
      expect(container.textContent).toBe("Loading models for the coordinator");
      await act(async () => {
        vi.advanceTimersByTime(MODELS_LOADING_LIMIT_MS);
      });
      expect(button("Choose model for the coordinator")).not.toBeNull();
    } finally {
      vi.useRealTimers();
    }
  });
});

describe("CoordinatorModelPicker provider setup", () => {
  const saved = { instanceId: "codex", model: "gpt-6" } as never;
  const callPicker = (callback: string, ...args: unknown[]) =>
    (state.pickerProps![callback] as (...values: unknown[]) => void)(...args);

  it.each([null, saved])(
    "opens the same machine's provider list with saved selection %j",
    async (value) => {
      state.entries = [entry("codex", true)];
      const { onChange, onOpenSettings } = await mount(false, { value });
      await act(async () => callPicker("onManageProviders"));
      expect(state.navigate).toHaveBeenCalledWith({
        to: "/settings/providers",
        search: { environmentId: "env" },
      });
      expect(onChange).not.toHaveBeenCalled();
      expect(onOpenSettings).not.toHaveBeenCalled();
    },
  );

  it("routes an unavailable provider's repair action to that exact instance", async () => {
    state.entries = [entry("codex", true), entry("copilot", true, "warning")];
    await mount(false, { value: saved });
    await act(async () => callPicker("onOpenProviderSetup", "copilot"));
    expect(state.navigate).toHaveBeenCalledWith({
      to: "/settings/providers",
      search: { environmentId: "env", instanceId: "copilot" },
    });
  });

  it.each([false, true])(
    "keeps setup reachable when the saved instance is gone: %s",
    async (missing) => {
      state.entries = missing ? [] : [entry("codex", false)];
      const { onChange } = await mount(false, { value: saved });
      expect(container.querySelector('[role="img"]')?.getAttribute("aria-label")).toContain(
        "Coordinator model:",
      );
      await act(async () => button("Add or manage providers")!.click());
      expect(state.navigate).toHaveBeenCalledWith({
        to: "/settings/providers",
        search: { environmentId: "env", ...(missing ? {} : { instanceId: "codex" }) },
      });
      expect(onChange).not.toHaveBeenCalled();
    },
  );

  it.each([null, saved])(
    "rejects unavailable and stale model selections with saved selection %j",
    async (value) => {
      state.entries = [entry("codex", true), entry("copilot", true, "warning")];
      state.options.set("copilot", [{ slug: "default", name: "Default" }]);
      state.options.set("codex", [
        { slug: "gpt-6", name: "GPT-6" },
        { slug: "removed", name: "Removed", isUnavailable: true },
      ]);
      const { onChange } = await mount(false, { value });
      await act(async () => {
        callPicker("onInstanceModelChange", "copilot", "default");
        callPicker("onInstanceModelChange", "codex", "removed");
        callPicker("onInstanceModelChange", "codex", "not-in-catalog");
        callPicker("onInstanceModelChange", "missing", "default");
      });
      expect(onChange).not.toHaveBeenCalled();
    },
  );

  it("blocks setup and model actions while saving", async () => {
    state.entries = [entry("codex", true)];
    const { onChange } = await mount(false, { saving: true });
    await act(async () => {
      callPicker("onManageProviders");
      callPicker("onOpenProviderSetup", "codex");
      callPicker("onInstanceModelChange", "codex", "gpt-6");
    });
    expect(state.navigate).not.toHaveBeenCalled();
    expect(onChange).not.toHaveBeenCalled();
  });

  it("keeps unavailable-provider recovery disabled while saving and absent without permission", async () => {
    state.entries = [];
    await mount(false, { value: saved, saving: true });
    expect(button("Add or manage providers")!.disabled).toBe(true);
    await mount(true, { value: saved });
    expect(button("Add or manage providers")).toBeNull();
    expect(state.navigate).not.toHaveBeenCalled();
  });
});
