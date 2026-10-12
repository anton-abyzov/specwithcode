import { ProviderDriverKind } from "@specweave-studio/contracts";
import type { LimitAccount, LimitPool } from "@specweave-studio/shared/usageLimits";
import { collectLimitPools } from "@specweave-studio/shared/usageLimits";
import { describe, expect, it } from "vite-plus/test";
import { usageIndicatorProviders, usageIndicatorSummary, usageTone } from "./usageIndicatorModel";

const now = Date.parse("2026-10-10T12:00:00.000Z");
const at = (hours: number) => new Date(now + hours * 3_600_000).toISOString();

function account(
  key: string,
  driver: string,
  windows: ReadonlyArray<{ id: string; kind: "session" | "weekly"; used: number; reset?: number }>,
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
        label: window.kind === "session" ? "5-hour" : "Weekly",
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

  it("grades tone at 80 and 95 percent and names providers in the summary", () => {
    expect([79, 80, 94, 95].map(usageTone)).toEqual(["ok", "warn", "warn", "full"]);
    const providers = usageIndicatorProviders(
      pools([account("codex", "codex", [{ id: "primary", kind: "session", used: 96, reset: 1 }])]),
      now,
    );
    expect(providers[0]?.tone).toBe("full");
    expect(usageIndicatorSummary(providers, () => "Codex")).toBe("Codex 96% used");
  });
});
