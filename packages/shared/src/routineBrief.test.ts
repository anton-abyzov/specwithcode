import { describe, expect, it } from "vite-plus/test";

import {
  routineBriefHeader,
  routineCadenceLabel,
  routineOutputLocation,
  routinePeriod,
} from "./routineBrief.ts";

describe("routine brief", () => {
  it("names the previous month, across the year end", () => {
    expect(routinePeriod({ year: 2026, month: 10, day: 1 })).toEqual({
      key: "2026-09",
      label: "September 2026",
    });
    expect(routinePeriod({ year: 2027, month: 1, day: 3 })).toEqual({
      key: "2026-12",
      label: "December 2026",
    });
  });

  it("fills {period} and {date} in the output location", () => {
    expect(
      routineOutputLocation("~/tax/{period}/prep-{date}.md", { year: 2026, month: 3, day: 9 }),
    ).toBe("~/tax/2026-02/prep-2026-03-09.md");
  });

  it("opens with only the parts the brief has", () => {
    const date = { year: 2026, month: 10, day: 20 };
    const bare = routineBriefHeader({
      title: "Research brief",
      brief: { inputs: [], output: null, prepareOnly: false },
      date,
    });
    expect(bare).toBe(
      'Routine "Research brief", run on October 20, 2026. Previous month: September 2026 (2026-09).\n---\n',
    );
    const full = routineBriefHeader({
      title: "Monthly profit and loss",
      brief: {
        inputs: [{ label: "Invoices", location: "/fixtures/example-studio/invoices" }],
        output: "/fixtures/example-studio/pnl/{period}.md",
        prepareOnly: true,
      },
      date,
    });
    expect(full).toContain("check that each exists and is current");
    expect(full).toContain("- Invoices: /fixtures/example-studio/invoices");
    expect(full).toContain("/fixtures/example-studio/pnl/2026-09.md");
    expect(full).toContain("Do not file, pay, send, post, buy or change any account.");
    expect(full.endsWith("\n---\n")).toBe(true);
  });

  it("says each cadence in words", () => {
    expect(routineCadenceLabel({ type: "manual" })).toBe("When you ask");
    expect(routineCadenceLabel({ type: "monthly", dayOfMonth: 1, timeOfDay: "09:00" })).toBe(
      "Monthly on the 1st at 09:00",
    );
    expect(routineCadenceLabel({ type: "monthly", dayOfMonth: 12, timeOfDay: "08:30" })).toBe(
      "Monthly on the 12th at 08:30",
    );
    expect(routineCadenceLabel({ type: "monthly", dayOfMonth: 22, timeOfDay: "08:30" })).toBe(
      "Monthly on the 22nd at 08:30",
    );
    expect(
      routineCadenceLabel({ type: "fixed_time", timeOfDay: "08:00", weekdays: [1, 2, 3, 4, 5] }),
    ).toBe("Weekdays at 08:00");
    expect(routineCadenceLabel({ type: "interval", everyMs: 3_600_000 })).toBe("Every 60 min");
  });
});
