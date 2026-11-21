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
vi.mock("../../state/server", () => ({
  EMPTY_SERVER_PROVIDERS: [],
  serverEnvironment: { refreshProviders: {} },
}));
vi.mock("../../state/use-atom-command", () => ({ useAtomCommand: () => vi.fn() }));
vi.mock("./SettingsScopeContext", () => ({
  useSettingsScope: () => ({
    scope: { kind: "environment" },
    target: { environmentId: "mac" },
  }),
}));
vi.mock("./settingsLayout", () => ({
  PolicyTooltip: ({ children }: { children: ReactNode }) => <span>{children}</span>,
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

  it("keeps Muse off built-in tracks and starts Review with Neon and Sol", () => {
    const root = render();
    const daily = rowNames(track(root, "Daily"));
    const complex = rowNames(track(root, "Complex"));
    // Every built-in row shows, listed here or not; none of them is Muse.
    expect(daily).toEqual(["Claude Opus 5.5", "Claude Sonnet 5.5", "GPT-6.1-Sol", "GPT-6 Luna"]);
    expect(daily.some((name) => /muse/i.test(name))).toBe(false);
    expect(complex).toEqual(["Claude Fable 5.2", "GPT-6-Astra"]);
    expect(complex.some((name) => /muse/i.test(name))).toBe(false);
    const review = rowNames(track(root, "Review"));
    expect(review).toEqual(["Gemini 4 Neon", "GPT-6.1-Sol"]);
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
    // Every built-in entry is saved as it is, by its maker's name: Sonnet and
    // Luna, which nothing here lists, stay on their makers' harnesses, and the
    // Sol row keeps following the newest Sol release.
    expect(saved).toEqual([
      {
        instanceId: claude.instanceId,
        model: "claude-opus-5-5",
        options: [{ id: "effort", value: "medium" }],
      },
      { instanceId: claude.instanceId, model: "claude-sonnet-5-5" },
      {
        instanceId: codex.instanceId,
        model: "gpt-6.2-sol",
        options: [{ id: "reasoningEffort", value: "high" }],
      },
      { instanceId: codex.instanceId, model: "gpt-6-luna" },
    ]);
  });

  it("keeps an explicit thinking opt-out when saving Claude effort", () => {
    const selection = {
      instanceId: claude.instanceId,
      model: "claude-opus-5-5",
      options: [{ id: "thinking", value: false }],
    };
    state.settings = {
      ...state.settings,
      modelLanes: { routine: [selection], complex: [] },
    };
    const root = render();
    act(() => picker(root, "Claude Opus 5.5").props["data-on-change"]("high"));
    expect(state.update.mock.calls[0]![0].modelLanes.routine).toEqual([
      { ...selection, options: [...selection.options, { id: "effort", value: "high" }] },
    ]);
  });

  it("shows a built-in list saved by an effort change as it was, but that row's level", () => {
    const before = render();
    const names = rowNames(track(before, "Daily"));
    act(() => picker(before, "GPT-6.1-Sol").props["data-on-change"]("high"));
    const routine = state.update.mock.calls[0]![0].modelLanes.routine as ModelSelection[];
    act(() => renderer?.unmount());
    state.settings = { ...state.settings, modelLanes: { routine, complex: [] } };
    const after = render();
    expect(rowNames(track(after, "Daily"))).toEqual(names);
    expect(picker(after, "GPT-6.1-Sol").props["data-effort-value"]).toBe("high");
    expect(picker(after, "Claude Opus 5.5").props["data-effort-value"]).toBe("medium");
  });

  it("keeps the unlisted Neon row when Sol's effort changes", () => {
    state.providers = [claude, codex];
    const root = render();
    act(() => picker(root, "GPT-6.1-Sol", "Review").props["data-on-change"]("high"));
    const reviewers = state.update.mock.calls[0]![0].adversarialReview
      .reviewers as ModelSelection[];
    expect(reviewers.map((entry) => entry.model)).toEqual(["gemini-4-neon", "gpt-6.2-sol"]);
    expect(reviewers[0]?.options).toBeUndefined();
    expect(reviewers[1]?.options).toEqual([{ id: "reasoningEffort", value: "high" }]);
  });

  it("shows the start level read-only for a model nothing here lists", () => {
    state.providers = [claude, codex];
    const root = render();
    const [badge] = track(root, "Review").findAll(
      (node) =>
        typeof node.props["aria-label"] === "string" &&
        node.props["aria-label"].startsWith("Effort for Gemini 4 Neon:"),
    );
    expect(badge).toBeDefined();
    expect(badge!.props["aria-label"]).toContain("High");
    expect(
      root.findAll(
        (node) =>
          node.props["data-on-change"] !== undefined &&
          node.findAll((child) => child.props["aria-label"] === "Effort for Gemini 4 Neon")
            .length > 0,
      ),
    ).toHaveLength(0);
  });

  it("names the GPT-6.2 release a row runs on once a source lists it", () => {
    const codex62 = provider("codex", "codex", [
      ...codex.models.map((model) => ({ ...model })),
      { slug: "gpt-6.2-sol", name: "GPT-6.2-Sol", capabilities: CODEX_LEVELS },
      { slug: "gpt-6.2-astra", name: "GPT-6.2-Astra", capabilities: CODEX_LEVELS },
    ]);
    state.providers = [claude, codex62, muse];
    const root = render();
    expect(rowNames(track(root, "Daily"))).toContain("GPT-6.2-Sol");
    expect(rowNames(track(root, "Complex"))).toContain("GPT-6.2-Astra");
    // A saved GPT-6.1 Sol entry says which release it follows.
    state.settings = {
      ...state.settings,
      modelLanes: {
        routine: [{ instanceId: codex.instanceId, model: "gpt-6.1-sol" }],
        complex: [],
      },
    };
    act(() => renderer?.unmount());
    const saved = render();
    expect(JSON.stringify(renderer!.toJSON())).toContain("Follows newest: GPT-6.2-Sol");
  });

  it("never shows an empty effort picker for a Review entry", () => {
    // GitHub Copilot over ACP: a Mode select first, then lowercase effort levels.
    const acpLevels = {
      optionDescriptors: [
        {
          id: "mode",
          label: "Mode",
          type: "select" as const,
          options: [{ id: "agent", label: "Agent" }],
          currentValue: "agent",
        },
        {
          id: "reasoning_effort",
          label: "Reasoning Effort",
          type: "select" as const,
          options: ["low", "medium", "high"].map((id) => ({ id, label: id })),
          currentValue: "medium",
        },
      ],
    };
    const copilot = provider("acpRegistry_copilot", "acpRegistry", [
      { slug: "gpt-6.1-sol", name: "GPT-6.1-Sol", capabilities: acpLevels },
      { slug: "gemini-4-carbon", name: "Gemini 4 Carbon", capabilities: acpLevels },
    ]);
    // Codex on a ChatGPT account here does not list Sol.
    const codexWithoutSol = provider("codex", "codex", [
      { slug: "gpt-6-astra", name: "GPT-6-Astra", capabilities: CODEX_LEVELS },
    ]);
    state.providers = [claude, codexWithoutSol, copilot];
    state.settings = {
      ...state.settings,
      adversarialReview: {
        ...state.settings.adversarialReview,
        reviewers: [
          // Saved on Codex, which no longer lists it: the levels come from Copilot.
          { instanceId: codexWithoutSol.instanceId, model: "gpt-6.1-sol" },
          // A saved level Copilot lacks: shown at the nearest one it offers.
          {
            instanceId: copilot.instanceId,
            model: "gemini-4-carbon",
            options: [{ id: "reasoning_effort", value: "xhigh" }],
          },
        ],
      },
    };
    const root = render();
    const [sol, gemini] = rowNames(track(root, "Review"));
    const solPicker = picker(root, sol!, "Review");
    expect(solPicker.props["data-effort-value"]).toBe("medium");
    expect(levelIds(solPicker)).toEqual(["low", "medium", "high"]);
    expect(picker(root, gemini!, "Review").props["data-effort-value"]).toBe("high");
    // A pick saves under the entry's own source's option id (Codex), not Copilot's.
    act(() => solPicker.props["data-on-change"]("low"));
    const reviewers = state.update.mock.calls[0]![0].adversarialReview
      .reviewers as ModelSelection[];
    expect(reviewers[0]?.options).toEqual([{ id: "reasoningEffort", value: "low" }]);
  });

  it("saves a saved entry's pick under its own option id when levels come from elsewhere", () => {
    // Claude Code lists Opus without levels here; Cursor lists it with its own `reasoning` id.
    const plainClaude = provider("claudeAgent", "claudeAgent", [
      { slug: "claude-opus-5-5", name: "Claude Opus 5.5", capabilities: null },
      {
        slug: "claude-sonnet-5-5",
        name: "Claude Sonnet 5.5",
        capabilities: claude.models[0]!.capabilities,
      },
    ]);
    const cursor = provider("cursor", "cursor", [
      {
        slug: "claude-opus-5-5",
        name: "Claude Opus 5.5",
        capabilities: {
          optionDescriptors: [
            {
              id: "reasoning",
              label: "Reasoning",
              type: "select",
              options: ["low", "medium", "high"].map((id) => ({ id, label: id })),
            },
          ],
        },
      },
    ]);
    state.providers = [plainClaude, cursor, codex];
    state.settings = {
      ...state.settings,
      modelLanes: {
        routine: [{ instanceId: plainClaude.instanceId, model: "claude-opus-5-5" }],
        complex: [],
      },
    };
    const root = render();
    act(() => picker(root, "Claude Opus 5.5").props["data-on-change"]("high"));
    const saved = state.update.mock.calls[0]![0].modelLanes.routine as ModelSelection[];
    expect(saved[0]?.options).toEqual([{ id: "effort", value: "high" }]);
  });
});
