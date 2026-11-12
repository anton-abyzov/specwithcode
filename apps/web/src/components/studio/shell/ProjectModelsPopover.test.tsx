// @vitest-environment jsdom
import { act, type ReactElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vite-plus/test";

const state = vi.hoisted(() => ({
  pickers: [] as Array<Record<string, unknown>>,
  effort: null as Record<string, unknown> | null,
}));

vi.mock("../../chat/ProviderModelPicker", () => ({
  ProviderModelPicker: (props: Record<string, unknown>) => {
    state.pickers.push(props);
    return <button data-picker={String(props.title)}>{String(props.model)}</button>;
  },
}));
vi.mock("../../chat/ProviderInstanceIcon", () => ({ ProviderInstanceIcon: () => null }));
vi.mock("../../chat/TraitsPicker", () => ({ useTraitsEffortControl: () => state.effort }));
vi.mock("../../../studio/machineIdentity", () => ({
  useMachineIdentities: () => (environmentId: string) => ({
    environmentId,
    name: environmentId.toUpperCase(),
    color: environmentId === "m1" ? "teal" : "violet",
    icon: "laptop",
  }),
  machineColorProps: (identity: { color: string }) => ({ "data-machine-color": identity.color }),
}));

import { ProjectModelsPopover } from "./ProjectModelsPopover";

const effortDescriptor = (ids: string[]) => ({
  id: "effort",
  label: "Effort",
  type: "select" as const,
  options: ids.map((id) => ({ id, label: id })),
});
const claude = {
  instanceId: "claudeAgent",
  driverKind: "claudeAgent",
  displayName: "Claude Code",
  enabled: true,
  isAvailable: true,
  models: [
    {
      slug: "claude-opus-5-5",
      name: "Claude Opus 5.5",
      isCustom: false,
      capabilities: {
        optionDescriptors: [
          effortDescriptor(["low", "medium", "high", "max"]),
          { id: "ultracode", label: "Ultracode", type: "boolean" as const },
        ],
      },
    },
    { slug: "claude-fable-5-2", name: "Claude Fable 5.2", isCustom: false, capabilities: null },
  ],
};
const opus = (effort: string) => ({
  instanceId: "claudeAgent",
  model: "claude-opus-5-5",
  options: [{ id: "effort", value: effort }],
});
const fable = { instanceId: "claudeAgent", model: "claude-fable-5-2" };

let container: HTMLDivElement;
let root: Root;
beforeEach(() => {
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
  state.pickers = [];
  state.effort = null;
});
afterEach(async () => {
  await act(async () => root.unmount());
  container.remove();
});

async function mount(overrides: Record<string, unknown> = {}) {
  const calls = {
    chooseCoordinator: vi.fn(),
    threadChange: vi.fn(),
    settings: vi.fn(),
    close: vi.fn(),
  };
  const props = {
    environmentId: "m4",
    entries: [claude],
    providers: [{ instanceId: "claudeAgent", models: claude.models }],
    modelOptionsByInstance: new Map(),
    coordinator: opus("medium"),
    onChooseCoordinator: calls.chooseCoordinator,
    threads: { value: null, inherited: fable, saving: false, onChange: calls.threadChange },
    machines: [{ environmentId: "m4" }, { environmentId: "m1" }],
    planModeEnabled: false,
    disabled: false,
    onOpenSettings: calls.settings,
    onClose: calls.close,
    ...overrides,
  };
  const Popover = ProjectModelsPopover as unknown as (input: typeof props) => ReactElement;
  await act(async () => root.render(<Popover {...props} />));
  return calls;
}
const row = (name: string) => container.querySelector(`[data-project-models-row="${name}"]`)!;

describe("ProjectModelsPopover", () => {
  it("shows the coordinator, new threads and the machines in one place", async () => {
    const calls = await mount();
    expect(row("coordinator").textContent).toContain("Opus 5.5");
    expect(row("coordinator").textContent).toContain("Medium effort");
    expect(row("threads").textContent).toContain("Follows the app default");
    expect(
      [...row("machines").querySelectorAll("[data-machine-chip]")].map((chip) => [
        chip.textContent,
        chip.getAttribute("data-machine-color"),
      ]),
    ).toEqual([
      ["M4", "violet"],
      ["M1", "teal"],
    ]);
    await act(async () =>
      container
        .querySelector<HTMLButtonElement>('[data-project-models-choose="coordinator"]')!
        .click(),
    );
    expect(calls.chooseCoordinator).toHaveBeenCalledOnce();
  });

  it("titles the thread picker and saves its choice on the project", async () => {
    const calls = await mount();
    expect(state.pickers.at(-1)).toMatchObject({
      title: "Model for new threads",
      model: "claude-fable-5-2",
    });
    await act(async () =>
      (state.pickers.at(-1)!.onInstanceModelChange as (id: string, model: string) => void)(
        "claudeAgent",
        "claude-opus-5-5",
      ),
    );
    expect(calls.threadChange).toHaveBeenCalledExactlyOnceWith({
      instanceId: "claudeAgent",
      model: "claude-opus-5-5",
    });
  });

  it("offers Use default only while the project overrides the app default", async () => {
    await mount();
    expect(container.querySelector("[data-project-models-use-default]")).toBeNull();
    const calls = await mount({
      threads: { value: opus("high"), inherited: fable, saving: false, onChange: vi.fn() },
    });
    void calls;
    const onChange = vi.fn();
    await mount({ threads: { value: opus("high"), inherited: fable, saving: false, onChange } });
    await act(async () =>
      container.querySelector<HTMLButtonElement>("[data-project-models-use-default]")!.click(),
    );
    expect(onChange).toHaveBeenCalledExactlyOnceWith(null);
  });

  it("sets effort, Fast and Ultracode for new threads when the model offers them", async () => {
    const select = vi.fn();
    const toggle = vi.fn();
    state.effort = {
      options: [
        { id: "low", label: "low" },
        { id: "high", label: "high" },
        { id: "max", label: "max" },
      ],
      value: "high",
      locked: null,
      select,
      fast: { on: false, toggle },
    };
    const onChange = vi.fn();
    await mount({ threads: { value: opus("high"), inherited: null, saving: false, onChange } });
    const radios = [...row("effort").querySelectorAll('[role="radio"]')];
    expect(radios.map((radio) => [radio.textContent, radio.getAttribute("aria-checked")])).toEqual([
      ["Low", "false"],
      ["High", "true"],
      ["Max", "false"],
    ]);
    await act(async () => (radios[2] as HTMLButtonElement).click());
    expect(select).toHaveBeenCalledWith("max");
    await act(async () =>
      row("effort").querySelector<HTMLButtonElement>("[data-project-models-fast]")!.click(),
    );
    expect(toggle).toHaveBeenCalledOnce();
    await act(async () =>
      row("effort").querySelector<HTMLButtonElement>("[data-project-models-ultracode]")!.click(),
    );
    expect(onChange).toHaveBeenCalledExactlyOnceWith({
      instanceId: "claudeAgent",
      model: "claude-opus-5-5",
      options: [
        { id: "effort", value: "high" },
        { id: "ultracode", value: true },
      ],
    });
  });

  it("says once that a saved coordinator effort above High is capped", async () => {
    await mount({ coordinator: opus("max") });
    const notes = container.querySelectorAll("[data-coordinator-effort-note]");
    expect(notes).toHaveLength(1);
    expect(notes[0]!.textContent).toBe("Coordinator effort is capped at High.");
  });

  it("opens Project settings after closing itself", async () => {
    const calls = await mount();
    await act(async () =>
      container.querySelector<HTMLButtonElement>("[data-project-models-settings]")!.click(),
    );
    expect(calls.close).toHaveBeenCalledBefore(calls.settings);
  });
});
