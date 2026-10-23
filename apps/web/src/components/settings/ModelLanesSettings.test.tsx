vi.mock("../../state/session", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../state/session")>();
  return {
    ...actual,
    useEnvironmentsWithScope: () => new Set(["mac"]),
    useEnvironmentScope: () => true,
    readEnvironmentScope: () => true,
  };
});
import {
  DEFAULT_SERVER_SETTINGS,
  ProviderDriverKind,
  ProviderInstanceId,
  type ServerProvider,
} from "@specweave-studio/contracts";
import { act, type ReactNode } from "react";
import { create, type ReactTestRenderer } from "react-test-renderer";
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
  usePrimaryEnvironment: () => ({ environmentId: "mac" }),
  usePrimaryEnvironmentId: () => null,
}));
vi.mock("../../state/server", () => ({ EMPTY_SERVER_PROVIDERS: [] }));
vi.mock("./SettingsScopeContext", () => ({
  useSettingsScope: () => ({
    scope: { kind: "project", environmentIds: ["mac"] },
    target: { environmentId: "mac" },
    targets: [],
    environments: [{ environmentId: "mac", serverConfig: { providers: state.providers } }],
    connectedEnvironments: [{ environmentId: "mac" }],
  }),
  useOptionalSettingsScope: () => ({
    scope: { kind: "project", environmentIds: ["mac"] },
    target: { environmentId: "mac" },
    targets: [],
    environments: [{ environmentId: "mac", serverConfig: { providers: state.providers } }],
    connectedEnvironments: [{ environmentId: "mac" }],
  }),
}));
vi.mock("./useScopedSettings", () => ({
  useScopedSettings: () => ({
    ...state.settings,
    favorites: [
      { provider: claude, model: "claude-opus-5-5" },
      { provider: copilot, model: "gpt-6-astra" },
    ],
  }),
  useScopedSettingsMixed: () => false,
  useUpdateScopedSettings: () => state.update,
  useClearScopedSettings: () => vi.fn(),
  useClearProjectOverrides: () => vi.fn(),
}));
vi.mock("../ui/button", () => ({
  Button: ({ children, onClick, ...props }: { children: ReactNode; onClick?: () => void; [key: string]: unknown }) => (
    <button onClick={onClick} {...props}>{children}</button>
  ),
}));
vi.mock("../chat/ProviderModelPicker", () => ({
  ProviderModelPicker: ({ triggerLabel }: { triggerLabel: string }) => <div>{triggerLabel}</div>,
}));
vi.mock("../ui/tooltip", () => ({
  Tooltip: ({ children }: any) => <>{children}</>,
  TooltipPopup: ({ children }: any) => <>{children}</>,
  TooltipTrigger: ({ children, render }: any) => render ?? <>{children}</>,
}));

import {
  addLaneModel,
  moveLaneModel,
  ModelLanesSettings,
} from "./ModelLanesSettings";

const claude = ProviderInstanceId.make("claudeAgent");
const copilot = ProviderInstanceId.make("copilot-0889");

const providerList: ServerProvider[] = [
  {
    instanceId: claude,
    driver: ProviderDriverKind.make("claudeAgent"),
    enabled: true,
    displayName: "Claude Code",
    models: [
      { slug: "claude-opus-5-5", name: "Opus 5.5" },
      { slug: "claude-sonnet-5-5", name: "Sonnet 5.5" },
      { slug: "claude-haiku-5-5", name: "Haiku 5.5" },
    ],
  } as unknown as ServerProvider,
  {
    instanceId: copilot,
    driver: ProviderDriverKind.make("copilot"),
    enabled: true,
    displayName: "GitHub Copilot",
    models: [
      { slug: "claude-opus-5.5", name: "Opus 5.5" },
      { slug: "gpt-6-astra", name: "GPT-6 Astra" },
    ],
  } as unknown as ServerProvider,
];

describe("ModelLanesSettings", () => {
  let renderer: ReactTestRenderer | null = null;

  beforeEach(() => {
    state.providers = providerList;
    state.settings = {
      ...DEFAULT_SERVER_SETTINGS,
      modelLanes: { complex: [], routine: [] },
      learnedModelPreferences: [],
    };
    state.update = vi.fn();
  });

  afterEach(() => {
    if (renderer) {
      act(() => {
        renderer?.unmount();
      });
      renderer = null;
    }
  });

  describe("addLaneModel and moveLaneModel", () => {
    it("adds model up to MAX_LANE_MODELS avoiding duplicates", () => {
      let list: any = [];
      list = addLaneModel(list, claude, "claude-opus-5-5");
      expect(list).toHaveLength(1);
      // duplicate not added
      list = addLaneModel(list, claude, "claude-opus-5-5");
      expect(list).toHaveLength(1);
      // second model added
      list = addLaneModel(list, copilot, "gpt-6-astra");
      expect(list).toHaveLength(2);
    });

    it("moves model up and down clamping boundaries", () => {
      const list: any = [
        { instanceId: claude, model: "m1" },
        { instanceId: claude, model: "m2" },
      ];
      // moving index 0 up does nothing
      expect(moveLaneModel(list, 0, -1)).toEqual(list);
      // moving index 0 down swaps
      const swapped = moveLaneModel(list, 0, 1);
      expect(swapped[0]?.model).toBe("m2");
      expect(swapped[1]?.model).toBe("m1");
    });
  });

  describe("component rendering", () => {
    it("renders empty state when no models or learned preferences are set", () => {
      act(() => {
        renderer = create(<ModelLanesSettings />);
      });
      const root = renderer!.root;
      const text = JSON.stringify(renderer!.toJSON());
      expect(text).toContain("Complex and creative lane");
      expect(text).toContain("Routine lane");
      expect(text).toContain("No models configured for this lane");
      expect(text).toContain("No learned model preferences yet");
    });

    it("renders configured lane models and learned preferences", () => {
      state.settings = {
        ...state.settings,
        modelLanes: {
          complex: [{ instanceId: claude, model: "claude-opus-5-5" }],
          routine: [{ instanceId: copilot, model: "gpt-6-astra" }],
        },
        learnedModelPreferences: [
          {
            id: "pref-1",
            keywords: ["database"],
            action: { kind: "prefer", model: { instanceId: claude, model: "claude-opus-5-5" } },
            note: "user note",
            createdAt: "2026-10-22T00:00:00.000Z",
          },
        ],
      };

      act(() => {
        renderer = create(<ModelLanesSettings />);
      });
      const root = renderer!.root;
      const text = JSON.stringify(renderer!.toJSON());
      expect(text).toContain("Claude Code · Opus 5.5");
      expect(text).toContain("GitHub Copilot · GPT-6 Astra");
      expect(text).toContain("database");
      expect(text).toContain("user note");
    });

    it("seeds favorites into complex lane when clicked", () => {
      act(() => {
        renderer = create(<ModelLanesSettings />);
      });
      const root = renderer!.root;
      const allButtons = root.findAllByType("button");
      const seedButtons = allButtons.filter((btn) => {
        const c = btn.props.children;
        return Array.isArray(c) ? c.some((child) => typeof child === "string" && child.includes("Seed from favorites")) : typeof c === "string" && c.includes("Seed from favorites");
      });
      expect(seedButtons.length).toBeGreaterThan(0);
      act(() => {
        seedButtons[0]?.props.onClick();
      });
      expect(state.update).toHaveBeenCalledWith({
        modelLanes: {
          complex: [
            { instanceId: claude, model: "claude-opus-5-5" },
            { instanceId: copilot, model: "gpt-6-astra" },
          ],
          routine: [],
        },
      });
    });

    it("deletes a learned preference when trash button is clicked", () => {
      state.settings = {
        ...state.settings,
        learnedModelPreferences: [
          {
            id: "pref-del-1",
            keywords: ["database"],
            action: { kind: "prefer", model: { instanceId: claude, model: "claude-opus-5-5" } },
            createdAt: "2026-10-22T00:00:00.000Z",
          },
        ],
      };
      act(() => {
        renderer = create(<ModelLanesSettings />);
      });
      const root = renderer!.root;
      const deleteButton = root.findByProps({ "aria-label": "Delete preference pref-del-1" });
      act(() => {
        deleteButton.props.onClick();
      });
      expect(state.update).toHaveBeenCalledWith({
        learnedModelPreferences: [],
      });
    });
  });
});
