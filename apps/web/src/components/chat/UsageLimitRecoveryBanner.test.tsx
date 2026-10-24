import { act, create, type ReactTestRenderer } from "react-test-renderer";
import { afterEach, beforeEach, expect, it, vi } from "vite-plus/test";
import {
  CommandId,
  ProviderDriverKind,
  ProviderInstanceId,
  RunId,
  type OrchestrationV2LimitRecovery,
  type ServerProvider,
} from "@specweave-studio/contracts";
import {
  describeFallbackOrder,
  type FallbackOrderUnavailable,
} from "@specweave-studio/shared/providerFallback";
import {
  canSelectManualFallback,
  fallbackUnavailableReason,
  formatResetIn,
  limitFallbackPairingBannerItem,
  limitPairingRoom,
  usageApproachingBannerItem,
  usageLimitRecoveryBannerItem,
} from "./UsageLimitRecoveryBanner";
vi.mock("../ui/button", () => ({ Button: "button" }));
vi.mock("../ui/checkbox", () => ({ Checkbox: "checkbox" }));
vi.mock("../ui/menu", () => ({
  Menu: "menu",
  MenuTrigger: ({ children }: { children: unknown }) => (
    <span data-trigger>{children as never}</span>
  ),
  MenuPopup: "menupopup",
  MenuItem: "menuitem",
}));
vi.mock("../settings/AddApiCreditAccountDialog", () => ({
  AddApiCreditAccountDialog: ({ open, driver }: { open: boolean; driver: string }) =>
    open ? <dialog data-driver={driver} /> : null,
}));
let renderer: ReactTestRenderer | undefined;
beforeEach(() => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  vi.stubGlobal("window", { setTimeout, clearTimeout });
});
afterEach(async () => {
  if (renderer) await act(() => renderer!.unmount());
  renderer = undefined;
  vi.unstubAllGlobals();
});
const runId = RunId.make("failed");
const future = "2099-10-15T00:00:00.000Z";
const props = {
  canCheck: true,
  runId,
  resetAt: future,
  stoppedAt: "2026-10-08T00:00:00.000Z",
  snoozedUntil: null,
  recovery: null,
};
const recovery: OrchestrationV2LimitRecovery = {
  runId,
  resetAt: future,
  autoResume: false,
  requestId: CommandId.make("choice"),
};
const button = (text: string) =>
  renderer!.root
    .findAllByType("button")
    .find((node) => node.children.join("") === text || node.props["aria-label"] === text)!;
const autoContinue = () => renderer!.root.findByType("checkbox" as never);
const rendered = (node = renderer!.root): string =>
  node.children.map((child) => (typeof child === "string" ? child : rendered(child))).join(" ");
it.each([null, "2026-10-01T00:00:00.000Z", future])(
  "checks permission even when reset is %s without enabling auto-resume",
  async (resetAt) => {
    const change = vi.fn().mockResolvedValue(undefined);
    const item = usageLimitRecoveryBannerItem({ ...props, resetAt, onChange: change });
    await act(() => {
      renderer = create(<>{item.actions}</>);
    });
    await act(async () => button("Check now").props.onClick());
    expect(change).toHaveBeenCalledWith({ runId, resetAt, checkNow: true });
    expect(autoContinue().props["aria-label"]).toBe("Auto-continue when usage is available");
    expect(autoContinue().props.disabled).toBe(false);
  },
);
it("arms and cancels explicitly, renders fresh permission without claiming a retry happened", async () => {
  const change = vi.fn().mockResolvedValue(undefined);
  const ready = {
    ...recovery,
    availability: {
      checkedAt: "2026-10-08T01:00:00.000Z",
      retryAt: "2026-10-08T01:05:00.000Z",
      threadUpdatedAt: "2026-10-08T01:00:00.000Z",
      status: "allowed" as const,
      affinity: {
        instanceId: ProviderInstanceId.make("codex"),
        continuationKey: "opaque",
        quotaPoolId: "opaque",
      },
    },
  };
  await act(() => {
    renderer = create(
      <>{usageLimitRecoveryBannerItem({ ...props, recovery: ready, onChange: change }).actions}</>,
    );
  });
  expect(renderer!.root.findByProps({ role: "status" }).children.join("")).toContain(
    "Tick Auto-continue to continue",
  );
  expect(autoContinue().props.checked).toBe(false);
  await act(async () => autoContinue().props.onCheckedChange(true));
  expect(change).toHaveBeenCalledWith({ runId, resetAt: future, autoResume: true });
  await act(() =>
    renderer!.update(
      <>
        {
          usageLimitRecoveryBannerItem({
            ...props,
            recovery: { ...ready, autoResume: true },
            onChange: change,
          }).actions
        }
      </>,
    ),
  );
  expect(autoContinue().props.checked).toBe(true);
  await act(async () => autoContinue().props.onCheckedChange(false));
  expect(change).toHaveBeenLastCalledWith({ runId, resetAt: future, autoResume: false });
});
it("shows denial and request errors while disabling duplicate checks", async () => {
  const change = vi
    .fn()
    .mockRejectedValue(new Error("Permission to edit this thread was revoked."));
  await act(() => {
    renderer = create(<>{usageLimitRecoveryBannerItem({ ...props, onChange: change }).actions}</>);
  });
  await act(async () => button("Check now").props.onClick());
  expect(renderer!.root.findByProps({ role: "alert" }).children.join("")).toContain("revoked");
  await act(() =>
    renderer!.update(
      <>
        {
          usageLimitRecoveryBannerItem({
            ...props,
            recovery: { ...recovery, checkNow: true },
            onChange: change,
          }).actions
        }
      </>,
    ),
  );
  expect(button("Check requested").props.disabled).toBe(true);
});
it("explains a disabled auto-continue when the provider gave no reset time", async () => {
  await act(() => {
    renderer = create(
      <>
        {
          usageLimitRecoveryBannerItem({
            ...props,
            canCheck: false,
            resetAt: null,
            onChange: async () => {},
          }).actions
        }
      </>,
    );
  });
  expect(autoContinue().props.disabled).toBe(true);
  expect(rendered()).toContain("did not say when this limit resets");
  expect(rendered()).not.toContain("Hand off now");
});
it("auto-continues a Claude thread at its reset when the box is ticked", async () => {
  const change = vi.fn().mockResolvedValue(undefined);
  const claude = { ...props, canCheck: false, onChange: change };
  await act(() => {
    renderer = create(<>{usageLimitRecoveryBannerItem(claude).actions}</>);
  });
  expect(autoContinue().props.checked).toBe(false);
  expect(autoContinue().props["aria-label"]).toBe("Auto-continue when the limit resets");
  expect(autoContinue().props.disabled).toBe(false);
  expect(button("Check now")).toBeUndefined();
  await act(async () => autoContinue().props.onCheckedChange(true));
  expect(change).toHaveBeenCalledWith({ runId, resetAt: future, autoResume: true });
  const armed = usageLimitRecoveryBannerItem({
    ...claude,
    recovery: { ...recovery, autoResume: true },
  });
  await act(() => renderer!.update(<>{armed.description}</>));
  expect(text()).toContain("This thread continues by itself at the reset.");
});
it("offers to continue the stopped turn with another ready provider", async () => {
  const change = vi.fn().mockResolvedValue(undefined);
  const onContinue = vi.fn().mockResolvedValue(undefined);
  const item = usageLimitRecoveryBannerItem({
    ...props,
    canCheck: false,
    resetAt: null,
    onChange: change,
    fallback: { label: "Codex", model: "GPT-6", automatic: false, onContinue },
  });
  await act(() => {
    renderer = create(<>{item.actions}</>);
  });
  // No reset time and no check: the provider switch is the only way forward.
  expect(autoContinue().props.disabled).toBe(true);
  expect(rendered()).toContain("Hand off now instead of waiting:");
  expect(rendered()).toContain("Hand it off now, or send a message after the reset.");
  await act(async () => button("Continue with Codex · GPT-6").props.onClick());
  expect(onContinue).toHaveBeenCalledOnce();
  expect(change).not.toHaveBeenCalled();
  await act(() =>
    renderer!.update(
      <>
        {
          usageLimitRecoveryBannerItem({
            ...props,
            onChange: change,
            fallback: { label: "Codex", model: "GPT-6", automatic: true, onContinue },
          }).description
        }
      </>,
    ),
  );
  expect(text()).toContain("Continuing with Codex by project rule");
});
const text = () => (renderer!.toJSON() as unknown as string[] | string).toString();
it("counts down to a close reset and says the thread waits instead of switching", async () => {
  vi.useFakeTimers({ toFake: ["Date", "setTimeout", "clearTimeout"] });
  vi.setSystemTime(Date.parse("2026-10-10T12:00:00.000Z"));
  vi.stubGlobal("window", { setTimeout, clearTimeout });
  const resetAt = "2026-10-10T12:20:00.000Z";
  const onContinue = vi.fn().mockResolvedValue(undefined);
  const item = usageLimitRecoveryBannerItem({
    ...props,
    resetAt,
    canCheck: false,
    waiting: true,
    onChange: async () => {},
    fallback: { label: "Codex", model: "GPT-6", automatic: true, onContinue },
  });
  await act(() => {
    renderer = create(<>{item.description}</>);
  });
  expect(text()).toContain("Resets in 20 min");
  expect(text()).toContain("waits and resumes here instead of switching");
  expect(text()).not.toContain("Continuing with Codex");
  for (let step = 0; step < 10; step += 1) {
    await act(async () => {
      vi.advanceTimersByTime(30_000);
    });
  }
  expect(text()).toContain("Resets in 15 min");
  vi.useRealTimers();
});
it("offers a new thread on another device", async () => {
  const onContinue = vi.fn().mockResolvedValue(undefined);
  const item = usageLimitRecoveryBannerItem({
    ...props,
    canCheck: false,
    resetAt: null,
    onChange: async () => {},
    device: { label: "MacBook M3", model: "Opus", onContinue },
  });
  await act(() => {
    renderer = create(<>{item.actions}</>);
  });
  await act(async () => button("Continue on MacBook M3").props.onClick());
  expect(onContinue).toHaveBeenCalledOnce();
});
it("disarms the source before a handoff and stops if cancellation fails", async () => {
  const onContinue = vi.fn().mockResolvedValue(undefined);
  const change = vi.fn().mockResolvedValue(undefined);
  const item = usageLimitRecoveryBannerItem({
    ...props,
    recovery: { ...recovery, autoResume: true },
    onChange: change,
    device: { label: "MacBook M3", model: "Opus", onContinue },
  });
  await act(() => {
    renderer = create(<>{item.actions}</>);
  });
  await act(async () => button("Continue on MacBook M3").props.onClick());
  expect(change).toHaveBeenCalledWith({ runId, resetAt: future, autoResume: false });
  expect(change.mock.invocationCallOrder[0]).toBeLessThan(onContinue.mock.invocationCallOrder[0]!);
  onContinue.mockClear();
  change.mockRejectedValue(new Error("Could not save recovery choice."));
  await act(async () => button("Continue on MacBook M3").props.onClick());
  expect(onContinue).not.toHaveBeenCalled();
  expect(renderer!.root.findByProps({ role: "alert" }).children.join("")).toBe(
    "Could not save recovery choice.",
  );
});
it("formats how far off a reset is", () => {
  const now = Date.parse("2026-10-10T12:00:00.000Z");
  expect(formatResetIn(now + 30_000, now)).toBe("1 min");
  expect(formatResetIn(now + 25 * 60_000, now)).toBe("25 min");
  expect(formatResetIn(now + 120 * 60_000, now)).toBe("2 h");
  expect(formatResetIn(now + 130 * 60_000, now)).toBe("2 h 10 min");
  expect(formatResetIn(now + 4 * 24 * 60 * 60_000, now)).toBe("4 days");
});
it("suggests switching before the limit under the offer rule", async () => {
  const onSwitch = vi.fn();
  const item = usageApproachingBannerItem({
    id: "approaching",
    providerLabel: "Claude",
    leftPercent: 3.6,
    resetAt: "2099-10-15T00:00:00.000Z",
    fallbackLabel: "Codex",
    onSwitch,
    onDismiss: () => {},
  });
  expect(item.title).toBe("Claude has 4% of its usage left");
  await act(() => {
    renderer = create(<>{item.actions}</>);
  });
  await act(async () => button("Switch to Codex").props.onClick());
  expect(onSwitch).toHaveBeenCalledOnce();
});
it("pairs a fallback thread with its original model and offers the way back", async () => {
  const onBack = vi.fn();
  const base = {
    id: "pairing",
    current: "Codex · GPT-6 Astra",
    original: "Claude · Claude Opus 5.5",
    resetAt: null,
    onBack,
    onDismiss: () => {},
  };
  const waiting = limitFallbackPairingBannerItem({ ...base, hasRoom: false });
  expect(waiting.title).toBe("Continuing on Codex · GPT-6 Astra");
  expect(waiting.description).toBe(
    "Claude · Claude Opus 5.5 stopped at its limit and is still limited.",
  );
  await act(() => {
    renderer = create(<>{waiting.actions}</>);
  });
  expect(button("Back to Claude · Claude Opus 5.5").props.disabled).toBe(true);
  const ready = limitFallbackPairingBannerItem({ ...base, hasRoom: true });
  expect(ready.description).toBe(
    "Claude · Claude Opus 5.5 stopped at its limit and has room again.",
  );
  await act(() => {
    renderer = create(<>{ready.actions}</>);
  });
  await act(async () => button("Back to Claude · Claude Opus 5.5").props.onClick());
  expect(onBack).toHaveBeenCalledOnce();
});
it("does not claim room for an original model that reports no usage", async () => {
  const onBack = vi.fn();
  const unknown = limitFallbackPairingBannerItem({
    id: "pairing",
    current: "Gemini CLI (Vertex AI) · Default",
    original: "Copilot managed · Claude Opus 5.5",
    resetAt: null,
    hasRoom: false,
    roomUnknown: "unreported",
    onBack,
    onDismiss: () => {},
  });
  expect(unknown.description).toBe(
    "Copilot managed · Claude Opus 5.5 stopped at its limit and reports no usage, so its room is unknown.",
  );
  await act(() => {
    renderer = create(<>{unknown.actions}</>);
  });
  const back = button("Back to Copilot managed · Claude Opus 5.5");
  expect(back.props.disabled).toBe(false);
  expect(back.props.title).toBe("Copilot managed · Claude Opus 5.5 may stop at its limit again");
  await act(async () => back.props.onClick());
  expect(onBack).toHaveBeenCalledOnce();
  const stale = limitFallbackPairingBannerItem({
    id: "pairing",
    current: "Codex · GPT-6 Astra",
    original: "Claude · Claude Opus 5.5",
    resetAt: null,
    hasRoom: false,
    roomUnknown: "stale",
    onBack,
    onDismiss: () => {},
  });
  expect(stale.description).toBe(
    "Claude · Claude Opus 5.5 stopped at its limit. Its last usage reading showed room but is out of date; switching back re-checks it.",
  );
});
it("knows a stood-in model has room only from a fresh usage reading", () => {
  const nowMs = Date.parse("2026-10-22T14:10:00.000Z");
  const fresh = "2026-10-22T14:09:00.000Z";
  const provider = (
    usage: {
      readonly usedPercent: number;
      readonly checkedAt?: string;
      readonly resetsAt?: string;
      readonly model?: string;
      readonly unavailable?: boolean;
    } | null,
    status = "ready",
  ): ServerProvider =>
    ({
      instanceId: ProviderInstanceId.make("claudeAgent"),
      driver: ProviderDriverKind.make("claudeAgent"),
      enabled: true,
      installed: true,
      status,
      auth: { status: "authenticated" },
      checkedAt: fresh,
      version: null,
      models: [
        { slug: "claude-opus-5-5", name: "Claude Opus 5.5", isCustom: false, capabilities: null },
      ],
      slashCommands: [],
      skills: [],
      ...(usage === null
        ? {}
        : {
            usageLimits: {
              checkedAt: usage.checkedAt ?? fresh,
              ...(usage.unavailable ? { unavailable: { reason: "probeFailed" } } : {}),
              windows: usage.unavailable
                ? []
                : [
                    {
                      id: "five-hour",
                      kind: "session",
                      label: "5-hour",
                      usedPercent: usage.usedPercent,
                      resetsAt: usage.resetsAt ?? "2026-10-22T18:00:00.000Z",
                      ...(usage.model === undefined ? {} : { model: usage.model }),
                    },
                  ],
            },
          }),
    }) as ServerProvider;
  const room = (target: ServerProvider | undefined) =>
    limitPairingRoom(target, nowMs, "claude-opus-5-5");
  // Copilot and other agents report no usage: the quota they hit may still hold.
  expect(room(provider(null))).toEqual({ hasRoom: false, roomUnknown: "unreported" });
  expect(room(provider({ usedPercent: 40 }))).toEqual({ hasRoom: true });
  expect(room(provider({ usedPercent: 100 }))).toEqual({ hasRoom: false });
  // A reading too old to trust, an expired window or a failed probe is not room.
  expect(room(provider({ usedPercent: 40, checkedAt: "2026-10-22T12:00:00.000Z" }))).toEqual({
    hasRoom: false,
    roomUnknown: "stale",
  });
  // An expired window or a failed probe leaves no current reading at all.
  expect(room(provider({ usedPercent: 100, resetsAt: "2026-10-22T14:00:00.000Z" }))).toEqual({
    hasRoom: false,
    roomUnknown: "unread",
  });
  expect(room(provider({ usedPercent: 0, unavailable: true }))).toEqual({
    hasRoom: false,
    roomUnknown: "unread",
  });
  expect(room(provider(null, "error"))).toEqual({ hasRoom: false });
  expect(room(undefined)).toEqual({ hasRoom: false });
  // The coordinator running on it right now is room, whatever the reading's age.
  const stale = provider({ usedPercent: 40, checkedAt: "2026-10-22T12:00:00.000Z" });
  expect(
    limitPairingRoom(stale, nowMs, "claude-opus-5-5", {
      instanceId: ProviderInstanceId.make("claudeAgent"),
    }),
  ).toEqual({ hasRoom: true });
  expect(
    limitPairingRoom(stale, nowMs, "claude-opus-5-5", {
      instanceId: ProviderInstanceId.make("codex"),
    }),
  ).toEqual({ hasRoom: false, roomUnknown: "stale" });
  expect(
    limitPairingRoom(provider(null, "error"), nowMs, "claude-opus-5-5", {
      instanceId: ProviderInstanceId.make("claudeAgent"),
    }),
  ).toEqual({ hasRoom: false });
  // A fresh reading at 100% outweighs the coordinator: the server's fallback reads it the same way.
  expect(
    limitPairingRoom(provider({ usedPercent: 100 }), nowMs, "claude-opus-5-5", {
      instanceId: ProviderInstanceId.make("claudeAgent"),
    }),
  ).toEqual({ hasRoom: false });
});
it("never says an out-of-date reading showed room when there is no reading", () => {
  const item = (roomUnknown: "stale" | "unread") =>
    limitFallbackPairingBannerItem({
      id: "pairing",
      current: "Codex",
      original: "Claude",
      resetAt: null,
      hasRoom: false,
      roomUnknown,
      onBack: vi.fn(),
      onDismiss: vi.fn(),
    }).description;
  expect(item("stale")).toContain("last usage reading showed room");
  expect(item("unread")).toBe(
    "Claude stopped at its limit and has no current usage reading, so its room is unknown.",
  );
});
it("lays its buttons out below the title instead of in a column beside it", () => {
  const item = usageLimitRecoveryBannerItem({ ...props, onChange: vi.fn() });
  expect(item.title).toBe("Usage limit reached");
  expect(item.actionsLayout).toBe("wrap-below");
});

it("exposes credit recovery independently of reset and fallback availability", async () => {
  const item = usageLimitRecoveryBannerItem({
    ...props,
    resetAt: null,
    canCheck: false,
    credits: {
      provider: { usageLimits: { credits: { hasCredits: true, balance: "39034.07" } } } as never,
      context: { allowed: false } as never,
      onContinue: vi.fn(),
    },
    onChange: vi.fn(),
  });
  expect(item.title).toBe("Included usage limit reached");
  await act(() => {
    renderer = create(<>{item.actions}</>);
  });
  expect(button("Continue using credits").props.disabled).toBe(true);
  expect(JSON.stringify(renderer!.toJSON())).toContain("39,034.07 credits reported available");
  expect(JSON.stringify(renderer!.toJSON())).toContain("Refresh Providers");
});

it("continues on an API account in one click, one button per account", async () => {
  const first = vi.fn().mockResolvedValue(undefined);
  const second = vi.fn().mockResolvedValue(undefined);
  const item = usageLimitRecoveryBannerItem({
    ...props,
    onChange: vi.fn(),
    apiCredits: {
      targets: [
        { label: "Hackathon 1", model: "Opus", onContinue: first },
        { label: "Hackathon 2", model: "Opus", onContinue: second },
      ],
      automatic: false,
      setup: null,
    },
  });
  await act(() => {
    renderer = create(<>{item.actions}</>);
  });
  expect(rendered()).toContain("billed per token to that API account");
  await act(async () => button("Continue on Hackathon 2").props.onClick());
  expect(second).toHaveBeenCalledOnce();
  expect(first).not.toHaveBeenCalled();
});

it("names a single API account plainly and offers to add another", async () => {
  const onContinue = vi.fn().mockResolvedValue(undefined);
  const item = usageLimitRecoveryBannerItem({
    ...props,
    onChange: vi.fn(),
    apiCredits: {
      targets: [{ label: "Claude API", model: "Opus", onContinue }],
      automatic: false,
      setup: { environmentId: "mac" as never, driver: "claudeAgent" },
    },
  });
  await act(() => {
    renderer = create(<>{item.actions}</>);
  });
  await act(async () => button("Continue on API credits").props.onClick());
  expect(onContinue).toHaveBeenCalledOnce();
  expect(renderer!.root.findAllByType("dialog" as never)).toHaveLength(0);
  await act(async () => button("Add another API key").props.onClick());
  expect(renderer!.root.findByType("dialog" as never).props["data-driver"]).toBe("claudeAgent");
});

it("offers to add an API key when there is none, and says when credits ran out", async () => {
  const item = usageLimitRecoveryBannerItem({
    ...props,
    onChange: vi.fn(),
    creditsExhausted: true,
    apiCredits: {
      targets: [],
      automatic: false,
      setup: { environmentId: "mac" as never, driver: "grok" },
    },
  });
  expect(item.title).toBe("API credits used up");
  await act(() => {
    renderer = create(<>{item.actions}</>);
  });
  expect(rendered()).toContain("Have API credits?");
  await act(async () => button("Add an API key").props.onClick());
  expect(renderer!.root.findByType("dialog" as never).props["data-driver"]).toBe("grok");
});

const manualFallbackProvider: ServerProvider = {
  instanceId: ProviderInstanceId.make("claudeAgent"),
  driver: ProviderDriverKind.make("claudeAgent"),
  enabled: true,
  installed: true,
  version: null,
  status: "ready",
  auth: { status: "authenticated" },
  checkedAt: "2026-10-22T12:00:00.000Z",
  models: [],
  slashCommands: [],
  skills: [],
};

it.each<[FallbackOrderUnavailable | null, boolean]>([
  [null, true],
  ["unverified", true],
  ["limited", true],
  ["full", true],
  ["per-token", true],
  ["current", false],
  ["missing", false],
  ["signed-out", false],
  ["not-ready", false],
])("manual fallback availability %s is selectable: %s", (unavailable, selectable) => {
  expect(canSelectManualFallback({ provider: manualFallbackProvider, unavailable })).toBe(
    selectable,
  );
});

it.each<Partial<ServerProvider>>([
  { enabled: false },
  { installed: false },
  { availability: "unavailable" },
  { auth: { status: "unauthenticated" } },
  { status: "disabled" },
  { status: "error" },
])("cannot select an unusable fallback even when its reason is a limit: %j", (override) => {
  for (const unavailable of ["limited", "per-token", "not-ready"] as const) {
    expect(
      canSelectManualFallback({
        provider: { ...manualFallbackProvider, status: "warning", ...override },
        unavailable,
      }),
    ).toBe(false);
  }
});

it("requires a provider snapshot and permits a runnable warning", () => {
  expect(canSelectManualFallback({ provider: undefined, unavailable: null })).toBe(false);
  expect(
    canSelectManualFallback({
      provider: { ...manualFallbackProvider, status: "warning" },
      unavailable: "limited",
    }),
  ).toBe(true);
});

it("allows a warning provider classified not-ready by the real fallback order", async () => {
  const model = "claude-opus-5-5";
  const provider: ServerProvider = {
    ...manualFallbackProvider,
    status: "warning",
    models: [{ slug: model, name: "Opus 5.5", isCustom: false, capabilities: null }],
    usageLimits: {
      checkedAt: manualFallbackProvider.checkedAt,
      windows: [
        { id: "weekly", kind: "weekly", label: "Weekly", usedPercent: 100, resetsAt: future },
      ],
    },
  };
  const [entry] = describeFallbackOrder({
    providers: [provider],
    currentInstanceId: ProviderInstanceId.make("stopped-provider"),
    rule: {
      providerLimitFallbackModelSelection: { instanceId: provider.instanceId, model },
    },
    nowMs: Date.parse(provider.checkedAt),
  });
  expect(entry?.unavailable).toBe("not-ready");
  expect(canSelectManualFallback(entry!)).toBe(true);
  const warning = fallbackUnavailableReason(
    entry!.unavailable,
    entry!.resetAt,
    canSelectManualFallback(entry!),
  );
  expect(warning).toBe("provider warning");
  const onContinue = vi.fn().mockResolvedValue(undefined);
  const item = usageLimitRecoveryBannerItem({
    ...props,
    onChange: vi.fn(),
    fallbackChoices: [
      {
        label: "Claude Code",
        model: "Opus 5.5",
        ...(warning ? { unavailable: warning } : {}),
        ...(canSelectManualFallback(entry!) ? { onContinue } : {}),
      },
    ],
  });
  await act(() => {
    renderer = create(<>{item.actions}</>);
  });
  const row = renderer!.root.findByType("menuitem" as never);
  expect(row.props.disabled).toBe(false);
  expect(rendered(row)).toContain("provider warning");
  expect(rendered(row)).not.toContain("not set up");
  expect(onContinue).not.toHaveBeenCalled();
  await act(async () => row.props.onClick());
  expect(onContinue).toHaveBeenCalledOnce();
});

it.each<FallbackOrderUnavailable>(["limited", "full", "unverified", "per-token"])(
  "deliberately continues on a %s model and keeps its warning visible",
  async (unavailable) => {
    const events: string[] = [];
    const onContinue = vi.fn(async () => {
      events.push("continue");
    });
    const onChange = vi.fn(async () => {
      events.push("disarm");
    });
    const entry = { provider: manualFallbackProvider, unavailable };
    const reason = fallbackUnavailableReason(unavailable, null);
    const item = usageLimitRecoveryBannerItem({
      ...props,
      recovery: { ...recovery, autoResume: true },
      onChange,
      fallbackChoices: [
        {
          label: "Claude Code",
          model: "Opus 5.5",
          ...(reason ? { unavailable: reason } : {}),
          ...(canSelectManualFallback(entry) ? { onContinue } : {}),
        },
      ],
    });
    await act(() => {
      renderer = create(<>{item.actions}</>);
    });
    const row = renderer!.root.findByType("menuitem" as never);
    expect(row.props.disabled).toBe(false);
    expect(rendered(row)).toContain(reason);
    expect(onContinue).not.toHaveBeenCalled();
    expect(onChange).not.toHaveBeenCalled();
    await act(async () => row.props.onClick());
    expect(onContinue).toHaveBeenCalledOnce();
    expect(onChange).toHaveBeenCalledWith({ runId, resetAt: future, autoResume: false });
    expect(events).toEqual(["disarm", "continue"]);
  },
);

it("lists the rest of the fallback order and disables missing models", async () => {
  const onContinue = vi.fn().mockResolvedValue(undefined);
  const onSol = vi.fn().mockResolvedValue(undefined);
  const item = usageLimitRecoveryBannerItem({
    ...props,
    onChange: vi.fn().mockResolvedValue(undefined),
    fallback: { label: "Codex", model: "GPT-6 Astra", automatic: false, onContinue },
    fallbackChoices: [
      { label: "Codex", model: "GPT-6.1 Sol", onContinue: onSol },
      {
        label: "Claude",
        model: "Opus 5.5",
        unavailable: "not on this machine",
      },
    ],
  });
  await act(() => {
    renderer = create(<>{item.actions}</>);
  });
  expect(button("Continue with Codex · GPT-6 Astra")).toBeDefined();
  expect(rendered()).toContain("Other models");
  const items = renderer!.root.findAllByType("menuitem" as never);
  expect(items.map((node) => rendered(node))).toEqual([
    "Codex · GPT-6.1 Sol",
    "Claude · Opus 5.5 not on this machine",
  ]);
  expect(items[1]!.props.disabled).toBe(true);
  await act(async () => items[1]!.props.onClick());
  expect(onSol).not.toHaveBeenCalled();
  expect(onContinue).not.toHaveBeenCalled();
  await act(async () => items[0]!.props.onClick());
  expect(onSol).toHaveBeenCalledOnce();
  expect(onContinue).not.toHaveBeenCalled();
});
