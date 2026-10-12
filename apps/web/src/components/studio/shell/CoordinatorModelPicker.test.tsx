// @vitest-environment jsdom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vite-plus/test";

const state = vi.hoisted(() => ({
  entries: [] as Array<Record<string, unknown>>,
  serverConfig: { providers: [] } as { providers: unknown[] } | undefined,
}));

vi.mock("../../../hooks/useSettings", () => ({ useEnvironmentSettings: () => ({}) }));
vi.mock("../../../state/environments", () => ({
  useEnvironment: () => ({ serverConfig: state.serverConfig }),
}));
vi.mock("../../../modelSelection", () => ({
  getCustomModelOptionsByInstance: () => new Map(),
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
  }) => (
    <button
      type="button"
      aria-label={props.triggerAriaLabel}
      data-instance={props.activeInstanceId}
      onClick={() => props.onInstanceModelChange("codex", "gpt-6")}
    >
      {props.triggerLabel}
    </button>
  ),
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

async function mount(disabled = false) {
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
    expect(onOpenSettings).toHaveBeenCalledTimes(1);
  });

  it("sends people to the settings when nothing can be listed here", async () => {
    state.entries = [entry("codex", false)];
    const { onChange, onOpenSettings } = await mount();
    await act(async () => button("Choose model for the coordinator")!.click());
    expect(onOpenSettings).toHaveBeenCalledTimes(1);
    expect(onChange).not.toHaveBeenCalled();
  });

  it("does not offer a choice it cannot save", async () => {
    state.entries = [entry("codex", true)];
    const { onOpenSettings } = await mount(true);
    expect(container.querySelector("[data-instance]")).toBeNull();
    await act(async () => button("Choose model for the coordinator")!.click());
    expect(onOpenSettings).toHaveBeenCalledTimes(1);
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
