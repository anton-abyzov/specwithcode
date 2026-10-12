// @vitest-environment jsdom
import { act, type ReactNode } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vite-plus/test";

const state = vi.hoisted(() => ({
  snapshot: null as unknown,
  failed: false,
  loading: false,
  canWrite: true,
  canOperate: vi.fn(() => true),
  mutate: vi.fn(async () => undefined),
  draft: vi.fn(),
}));
vi.mock("../../studio/capacity", () => ({
  useStudioCapacity: () => ({
    snapshot: state.snapshot,
    loading: state.loading,
    failed: state.failed,
  }),
  mutateStudioCapacity: state.mutate,
  canOperateStudioCapacity: state.canOperate,
}));
vi.mock("../../state/session", () => ({ useEnvironmentScope: () => state.canWrite }));
vi.mock("../ui/select", () => ({
  Select: ({
    children,
    value,
    disabled,
    onValueChange,
  }: {
    children: ReactNode;
    value: string;
    disabled?: boolean;
    onValueChange: (value: string) => void;
  }) => (
    <select value={value} disabled={disabled} onChange={(e) => onValueChange(e.target.value)}>
      {children}
    </select>
  ),
  SelectTrigger: () => null,
  SelectValue: () => null,
  SelectPopup: ({ children }: { children: ReactNode }) => children,
  SelectItem: ({ value }: { value: string }) => <option value={value}>{value}</option>,
}));
vi.mock("@tanstack/react-router", () => ({
  Link: ({
    to,
    search,
    children,
    ...props
  }: {
    to: string;
    search?: unknown;
    children: React.ReactNode;
  }) => (
    <a href={to} {...props}>
      {children}
    </a>
  ),
}));
import { CapacityFleet, quotaDuration } from "./CapacityFleet";
import { absoluteTime } from "../../studio/overviewModel";
import { EnvironmentId, ServerConfig } from "@specweave-studio/contracts";
import { PrimaryConnectionTarget } from "@specweave-studio/client-runtime/connection";
import * as Schema from "effect/Schema";
import * as Option from "effect/Option";
import type { EnvironmentPresentation } from "../../state/environments";

let environment: EnvironmentPresentation = {
  environmentId: EnvironmentId.make("main"),
  displayUrl: "http://127.0.0.1:8420",
  relayManaged: false,
  serverConfig: null,
  entry: {
    target: new PrimaryConnectionTarget({
      environmentId: EnvironmentId.make("main"),
      label: "Main Mac",
      httpBaseUrl: "http://127.0.0.1:8420",
      wsBaseUrl: "ws://127.0.0.1:8420",
    }),
    profile: Option.none(),
    enabled: true,
  },
  label: "Main Mac",
  connection: { phase: "connected", error: null, traceId: null },
};
let config = Schema.decodeUnknownSync(ServerConfig)({
  environment: {
    environmentId: "main",
    label: "Main Mac",
    platform: { os: "darwin", arch: "arm64" },
    serverVersion: "test",
    capabilities: {},
  },
  auth: {
    policy: "loopback-browser",
    bootstrapMethods: [],
    sessionMethods: [],
    sessionCookieName: "studio-session",
  },
  cwd: "/owned-fixture",
  keybindingsConfigPath: "/owned-fixture/keybindings.json",
  keybindings: [],
  issues: [],
  availableEditors: [],
  observability: {
    logsDirectoryPath: "/owned-fixture/logs",
    localTracingEnabled: false,
    otlpTracesEnabled: false,
    otlpMetricsEnabled: false,
  },
  settings: {},
  providers: [
    {
      instanceId: "codex",
      driver: "codex",
      enabled: true,
      installed: true,
      version: "0.160.1",
      status: "ready",
      auth: { status: "authenticated" },
      checkedAt: new Date().toISOString(),
      models: [
        {
          slug: "native-model",
          name: "Native model",
          isCustom: false,
          isDefault: true,
          capabilities: null,
        },
      ],
    },
  ],
});
function fixture(status = "ready", selectedAccount: string | null = null) {
  const now = Date.now();
  return {
    schemaVersion: 1,
    available: true,
    error: null,
    observedAt: new Date(now).toISOString(),
    source: "specweave-switch",
    scope: "environment-local",
    quotaPoolIdentity: "partial",
    verifiedQuotaPoolCount: null,
    accounts: [
      {
        id: "codex-1",
        label: "Codex 1",
        provider: "codex",
        authenticated: true,
        authError: null,
        status,
        providerInstanceId: "codex",
        quotaPoolId: null,
        quotaPoolObservedAt: null,
        quota: {
          window:
            status === "unknown"
              ? null
              : { usedPercent: status === "exhausted" ? 100 : 30, resetsAt: now / 1000 + 3600 },
          weekly: null,
          observedAt: status === "unknown" ? null : new Date(now).toISOString(),
          expiresAt:
            status === "stale"
              ? new Date(now - 60000).toISOString()
              : new Date(now + 60000).toISOString(),
          source: status === "unknown" ? null : "native-app-server",
          freshness: status === "unknown" ? "unknown" : status === "stale" ? "stale" : "fresh",
        },
      },
    ],
    policy: { mode: "balanced", selectedAccount, preferredProvider: null },
    recommendations: [
      {
        provider: "any",
        id: "codex-1",
        providerInstanceId: "codex",
        reason: "Observed policy result",
      },
      {
        provider: "codex",
        id: "codex-1",
        providerInstanceId: "codex",
        reason: "Observed policy result",
      },
    ],
  };
}
let root: Root, container: HTMLDivElement;
beforeEach(() => {
  (globalThis as Record<string, unknown>).IS_REACT_ACT_ENVIRONMENT = true;
  state.snapshot = fixture();
  state.failed = false;
  state.loading = false;
  state.canWrite = true;
  state.canOperate.mockReset();
  state.canOperate.mockReturnValue(true);
  config = {
    ...config,
    providers: [{ ...config.providers[0]!, checkedAt: new Date().toISOString() }],
  };
  state.mutate.mockClear();
  state.draft.mockClear();
  environment = { ...environment, connection: { phase: "connected", error: null, traceId: null } };
  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
});
afterEach(async () => {
  await act(async () => root.unmount());
  container.remove();
  vi.useRealTimers();
});
async function render() {
  await act(async () =>
    root.render(
      <CapacityFleet
        environments={[environment]}
        configs={new Map([[environment.environmentId, config]])}
        onNewDraft={state.draft}
      />,
    ),
  );
}
async function click(text: string) {
  const b = [...container.querySelectorAll("button")].find((v) => v.textContent?.trim() === text);
  expect(b).toBeDefined();
  await act(async () => b!.click());
}
it("renders the actual failed connection phase and reason without claiming blocked or live capacity", async () => {
  environment = {
    ...environment,
    connection: { phase: "error", error: "The pairing grant was revoked.", traceId: null },
  };
  await render();
  expect(container.textContent).toContain("Connection failed");
  expect(container.textContent).toContain("The pairing grant was revoked.");
  expect(container.textContent).not.toContain("Authenticated connection");
  expect(container.textContent).not.toContain("Connection blocked");
  expect(state.mutate).not.toHaveBeenCalled();
});
it("reads capacity without refresh, policy mutation or inference on mount", async () => {
  await render();
  expect(state.mutate).not.toHaveBeenCalled();
  expect(state.draft).not.toHaveBeenCalled();
  expect(container.textContent).toContain("Independent capacity unknown");
  expect(container.textContent).toContain("30% used");
  expect(container.textContent).toContain("EDT");
});
it("refreshes observations only from its explicit action", async () => {
  await render();
  await click("Refresh observations");
  expect(state.mutate).toHaveBeenCalledWith("main", { kind: "refresh" });
});
it("changes future preference and clears a pin with a nullable selection", async () => {
  state.snapshot = fixture("ready", "codex-1");
  await render();
  await click("Return to Automatic");
  expect(state.mutate).toHaveBeenCalledWith("main", { kind: "select", input: { id: null } });
  const field = container.querySelector("select")!;
  await act(async () => {
    field.value = "reset-first";
    field.dispatchEvent(new Event("change", { bubbles: true }));
  });
  expect(state.mutate).toHaveBeenCalledWith("main", {
    kind: "policy",
    input: { mode: "reset-first" },
  });
  expect(state.draft).not.toHaveBeenCalled();
  expect(config.providers[0]?.instanceId).toBe("codex");
});
it("explains reset priority, the local next reset and retained account/cache affinity", async () => {
  const snapshot = fixture();
  snapshot.policy.mode = "reset-first";
  state.snapshot = snapshot;
  await render();
  expect(container.textContent).toContain(
    "Use eligible quota that resets soonest; equal resets prefer more used quota.",
  );
  expect(container.textContent).toContain(
    "Existing sessions keep their account and provider to preserve cache affinity.",
  );
  expect(container.textContent).toContain("Recommended: Codex 1 · next reset");
  expect(container.textContent).toMatch(/EDT|EST/);
  expect(state.mutate).not.toHaveBeenCalled();
  expect(state.draft).not.toHaveBeenCalled();
});
it("shows the earliest applicable reset even when the most used summary resets later", async () => {
  const snapshot = fixture(),
    now = Date.now(),
    soon = now / 1000 + 3600;
  snapshot.policy.mode = "reset-first";
  Object.assign(snapshot.accounts[0]!.quota, {
    window: { usedPercent: 90, resetsAt: now / 1000 + 86400 },
    windows: [
      {
        id: "codex:primary",
        bucketId: "codex",
        appliesToSelection: true,
        usedPercent: 90,
        resetsAt: now / 1000 + 86400,
      },
      {
        id: "codex:secondary",
        bucketId: "codex",
        appliesToSelection: true,
        usedPercent: 10,
        resetsAt: soon,
      },
      {
        id: "other:primary",
        bucketId: "other",
        appliesToSelection: false,
        usedPercent: 20,
        resetsAt: now / 1000 + 600,
      },
    ],
  });
  state.snapshot = snapshot;
  await render();
  expect(container.textContent).toContain(
    `Recommended: Codex 1 · next reset ${absoluteTime(soon)}`,
  );
  expect(state.draft).not.toHaveBeenCalled();
  expect(state.mutate).not.toHaveBeenCalled();
});
it("shows spend-control denial instead of claiming earlier ordinary permission allows new work", async () => {
  const snapshot = fixture("exhausted");
  Object.assign(snapshot.accounts[0]!.quota, {
    ordinaryUsageAllowed: true,
    spendControlReached: true,
  });
  state.snapshot = snapshot;
  await render();
  expect(container.textContent).toContain("Provider spend control blocks new work");
  expect(container.textContent).not.toContain("Provider allows new work");
  expect(state.draft).not.toHaveBeenCalled();
});
it("opens only an explicit policy-selected native draft and retains a final chooser validator", async () => {
  await render();
  expect(container.textContent).toContain("Capacity policy");
  expect(state.draft).not.toHaveBeenCalled();
  await click("Draft using capacity policy");
  expect(state.draft).toHaveBeenCalledWith(
    "main",
    { instanceId: "codex", model: "native-model" },
    expect.any(Function),
  );
  const validate = state.draft.mock.calls[0]?.[2] as () => boolean;
  expect(validate()).toBe(true);
  state.snapshot = fixture("exhausted");
  await render();
  expect(validate()).toBe(false);
  expect(state.mutate).not.toHaveBeenCalled();
});
it("disables a policy draft for an ineligible pin without silently choosing another account", async () => {
  state.snapshot = fixture("ready", "codex-2");
  await render();
  const button = [...container.querySelectorAll("button")].find(
    (b) => b.textContent?.trim() === "Draft using capacity policy",
  )!;
  expect(button.disabled).toBe(true);
  await click("Draft using capacity policy");
  expect(state.draft).not.toHaveBeenCalled();
});
it("rejects the cached recommendation while a successful preference mutation awaits its new read", async () => {
  await render();
  await click("Draft using capacity policy");
  const validate = state.draft.mock.calls[0]?.[2] as () => boolean;
  state.mutate.mockImplementationOnce(async () => {
    state.loading = true;
  });
  await click("Prefer");
  const button = [...container.querySelectorAll("button")].find(
    (b) => b.textContent?.trim() === "Draft using capacity policy",
  )!;
  expect(button.disabled).toBe(true);
  expect(validate()).toBe(false);
  await click("Draft using capacity policy");
  expect(state.draft).toHaveBeenCalledTimes(1);
  state.loading = false;
  state.snapshot = fixture("ready", "codex-2");
  await render();
  expect(validate()).toBe(false);
});
it("rechecks quota expiry and authoritative operating permission at the action click", async () => {
  const initial = Date.now();
  vi.useFakeTimers();
  vi.setSystemTime(initial);
  await render();
  // No render or clock tick: the previously enabled control must still recheck its data.
  vi.setSystemTime(initial + 61_000);
  await click("Draft using capacity policy");
  expect(state.draft).not.toHaveBeenCalled();
  vi.setSystemTime(initial);
  state.canOperate.mockReturnValue(false);
  await click("Draft using capacity policy");
  expect(state.draft).not.toHaveBeenCalled();
});
it("shows read-only capacity while operating controls stay disabled", async () => {
  state.canWrite = false;
  state.canOperate.mockReturnValue(false);
  await render();
  expect(container.textContent).toContain("30% used");
  expect(container.querySelector("select")?.disabled).toBe(true);
  for (const text of ["Draft using capacity policy", "Refresh observations", "Prefer"]) {
    const button = [...container.querySelectorAll("button")].find(
      (b) => b.textContent?.trim() === text,
    )!;
    expect(button.disabled).toBe(true);
  }
  expect(state.mutate).not.toHaveBeenCalled();
  expect(state.draft).not.toHaveBeenCalled();
});
it("opens an explicit mapped native draft while keeping unknown quota unavailable for preference", async () => {
  state.snapshot = fixture("unknown");
  await render();
  expect(container.textContent).toContain("Capacity unknown");
  const prefer = [...container.querySelectorAll("button")].find((b) => b.textContent === "Prefer")!;
  expect(prefer.disabled).toBe(true);
  await click("Open native draft");
  expect(state.draft).toHaveBeenCalledWith("main", { instanceId: "codex", model: "native-model" });
  expect(state.mutate).not.toHaveBeenCalled();
});
it("blocks preference and draft actions for stale/exhausted/auth-required observations", async () => {
  for (const status of ["stale", "exhausted", "auth-required"]) {
    const next = fixture(status);
    if (status === "auth-required") next.accounts[0]!.authenticated = false;
    state.snapshot = next;
    await render();
    expect(
      [...container.querySelectorAll("button")].some(
        (b) => b.textContent?.trim() === "Open native draft",
      ),
    ).toBe(false);
    expect(
      [...container.querySelectorAll("button")].find((b) => b.textContent === "Prefer")?.disabled,
    ).toBe(true);
  }
  expect(state.mutate).not.toHaveBeenCalled();
});
it("degrades a denied host capacity read independently and disables disconnected actions", async () => {
  state.failed = true;
  await render();
  expect(container.textContent).toContain("Capacity read failed or was denied");
  expect(container.textContent).not.toContain("30% used");
  environment = { ...environment, connection: { phase: "offline", error: null, traceId: null } };
  await render();
  expect(container.textContent).toContain("Reconnect this host");
  expect(
    [...container.querySelectorAll("button")].find(
      (b) => b.textContent?.trim() === "Refresh observations",
    )?.disabled,
  ).toBe(true);
});

it("labels actual quota durations without assuming every current window is five hours", () => {
  expect(quotaDuration(15)).toBe("15-minute window");
  expect(quotaDuration(60)).toBe("1-hour window");
  expect(quotaDuration(300)).toBe("5-hour window");
  expect(quotaDuration(10080)).toBe("7-day window");
  expect(quotaDuration(undefined)).toBe("Window duration unknown");
});

it("shows included usage, reported credits and banked resets as separate observations without starting work", async () => {
  const f = fixture();
  const now = Date.now();
  Object.assign(f.accounts[0]!.quota, {
    ordinaryUsageAllowed: true,
    credits: { hasCredits: true, unlimited: false, balance: "42.5" },
    resetCredits: { availableCount: 2, nextExpiresAt: new Date(now + 86400000).toISOString() },
    windows: [
      {
        id: "codex:primary",
        bucketId: "codex",
        appliesToSelection: true,
        usedPercent: 100,
        resetsAt: now / 1000 + 900,
        windowDurationMins: 15,
      },
      {
        id: "other:primary",
        bucketId: "other",
        appliesToSelection: false,
        usedPercent: 40,
        resetsAt: now / 1000 + 3600,
        windowDurationMins: 60,
      },
    ],
  });
  state.snapshot = f;
  await render();
  expect(container.textContent).toContain("15-minute window");
  expect(container.textContent).toContain("0% remaining");
  expect(container.textContent).toContain("100% used");
  expect(container.textContent).toContain("Provider allows new work");
  expect(container.textContent).toContain("42.5 extra credits reported");
  expect(container.textContent).toContain("2 banked resets");
  expect(container.textContent).toContain("Other bucket · other · 1-hour window");
  expect(container.textContent).toContain("Just now");
  expect(state.mutate).not.toHaveBeenCalled();
  expect(state.draft).not.toHaveBeenCalled();
});
it("displays unknown credits and allowance without implying extra capacity or resetting usage", async () => {
  state.snapshot = fixture("exhausted");
  await render();
  expect(container.textContent).toContain("0% remaining");
  expect(container.textContent).toContain("Extra credits unknown");
  expect(container.textContent).toContain("Banked resets unknown");
  expect(container.textContent).toContain("Provider allowance unknown");
  expect(state.mutate).not.toHaveBeenCalled();
  expect(state.draft).not.toHaveBeenCalled();
});
