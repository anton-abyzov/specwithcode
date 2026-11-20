import type { UsageResetPeriod } from "@specweave-studio/contracts";
import { describe, expect, it, vi } from "vite-plus/test";

vi.mock("../../../state/server", () => ({ serverEnvironment: {} }));
vi.mock("../../../state/session", () => ({ useEnvironmentsWithScope: () => new Set() }));
vi.mock("../../../state/use-atom-command", () => ({ useAtomCommand: () => () => undefined }));

import { mergeLedgers } from "./usageResetLedgerState";

const HOUR = 3_600_000;
const at = Date.parse("2026-11-10T12:00:00.000Z");
const period = (windowKind: "weekly" | "monthly", lastReadAt: number, endedAt: number) =>
  ({
    accountKey: "codex:pro@example.com",
    driver: "codex",
    windowId: "primary",
    windowKind,
    endedAt: new Date(endedAt).toISOString(),
    lastReadAt: new Date(lastReadAt).toISOString(),
    usedPercentAtReset: 90,
    lostPercent: 10,
    cause: "scheduled",
  }) as UsageResetPeriod;

describe("mergeLedgers", () => {
  it("keeps a weekly and a monthly reset of one window id apart", () => {
    const weekly = period("weekly", at - 2 * HOUR, at);
    const monthly = period("monthly", at - HOUR, at + HOUR);
    expect(mergeLedgers([[weekly], [monthly]]).map((entry) => entry.windowKind)).toEqual([
      "weekly",
      "monthly",
    ]);
  });

  it("still merges two machines' reads of the same reset", () => {
    const early = period("weekly", at - 3 * HOUR, at);
    const late = period("weekly", at - HOUR, at);
    expect(mergeLedgers([[early], [late]])).toEqual([late]);
  });
});
