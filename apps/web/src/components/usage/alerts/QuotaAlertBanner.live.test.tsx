import {
  EnvironmentId,
  ProviderInstanceId,
  type ServerProvider,
} from "@specweave-studio/contracts";
import { act } from "react";
import { create, type ReactTestRenderer } from "react-test-renderer";
import { afterEach, beforeEach, describe, expect, it, vi } from "vite-plus/test";

const HOUR = 3_600_000;
const NOW = Date.parse("2026-11-14T20:00:00.000Z");
const ENV_M4 = EnvironmentId.make("env-m4");

interface MockSettings {
  quotaAlertsEnabled: boolean;
  subscriptionRenewalDays: Record<string, number>;
  quotaAlertDismissals: Record<string, number>;
  quotaBoosts: Record<
    string,
    {
      accountKey: string;
      label?: string;
      instanceId: ProviderInstanceId;
      model: string;
      until: number;
      windowId: string;
      resetsAtStart: number;
      startedAt: number;
      projectIds: string[];
    }
  >;
  modelTiers: undefined;
  modelLanes: {
    routine: Array<{ instanceId: ProviderInstanceId; model: string }>;
    complex: Array<{ instanceId: ProviderInstanceId; model: string }>;
  } | null;
  adversarialReview: {
    reviewers: Array<{ instanceId: ProviderInstanceId; model: string }>;
  } | null;
  defaultModelProviders: ProviderInstanceId[] | null;
  threadModelMode: "tracks" | "model";
  defaultModelSelection: { instanceId: ProviderInstanceId; model: string } | null;
  subscriptionTargets: Record<string, number>;
}

const state = vi.hoisted(() => ({
  presentations: new Map<EnvironmentId, unknown>(),
  settingsAvailable: true,
  settings: {
    quotaAlertsEnabled: true,
    subscriptionRenewalDays: {},
    quotaAlertDismissals: {},
    quotaBoosts: {},
    modelTiers: undefined,
    modelLanes: null,
    adversarialReview: null,
    defaultModelProviders: null,
    threadModelMode: "tracks" as "tracks" | "model",
    defaultModelSelection: null,
    subscriptionTargets: {},
  } as MockSettings,
  announcements: [] as Array<{
    id: string;
    provider: string;
    kind: string;
    headline: string;
    publishedAt: string;
    sourceUrl: string;
    verified?: boolean;
  }>,
  notify: vi.fn(),
  updateSettings: vi.fn(),
}));

vi.mock("@effect/atom-react", () => ({
  useAtomValue: () => state.presentations,
}));
vi.mock("@tanstack/react-router", () => ({
  useNavigate: () => vi.fn(),
}));
vi.mock("../../../state/presentation", () => ({
  environmentPresentations: { presentationsAtom: null },
}));
vi.mock("../../../state/environments", () => ({
  usePrimaryEnvironmentId: () => ENV_M4,
}));
vi.mock("../../../studio/machineNickname", () => ({
  useMachineNicknames: () => () => "m4",
}));
vi.mock("../../../hooks/useSettings", () => ({
  usePrimarySettingsAvailable: () => state.settingsAvailable,
  usePrimarySettings: <T,>(selector: (settings: MockSettings) => T) => selector(state.settings),
  useUpdatePrimarySettings: () => state.updateSettings,
}));
vi.mock("../subscriptions/usageResetLedgerState", () => ({
  useUsageResetLedger: () => ({ periods: [] }),
}));
vi.mock("../subscriptions/resetAnnouncementsState", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../subscriptions/resetAnnouncementsState")>()),
  useResetAnnouncements: () => ({
    announcements: state.announcements,
    checkedAt: NOW,
    enabled: true,
  }),
}));
vi.mock("./quotaAlertNotifications", () => ({
  notifyQuotaAlert: (...args: unknown[]) => state.notify(...args),
}));

import { QuotaAlerts } from "./QuotaAlertBanner";

const makeProvider = (
  instanceId: string,
  driver: string,
  email: string,
  models: readonly string[],
  window: { leftPercent: number; resetsInHours: number; planName?: string },
): ServerProvider =>
  ({
    instanceId: ProviderInstanceId.make(instanceId),
    driver,
    provider: driver,
    enabled: true,
    installed: true,
    status: "ready",
    auth: { status: "authenticated", email, label: window.planName },
    models: models.map((slug) => ({ slug, name: slug, isCustom: false })),
    usageLimits: {
      status: "ok",
      checkedAt: new Date(NOW).toISOString(),
      windows: [
        {
          id: "secondary",
          label: "Weekly",
          usedPercent: 100 - window.leftPercent,
          resetsAt: new Date(NOW + window.resetsInHours * HOUR).toISOString(),
          windowDurationMins: 7 * 24 * 60,
        },
      ],
    },
  }) as unknown as ServerProvider;

const renderText = (renderer: ReactTestRenderer): string => {
  const walk = (node: unknown): string => {
    if (typeof node === "string" || typeof node === "number") return String(node);
    if (Array.isArray(node)) return node.map(walk).join("");
    if (node && typeof node === "object" && "children" in node) {
      return walk((node as { children: unknown }).children);
    }
    return "";
  };
  return walk(renderer.toJSON());
};

describe("LiveQuotaAlerts wiring", () => {
  let renderer: ReactTestRenderer | null = null;

  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(NOW);
    state.notify.mockReset();
    state.updateSettings.mockReset();
    state.settingsAvailable = true;
    state.announcements = [];
    state.settings = {
      quotaAlertsEnabled: true,
      subscriptionRenewalDays: {},
      quotaAlertDismissals: {},
      quotaBoosts: {},
      modelTiers: undefined,
      modelLanes: null,
      adversarialReview: null,
      defaultModelProviders: null,
      threadModelMode: "tracks",
      defaultModelSelection: null,
      subscriptionTargets: {},
    };
  });

  afterEach(() => {
    if (renderer !== null) {
      act(() => {
        renderer!.unmount();
      });
      renderer = null;
    }
    vi.useRealTimers();
  });

  const mount = (providers: ServerProvider[]) => {
    state.presentations = new Map([
      [
        ENV_M4,
        {
          entry: { target: { label: "m4" } },
          connection: { phase: "connected" },
          serverConfig: { providers },
        },
      ],
    ]);
    act(() => {
      renderer = create(<QuotaAlerts />);
    });
    return renderText(renderer!);
  };

  it("hides off-track Grok, orders Daily Claude ahead of Codex, and scopes confirmed notifications", () => {
    const claude = makeProvider(
      "claudeAgent",
      "claudeAgent",
      "me@example.com",
      ["claude-sonnet-5-5", "claude-opus-5-5"],
      { leftPercent: 60, resetsInHours: 20, planName: "Max" },
    );
    const codex = makeProvider("codex", "codex", "me@example.com", ["gpt-6.2-sol", "gpt-6-luna"], {
      leftPercent: 75,
      resetsInHours: 4,
      planName: "Pro",
    });
    const grok = makeProvider("grok", "grok", "me@example.com", ["grok-4.7"], {
      leftPercent: 85,
      resetsInHours: 2,
      planName: "SuperGrok",
    });
    state.announcements = [
      {
        id: "ann-grok",
        provider: "grok",
        kind: "full_reset",
        headline: "Grok weekly limits reset",
        publishedAt: new Date(NOW - HOUR).toISOString(),
        sourceUrl: "https://x.com/xai/status/1",
        verified: true,
      },
      {
        id: "ann-claude",
        provider: "claude",
        kind: "full_reset",
        headline: "Claude weekly limits reset",
        publishedAt: new Date(NOW - HOUR).toISOString(),
        sourceUrl: "https://x.com/claudeai/status/2",
        verified: true,
      },
    ];

    const text = mount([claude, codex, grok]);
    expect(text).not.toContain("Grok");
    const claudeIdx = text.indexOf("Claude Max");
    const codexIdx = text.indexOf("Codex Pro");
    expect(claudeIdx).toBeGreaterThanOrEqual(0);
    expect(codexIdx).toBeGreaterThanOrEqual(0);
    expect(claudeIdx).toBeLessThan(codexIdx);

    const notifiedKeys = state.notify.mock.calls.map((call) => (call[0] as { key: string }).key);
    expect(notifiedKeys).toContain("announcement|https://x.com/claudeai/status/2");
    expect(notifiedKeys).not.toContain("announcement|https://x.com/xai/status/1");
  });

  it("suppresses a track-serving subscription when subscriptionTargets keeps its planned share low", () => {
    const claude = makeProvider(
      "claudeAgent",
      "claudeAgent",
      "me@example.com",
      ["claude-sonnet-5-5"],
      { leftPercent: 85, resetsInHours: 10, planName: "Max" },
    );
    state.settings.subscriptionTargets = { "claudeAgent:me@example.com": 30 };

    const text = mount([claude]);
    expect(text).toBe("");
    expect(state.notify).not.toHaveBeenCalled();
  });

  it("keeps a running quota boost visible when quotaAlertsEnabled is false", () => {
    const codex = makeProvider("codex", "codex", "me@example.com", ["gpt-6.2-sol", "gpt-6-luna"], {
      leftPercent: 75,
      resetsInHours: 8,
      planName: "Pro",
    });
    state.settings.quotaAlertsEnabled = false;
    state.settings.quotaBoosts = {
      "codex:me@example.com": {
        accountKey: "codex:me@example.com",
        label: "Codex Pro",
        instanceId: ProviderInstanceId.make("codex"),
        model: "gpt-6-luna",
        until: NOW + 8 * HOUR,
        windowId: "secondary",
        resetsAtStart: NOW + 8 * HOUR,
        startedAt: NOW - HOUR,
        projectIds: [],
      },
    };

    const text = mount([codex]);
    expect(text).toContain("New worker threads use Codex Pro until");
    expect(text).not.toContain("of its weekly quota resets");
    expect(state.notify).not.toHaveBeenCalled();
  });
});
