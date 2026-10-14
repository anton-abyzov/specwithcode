import { act, create, type ReactTestRenderer } from "react-test-renderer";
import { afterEach, beforeEach, expect, it, vi } from "vite-plus/test";
import {
  ProviderInstanceId,
  ProviderDriverKind,
  type ServerProvider,
} from "@specweave-studio/contracts";
import { type CreditSendContext } from "./explicitCreditSend";
import { CreditRecoveryAction, formatCreditBalance } from "./CreditRecoveryAction";
vi.mock("../ui/button", () => ({ Button: "button" }));
const now = Date.parse("2026-10-09T08:00:00.000Z"),
  at = new Date(now).toISOString();
const instanceId = ProviderInstanceId.make("codex-work");
const context: CreditSendContext = {
  environmentId: "m4",
  projectId: "project-m4",
  threadId: "reserved-thread",
  draftId: "draft-1",
  runtimeMode: "approval-required",
  selection: { instanceId, model: "gpt-6.1-sol" },
  allowed: true,
};
function provider(): ServerProvider {
  return {
    instanceId,
    driver: ProviderDriverKind.make("codex"),
    enabled: true,
    installed: true,
    version: "0.162.0",
    status: "warning",
    auth: { status: "authenticated", type: "chatgpt" },
    checkedAt: at,
    models: [{ slug: context.selection.model, name: "Sol", isCustom: false, capabilities: null }],
    skills: [],
    slashCommands: [],
    usageLimits: {
      checkedAt: at,
      windows: [],
      nativeAllowanceObservedAt: at,
      quotaPoolObservedAt: at,
      nativeRouteObservedAt: at,
      nativeRouteVerified: true,
      quotaPoolId: `codex:sha256:${"a".repeat(64)}`,
      ordinaryUsageAllowed: false,
      spendControlReached: false,
      rateLimitReachedType: "rate_limit_reached",
      credits: { hasCredits: true, unlimited: false, balance: "0.25" },
    },
  };
}

let renderer: ReactTestRenderer;
beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(now);
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
});
afterEach(async () => {
  if (renderer) await act(() => renderer.unmount());
  vi.useRealTimers();
  vi.unstubAllGlobals();
});
const button = () => renderer.root.findByType("button");
it("submits one explicit account/model-bound intent and never buys credits", async () => {
  const onContinue = vi.fn().mockResolvedValue(undefined);
  await act(() => {
    renderer = create(
      <CreditRecoveryAction provider={provider()} context={context} onContinue={onContinue} />,
    );
  });
  expect(button().props.disabled).toBe(false);
  await act(async () => {
    button().props.onClick();
    button().props.onClick();
  });
  expect(onContinue).toHaveBeenCalledTimes(1);
  expect(onContinue.mock.calls[0]![0]).toMatchObject({
    type: "human-submit-existing-credits",
    instanceId,
    model: context.selection.model,
  });
});
it("expires the action without hiding the reported balance", async () => {
  await act(() => {
    renderer = create(
      <CreditRecoveryAction provider={provider()} context={context} onContinue={vi.fn()} />,
    );
  });
  await act(() => {
    vi.advanceTimersByTime(61_000);
  });
  expect(button().props.disabled).toBe(true);
  expect(JSON.stringify(renderer.toJSON())).toContain("0.25 credits reported available");
});
it("shows provider rejection and leaves retry available", async () => {
  await act(() => {
    renderer = create(
      <CreditRecoveryAction
        provider={provider()}
        context={context}
        onContinue={async () => {
          throw new Error("Account changed");
        }}
      />,
    );
  });
  await act(async () => button().props.onClick());
  expect(renderer.root.findByProps({ role: "alert" }).children.join("")).toBe("Account changed");
  expect(button().props.disabled).toBe(false);
});
it("formats balances without float rounding or pretending tiny balances are zero", () => {
  expect(formatCreditBalance("39034.0733405000")).toBe("39,034.07");
  expect(formatCreditBalance("0.0001")).toBe("<0.01");
  expect(formatCreditBalance("0")).toBe("0");
  for (const value of [null, "NaN", "-2", "secret@example.com"])
    expect(formatCreditBalance(value)).toBeNull();
});
