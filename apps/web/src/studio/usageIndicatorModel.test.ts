import { ProviderDriverKind } from "@specweave-studio/contracts";
import type { LimitAccount, LimitPool } from "@specweave-studio/shared/usageLimits";
import { collectLimitPools } from "@specweave-studio/shared/usageLimits";
import { describe, expect, it } from "vite-plus/test";
import {
  blockedLabel,
  usageIndicatorProviders,
  usageIndicatorSummary,
  usageLeftLabel,
  usageTone,
} from "./usageIndicatorModel";

const now = Date.parse("2026-10-10T12:00:00.000Z");
const at = (hours: number) => new Date(now + hours * 3_600_000).toISOString();

function account(
  key: string,
  driver: string,
  windows: ReadonlyArray<{
    id: string;
    kind: "session" | "weekly";
    used: number;
    reset?: number;
    label?: string;
  }>,
  banked?: number,
): LimitAccount {
  return {
    key,
    driver: ProviderDriverKind.make(driver),
    displayName: key,
    email: undefined,
    plan: undefined,
    accentColor: undefined,
    environments: [],
    sourceLabel: null,
    redeem: null,
    limits: {
      checkedAt: at(0),
      windows: windows.map((window) => ({
        id: window.id,
        kind: window.kind,
        label: window.label ?? (window.kind === "session" ? "5-hour" : "Weekly"),
        usedPercent: window.used,
        ...(window.reset === undefined ? {} : { resetsAt: at(window.reset) }),
      })),
      ...(banked === undefined ? {} : { resetCredits: { availableCount: banked } }),
    },
  };
}

const pools = (accounts: readonly LimitAccount[]): readonly LimitPool[] =>
  collectLimitPools(accounts, now);

describe("usage indicator", () => {
  it("shows each provider's fullest window and when it next resets", () => {
    const [claude, codex] = usageIndicatorProviders(
      pools([
        account("claude", "claudeAgent", [
          { id: "five_hour", kind: "session", used: 42, reset: 2 },
          { id: "seven_day", kind: "weekly", used: 61, reset: 72 },
        ]),
        account("codex", "codex", [{ id: "primary", kind: "session", used: 10, reset: 1 }]),
      ]),
      now,
    );
    expect(claude?.peak).toMatchObject({ id: "seven_day", usedPercent: 61 });
    expect(claude?.peak?.nextResetAt).toBe(now + 72 * 3_600_000);
    expect(claude?.windows.map((window) => window.id)).toEqual(["five_hour", "seven_day"]);
    expect(claude?.tone).toBe("ok");
    expect(codex?.peak?.usedPercent).toBe(10);
  });

  it("pools several accounts of one provider and totals their banked resets", () => {
    const [claude] = usageIndicatorProviders(
      pools([
        account("a", "claudeAgent", [{ id: "five_hour", kind: "session", used: 100, reset: 3 }], 2),
        account("b", "claudeAgent", [{ id: "five_hour", kind: "session", used: 70, reset: 1 }], 1),
      ]),
      now,
    );
    expect(claude?.accountCount).toBe(2);
    expect(claude?.peak?.usedPercent).toBe(85);
    expect(claude?.peak?.nextResetAt).toBe(now + 3_600_000);
    expect(claude?.bankedResets).toBe(3);
    expect(claude?.tone).toBe("warn");
  });

  it("does not call a window full when its reset has already passed", () => {
    const [claude] = usageIndicatorProviders(
      pools([
        account("claude", "claudeAgent", [
          { id: "five_hour", kind: "session", used: 100, reset: -1 },
          { id: "seven_day", kind: "weekly", used: 30, reset: 48 },
        ]),
      ]),
      now,
    );
    expect(claude?.peak?.id).toBe("seven_day");
    expect(claude?.tone).toBe("ok");
  });

  it("leaves out a provider that reports no windows", () => {
    expect(usageIndicatorProviders(pools([account("grok", "grok", [])]), now)).toEqual([]);
  });

  it("grades tone by what is left and names providers in the summary", () => {
    expect([21, 20, 6, 5, 0].map(usageTone)).toEqual(["ok", "warn", "warn", "full", "full"]);
    expect([23, 99.6, 100].map(usageLeftLabel)).toEqual(["77% left", "0% left", "Limit reached"]);
    const providers = usageIndicatorProviders(
      pools([account("codex", "codex", [{ id: "primary", kind: "session", used: 96, reset: 1 }])]),
      now,
    );
    expect(providers[0]?.tone).toBe("full");
    expect(usageIndicatorSummary(providers, () => "Codex")).toBe("Codex 4% left");
    const spent = usageIndicatorProviders(
      pools([account("codex", "codex", [{ id: "primary", kind: "session", used: 100, reset: 1 }])]),
      now,
    );
    expect(usageIndicatorSummary(spent, () => "Codex")).toBe("Codex limit reached");
  });

  it("blocks the session while the weekly is spent and says when it reopens", () => {
    const [claude] = usageIndicatorProviders(
      pools([
        account("claude", "claudeAgent", [
          { id: "five_hour", kind: "session", used: 0, reset: 3 },
          { id: "seven_day", kind: "weekly", used: 100, reset: 39 },
          { id: "seven_day_fable", kind: "weekly", used: 7, reset: 39, label: "Weekly · Fable" },
        ]),
      ]),
      now,
      "claude-opus-5-5",
    );
    expect(claude?.peak).toMatchObject({ id: "seven_day", usedPercent: 100 });
    const session = claude?.windows.find((window) => window.id === "five_hour");
    expect(session?.blockedBy).toEqual({ label: "Weekly", resetsAt: now + 39 * 3_600_000 });
    expect(blockedLabel(session!.blockedBy!, now)).toBe(
      "Blocked by weekly limit · resets in 1d 15h",
    );
    expect(claude?.windows.find((window) => window.id === "seven_day")?.blockedBy).toBeUndefined();
  });

  it("counts a model window in the chip only for that model", () => {
    const fable = pools([
      account("claude", "claudeAgent", [
        { id: "five_hour", kind: "session", used: 20, reset: 3 },
        { id: "seven_day", kind: "weekly", used: 30, reset: 39 },
        { id: "seven_day_fable", kind: "weekly", used: 90, reset: 39, label: "Weekly · Fable" },
      ]),
    ]);
    expect(usageIndicatorProviders(fable, now, "claude-opus-5-5")[0]?.peak?.usedPercent).toBe(30);
    expect(usageIndicatorProviders(fable, now, "claude-fable-5-1")[0]?.peak?.usedPercent).toBe(90);
    expect(usageIndicatorProviders(fable, now)[0]?.peak?.usedPercent).toBe(30);
  });
});
