import {
  DEFAULT_SERVER_SETTINGS,
  ProjectId,
  ProviderDriverKind,
  ProviderInstanceId,
  type ServerProvider,
} from "@specweave-studio/contracts";
import { resolveProjectSettings } from "@specweave-studio/shared/projectSettings";
import { act, type ReactNode } from "react";
import { create, type ReactTestInstance, type ReactTestRenderer } from "react-test-renderer";
import { afterEach, beforeEach, describe, expect, it, vi } from "vite-plus/test";

const state = vi.hoisted(() => ({
  settings: {} as typeof DEFAULT_SERVER_SETTINGS,
  update: vi.fn(),
  refresh: vi.fn(() => Promise.resolve()),
  providers: [] as unknown[],
  projectModel: null as { instanceId: string; model: string } | null,
}));
vi.mock("../../state/environments", () => ({
  useEnvironments: () => ({
    environments: [{ environmentId: "mac", serverConfig: { providers: state.providers, settings: state.settings } }],
  }),
}));
vi.mock("../../state/server", () => ({
  EMPTY_SERVER_PROVIDERS: [],
  serverEnvironment: { refreshProviders: {} },
}));
vi.mock("../../state/use-atom-command", () => ({ useAtomCommand: () => state.refresh }));
vi.mock("./SettingsScopeContext", () => ({
  useSettingsScope: () => state.projectModel
    ? {
        scope: { kind: "project", members: [{ id: "project", environmentId: "mac", defaultModelSelection: state.projectModel }] },
        target: { environmentId: "mac", projectId: "project" },
      }
    : { scope: { kind: "environment" }, target: { environmentId: "mac" } },
}));
vi.mock("./useScopedSettings", () => ({
  useScopedSettings: () => state.settings,
  useScopedSettingsMixed: () => false,
  useUpdateScopedSettings: () => state.update,
}));
vi.mock("./settingsLayout", () => ({
  PolicyTooltip: () => null,
  SETTINGS_PICKER_TRIGGER_CLASSNAME: "",
  useRelativeTimeTick: () => Date.now(),
}));
vi.mock("../chat/ProviderModelPicker", () => ({ ProviderModelPicker: () => null }));
vi.mock("../ui/switch", () => ({ Switch: () => null }));
vi.mock("../ui/badge", () => ({
  Badge: ({ children }: { children?: ReactNode }) => <span data-badge>{children}</span>,
}));
vi.mock("../ui/button", () => ({
  Button: ({ children, ...props }: { children?: ReactNode; "aria-label"?: string }) => (
    <button aria-label={props["aria-label"]}>{children}</button>
  ),
}));

import { ModelTracksSettings } from "./ModelTracksSettings";

const now = Date.now();
const iso = (ms: number) => new Date(ms).toISOString();
function provider(
  id: string,
  driver: string,
  name: string,
  models: ReadonlyArray<string>,
  usage: { readonly readAt: number } | null,
): ServerProvider {
  return {
    instanceId: ProviderInstanceId.make(id),
    driver: ProviderDriverKind.make(driver),
    displayName: name,
    enabled: true,
    installed: true,
    status: "ready",
    auth: { status: "authenticated" },
    checkedAt: iso(now),
    version: null,
    models: models.map((slug) => ({ slug, name: slug, isCustom: false, capabilities: null })),
    slashCommands: [],
    skills: [],
    ...(usage === null
      ? {}
      : {
          usageLimits: {
            checkedAt: iso(usage.readAt),
            windows: [
              {
                id: "seven_day",
                kind: "weekly" as const,
                label: "Weekly",
                usedPercent: 20,
                resetsAt: iso(now + 86_400_000),
              },
            ],
          },
        }),
  } as ServerProvider;
}

const claude = provider(
  "claudeAgent",
  "claudeAgent",
  "Claude Code",
  ["claude-opus-5-5", "claude-fable-5-2"],
  // Read twelve minutes ago: too old for a review to count on.
  { readAt: now - 12 * 60_000 },
);
const muse = provider("muse", "muse", "Muse Code", ["muse-wonder-full-1.0"], { readAt: now });
const codex = provider("codex", "codex", "Codex", ["gpt-6.1-sol"], { readAt: now });
const sel = (instanceId: string, model: string) => ({
  instanceId: ProviderInstanceId.make(instanceId),
  model,
});

let renderer: ReactTestRenderer | undefined;
const textOf = (node: ReactTestInstance | string): string =>
  typeof node === "string" ? node : node.children.map(textOf).join("");
const text = () => textOf(renderer!.root);
const sections = (id: string) =>
  renderer!.root.findAll((node) => node.type === "section" && node.props.id === id);

beforeEach(() => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  const base = resolveProjectSettings(
    DEFAULT_SERVER_SETTINGS,
    ProjectId.make("p"),
    null,
    null,
  ).settings;
  state.settings = {
    ...base,
    modelLanes: {
      routine: [sel("claudeAgent", "claude-opus-5-5")],
      complex: [sel("claudeAgent", "claude-fable-5-2")],
    },
    adversarialReview: {
      autoOnFeatureComplete: false,
      tier: "regular",
      reviewers: [
        sel("claudeAgent", "claude-opus-5-5"),
        sel("muse", "muse-wonder-full-1.0"),
        sel("codex", "gpt-6.1-sol"),
      ],
    },
  } as typeof DEFAULT_SERVER_SETTINGS;
  state.providers = [claude, muse, codex];
  state.projectModel = null;
  state.update.mockReset();
  state.refresh.mockClear();
});
afterEach(() => {
  act(() => renderer?.unmount());
  renderer = undefined;
  vi.unstubAllGlobals();
});

describe("ModelTracksSettings Review card", () => {
  it("marks Claude rows skipped for Claude work and says who reviews it", () => {
    act(() => {
      renderer = create(<ModelTracksSettings tracks={["review"]} />);
    });
    const badges = renderer!.root
      .findAll((node) => node.props["data-badge"] !== undefined)
      .map((node) => textOf(node));
    expect(badges).toContain("Claude family");
    expect(badges).toContain("Skipped for Claude work");
    expect(badges.filter((label) => label === "Skipped for Claude work")).toHaveLength(1);
    // The top row is Claude's own family here, so it does not also read "Reviews first".
    expect(badges).not.toContain("Reviews first");
    expect(badges).toContain("Meta family");
    const rule = renderer!.root.find((node) => node.props["data-review-rule"] !== undefined);
    const line = textOf(rule.findAllByType("li")[0]!);
    expect(line).toContain("Work by claude-opus-5-5 or claude-fable-5-2");
    expect(line).toContain("muse-wonder-full-1.0 on Muse Code");
    expect(line).toContain("claude-opus-5-5 skipped: same family");
  });

  it("previews reviews for the saved one-model project selection", () => {
    state.settings = { ...state.settings, threadModelMode: "model" };
    state.projectModel = sel("codex", "gpt-6.1-sol");
    act(() => {
      renderer = create(<ModelTracksSettings tracks={["review"]} />);
    });
    const rule = renderer!.root.find((node) => node.props["data-review-rule"] !== undefined);
    expect(textOf(rule)).toContain("Work by gpt-6.1-sol");
    expect(textOf(rule)).not.toContain("Work by claude-opus-5-5");
  });

  it("says why Claude's usage is unknown and checks it again", () => {
    act(() => {
      renderer = create(<ModelTracksSettings tracks={["review"]} />);
    });
    const note = renderer!.root.find((node) => node.props["data-usage-unknown"] !== undefined);
    expect(note.props["data-usage-unknown"]).toBe("stale");
    expect(text()).toContain("Usage unknown");
    expect(textOf(note)).toContain("last usage reading 12 min ago");
    act(() => note.findByType("button").props.onClick());
    expect(state.refresh).toHaveBeenCalledWith({
      environmentId: "mac",
      input: { instanceId: "claudeAgent", fresh: true },
    });
  });

  it("says a source whose usage was never read still reviews in its place", () => {
    // Muse answers no usage percent at all; the saved order keeps it first.
    const unread = {
      ...muse,
      usageLimits: {
        checkedAt: iso(now),
        windows: [],
        unavailable: { reason: "unsupported" as const },
      },
    } as ServerProvider;
    state.providers = [claude, unread, codex];
    act(() => {
      renderer = create(<ModelTracksSettings tracks={["review"]} />);
    });
    const notes = renderer!.root.findAll((node) => node.props["data-usage-unknown"] !== undefined);
    const note = notes.find((node) => node.props["data-usage-unknown"] === "cannot-report")!;
    expect(textOf(note)).toContain("Usage unknown on Muse Code");
    expect(textOf(note)).toContain("A review still uses it in this place.");
    expect(textOf(note)).not.toContain("tries a ready model below");
    const rule = renderer!.root.find((node) => node.props["data-review-rule"] !== undefined);
    expect(textOf(rule.findAllByType("li")[0]!)).toContain("muse-wonder-full-1.0 on Muse Code");
    // A stale reading still yields, and says so.
    const stale = notes.find((node) => node.props["data-usage-unknown"] === "stale")!;
    expect(textOf(stale)).toContain("A review tries a ready model below first.");
  });

  it("marks the top row Reviews first when it can review the work done here", () => {
    state.settings = {
      ...state.settings,
      adversarialReview: {
        ...state.settings.adversarialReview,
        reviewers: [sel("muse", "muse-wonder-full-1.0"), sel("codex", "gpt-6.1-sol")],
      },
    } as typeof DEFAULT_SERVER_SETTINGS;
    act(() => {
      renderer = create(<ModelTracksSettings tracks={["review"]} />);
    });
    const badges = renderer!.root
      .findAll((node) => node.props["data-badge"] !== undefined)
      .map((node) => textOf(node));
    expect(badges.filter((label) => label === "Reviews first")).toHaveLength(1);
  });

  it("shows only Review, without Sources, when asked", () => {
    act(() => {
      renderer = create(<ModelTracksSettings tracks={["review"]} />);
    });
    expect(sections("model-sources")).toHaveLength(0);
    expect(sections("model-track-daily")).toHaveLength(0);
    expect(sections("model-track-review")).toHaveLength(1);
  });
});
