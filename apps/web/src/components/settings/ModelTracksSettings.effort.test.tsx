import {
  DEFAULT_SERVER_SETTINGS,
  type ModelSelection,
  ProviderDriverKind,
  ProviderInstanceId,
  type ServerProvider,
} from "@specweave-studio/contracts";
import { act, type ReactNode } from "react";
import { create, type ReactTestInstance, type ReactTestRenderer } from "react-test-renderer";
import { afterEach, beforeEach, describe, expect, it, vi } from "vite-plus/test";

const state = vi.hoisted(() => ({
  settings: {} as typeof DEFAULT_SERVER_SETTINGS,
  update: vi.fn(),
  providers: [] as ServerProvider[],
}));

vi.mock("../../state/environments", () => ({
  useEnvironments: () => ({
    environments: [{ environmentId: "mac", serverConfig: { providers: state.providers } }],
  }),
}));
vi.mock("../../state/server", () => ({ EMPTY_SERVER_PROVIDERS: [] }));
vi.mock("./SettingsScopeContext", () => ({
  useSettingsScope: () => ({ target: { environmentId: "mac" } }),
}));
vi.mock("./settingsLayout", () => ({
  SETTINGS_PICKER_TRIGGER_CLASSNAME: "",
  useRelativeTimeTick: () => Date.parse("2026-11-18T12:00:00.000Z"),
}));
vi.mock("./useScopedSettings", () => ({
  useScopedSettings: () => state.settings,
  useScopedSettingsMixed: () => false,
  useUpdateScopedSettings: () => state.update,
}));
vi.mock("../chat/ProviderModelPicker", () => ({
  ProviderModelPicker: ({ triggerLabel }: { triggerLabel: string }) => <div>{triggerLabel}</div>,
}));
// The picker's levels and its change handler, without the popup machinery.
vi.mock("../ui/select", () => ({
  Select: ({
    children,
    value,
    onValueChange,
  }: {
    children: ReactNode;
    value: string | null;
    onValueChange: (value: string) => void;
  }) => (
    <div data-effort-value={value} data-on-change={onValueChange}>
      {children}
    </div>
  ),
  SelectTrigger: ({ children, ...props }: { children: ReactNode; "aria-label": string }) => (
    <button aria-label={props["aria-label"]}>{children}</button>
  ),
  SelectValue: ({ children }: { children: ReactNode }) => <span>{children}</span>,
  SelectPopup: ({ children }: { children: ReactNode }) => <div>{children}</div>,
  SelectItem: ({ children, value }: { children: ReactNode; value: string }) => (
    <div data-level={value}>{children}</div>
  ),
}));

import { ModelTracksSettings } from "./ModelTracksSettings";

const levels = (ids: ReadonlyArray<string>, isDefault: string) => ({
  optionDescriptors: [
    {
      id: "reasoningEffort",
      label: "Reasoning",
      type: "select" as const,
      options: ids.map((id) => ({
        id,
        label: id === "xhigh" ? "Extra High" : id.charAt(0).toUpperCase() + id.slice(1),
        ...(id === isDefault ? { isDefault: true } : {}),
      })),
    },
  ],
});
const MUSE_LEVELS = levels(["minimal", "low", "medium", "high", "xhigh", "max"], "high");
const CODEX_LEVELS = levels(["low", "medium", "high", "xhigh", "max"], "high");

function provider(
  id: string,
  driver: string,
  models: ReadonlyArray<{ slug: string; name: string; capabilities: unknown }>,
): ServerProvider {
  return {
    instanceId: ProviderInstanceId.make(id),
    driver: ProviderDriverKind.make(driver),
    displayName: id,
    enabled: true,
    installed: true,
    status: "ready",
    auth: { status: "authenticated" },
    models: models.map((model) => ({ ...model, isCustom: false })),
  } as unknown as ServerProvider;
}

const claude = provider("claudeAgent", "claudeAgent", [
  {
    slug: "claude-opus-5-5",
    name: "Claude Opus 5.5",
    capabilities: {
      optionDescriptors: [
        {
          id: "effort",
          label: "Reasoning",
          type: "select",
          options: [
            { id: "low", label: "Low" },
            { id: "medium", label: "Medium" },
            { id: "high", label: "High", isDefault: true },
            { id: "xhigh", label: "Extra High" },
          ],
        },
      ],
    },
  },
  { slug: "claude-fable-5-2", name: "Claude Fable 5.2", capabilities: null },
]);
const codex = provider("codex", "codex", [
  { slug: "gpt-6.1-sol", name: "GPT-6.1-Sol", capabilities: CODEX_LEVELS },
  { slug: "gpt-6-astra", name: "GPT-6-Astra", capabilities: CODEX_LEVELS },
]);
// Muse Code 1.4 labels each model with its bare id.
const muse = provider("muse", "muse", [
  { slug: "muse-wonder-1.0", name: "muse-wonder-1.0", capabilities: MUSE_LEVELS },
  { slug: "muse-wonder-full-1.0", name: "muse-wonder-full-1.0", capabilities: MUSE_LEVELS },
]);

const track = (root: ReactTestInstance, name: string) =>
  root.find((node) => node.type === "ol" && node.props["aria-label"] === `${name} order`);
const rowNames = (list: ReactTestInstance) =>
  list
    .findAll((node) => node.type === "li" && node.props.style !== undefined)
    .map((row) =>
      row
        .find(
          (node) =>
            node.type === "span" && String(node.props.className).includes("text-sm font-medium"),
        )
        .children.join(""),
    );
/** The effort picker on `name`'s row in `trackName` (Daily unless named). */
const picker = (root: ReactTestInstance, name: string, trackName = "Daily") =>
  track(root, trackName).find(
    (node) =>
      node.type === "div" &&
      node.props["data-on-change"] !== undefined &&
      node.findAll((child) => child.props["aria-label"] === `Effort for ${name}`).length > 0,
  );
const levelIds = (select: ReactTestInstance) =>
  select
    .findAll((node) => node.type === "div" && node.props["data-level"] !== undefined)
    .map((node) => node.props["data-level"]);

describe("ModelTracksSettings effort", () => {
  let renderer: ReactTestRenderer | null = null;
  const render = () => {
    act(() => {
      renderer = create(<ModelTracksSettings sources={false} />);
    });
    return renderer!.root;
  };

  beforeEach(() => {
    state.providers = [claude, codex, muse];
    state.settings = { ...DEFAULT_SERVER_SETTINGS, modelLanes: { routine: [], complex: [] } };
    state.update = vi.fn();
  });
  afterEach(() => {
    act(() => renderer?.unmount());
    renderer = null;
  });

  it("keeps Muse off Daily and Complex and starts Review on Muse Wonder Full at Extra High", () => {
    const root = render();
    const daily = rowNames(track(root, "Daily"));
    const complex = rowNames(track(root, "Complex"));
    // Every built-in row shows, listed here or not; none of them is Muse.
    expect(daily).toEqual(["Claude Opus 5.5", "Claude Sonnet 5.5", "GPT-6.1-Sol", "GPT-6 Luna"]);
    expect(daily.some((name) => /muse/i.test(name))).toBe(false);
    expect(complex).toEqual(["Claude Fable 5.2", "GPT-6-Astra"]);
    expect(complex.some((name) => /muse/i.test(name))).toBe(false);
    const review = rowNames(track(root, "Review"));
    expect(review[0]).toBe("Muse Wonder Full 1.0");
    expect(review[1]).toBe("Muse Wonder 1.0");
    const full = picker(root, "Muse Wonder Full 1.0", "Review");
    expect(full.props["data-effort-value"]).toBe("xhigh");
    expect(levelIds(full)).toEqual(["minimal", "low", "medium", "high", "xhigh", "max"]);
  });

  it("starts every other row at Medium from the levels its model lists", () => {
    const root = render();
    expect(picker(root, "Claude Opus 5.5").props["data-effort-value"]).toBe("medium");
    expect(picker(root, "GPT-6.1-Sol").props["data-effort-value"]).toBe("medium");
    expect(picker(root, "GPT-6.1-Sol", "Review").props["data-effort-value"]).toBe("medium");
    expect(picker(root, "GPT-6-Astra", "Complex").props["data-effort-value"]).toBe("medium");
    expect(levelIds(picker(root, "Claude Opus 5.5"))).toEqual(["low", "medium", "high", "xhigh"]);
    // Fable here lists no effort setting, so its row has no picker.
    expect(
      root.findAll((node) => node.props["aria-label"] === "Effort for Claude Fable 5.2"),
    ).toHaveLength(0);
  });

  it("shows a saved entry's effort and Medium for a saved entry without one", () => {
    state.settings = {
      ...state.settings,
      modelLanes: {
        routine: [
          {
            instanceId: codex.instanceId,
            model: "gpt-6.1-sol",
            options: [{ id: "reasoningEffort", value: "xhigh" }],
          },
          { instanceId: claude.instanceId, model: "claude-opus-5-5" },
        ],
        complex: [],
      },
    };
    const root = render();
    expect(picker(root, "GPT-6.1-Sol").props["data-effort-value"]).toBe("xhigh");
    expect(picker(root, "Claude Opus 5.5").props["data-effort-value"]).toBe("medium");
  });

  it("saves a pick in the entry's options", () => {
    const root = render();
    act(() => picker(root, "GPT-6.1-Sol").props["data-on-change"]("high"));
    expect(state.update).toHaveBeenCalledTimes(1);
    const saved = state.update.mock.calls[0]![0].modelLanes.routine as ModelSelection[];
    const sol = saved.find((entry) => entry.model === "gpt-6.1-sol");
    expect(sol?.options).toEqual([{ id: "reasoningEffort", value: "high" }]);
    // The built-in rows it saves keep the level each one showed.
    expect(saved.find((entry) => entry.model === "claude-opus-5-5")?.options).toEqual([
      { id: "effort", value: "medium" },
    ]);
  });

  it("shows the start level read-only for a model nothing here lists", () => {
    state.providers = [claude, codex];
    const root = render();
    const [badge] = track(root, "Review").findAll(
      (node) =>
        typeof node.props["aria-label"] === "string" &&
        node.props["aria-label"].startsWith("Effort for Muse Wonder Full 1.0:"),
    );
    expect(badge).toBeDefined();
    expect(badge!.props["aria-label"]).toContain("Extra High");
    expect(
      root.findAll(
        (node) =>
          node.props["data-on-change"] !== undefined &&
          node.findAll((child) => child.props["aria-label"] === "Effort for Muse Wonder Full 1.0")
            .length > 0,
      ),
    ).toHaveLength(0);
  });
});
