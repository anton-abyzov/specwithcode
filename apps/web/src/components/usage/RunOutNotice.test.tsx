import { ProviderDriverKind } from "@specweave-studio/contracts";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vite-plus/test";

vi.mock("../../hooks/useSettings", () => ({
  usePrimarySettings: (select: (settings: { timestampFormat: "12-hour" }) => unknown) =>
    select({ timestampFormat: "12-hour" }),
}));

import { RunOutNotice, resetPhrase, runOutWindowsOf } from "./RunOutNotice";

const HOUR = 3_600_000;
const now = new Date(2026, 10, 1, 12, 0).getTime();
const at = (ms: number) => new Date(ms).toISOString();

// 2h into the 5-hour window and 60% used: it runs out in 1h 20m, before the 3h reset.
const windows = runOutWindowsOf([
  {
    id: "five_hour",
    kind: "session",
    label: "Session",
    usedPercent: 60,
    windowDurationMins: 300,
    resetsAt: at(now + 3 * HOUR),
  },
  {
    id: "seven_day",
    kind: "weekly",
    label: "Weekly",
    usedPercent: 10,
    windowDurationMins: 10080,
    resetsAt: at(now + 120 * HOUR),
  },
]);

const render = (driver: string, list = windows) =>
  renderToStaticMarkup(
    <RunOutNotice driver={ProviderDriverKind.make(driver)} windows={list} now={now} />,
  );

describe("RunOutNotice", () => {
  it("warns a Claude Code subscription that the 5-hour runs out before its reset", () => {
    const html = render("claudeAgent");
    expect(html).toContain('data-run-out="pace"');
    expect(html).toContain("you&#x27;ll hit your 5-hour limit in 1h 20m, before it resets at 3");
  });

  it("shows nothing for Codex, Copilot or Cursor with the same windows", () => {
    for (const driver of ["codex", "acpRegistry", "cursor"]) expect(render(driver)).toBe("");
  });

  it("says when a spent 5-hour limit resets", () => {
    const spent = windows.map((window) =>
      window.id === "five_hour" ? { ...window, usedPercent: 100 } : window,
    );
    const html = render("claudeAgent", spent);
    expect(html).toContain('data-run-out="reached"');
    expect(html).toContain("5-hour limit reached. It resets at 3");
  });

  it("drops a window whose reset is missing or malformed instead of guessing", () => {
    const [unread] = runOutWindowsOf([
      { id: "five_hour", kind: "session", label: "Session", usedPercent: 0, resetsAt: "nope" },
    ]);
    expect(unread?.resetsAt).toBeNull();
    expect(render("claudeAgent", [unread!])).toBe("");
  });

  it("stays quiet while a spent weekly with an unreadable reset blocks the 5-hour", () => {
    const blocked = runOutWindowsOf([
      {
        id: "five_hour",
        kind: "session",
        label: "Session",
        usedPercent: 60,
        windowDurationMins: 300,
        resetsAt: at(now + 3 * HOUR),
      },
      { id: "seven_day", kind: "weekly", label: "Weekly", usedPercent: 100, resetsAt: "nope" },
    ]);
    expect(render("claudeAgent", blocked)).toBe("");
  });

  it("reads 99.5% as reached, as the machine rows do", () => {
    const [nearly] = runOutWindowsOf([
      {
        id: "five_hour",
        kind: "session",
        label: "Session",
        usedPercent: 99.5,
        windowDurationMins: 300,
        resetsAt: at(now + 3 * HOUR),
      },
    ]);
    expect(render("claudeAgent", [nearly!])).toContain('data-run-out="reached"');
  });

  it("says under a minute rather than 0m", () => {
    // 30 minutes in at 99%: the last 1% goes in about 18 seconds.
    const [close] = runOutWindowsOf([
      {
        id: "five_hour",
        kind: "session",
        label: "Session",
        usedPercent: 99,
        windowDurationMins: 300,
        resetsAt: at(now + 270 * 60_000),
      },
    ]);
    expect(render("claudeAgent", [close!])).toContain("limit in under a minute");
  });
});

describe("resetPhrase", () => {
  it("chooses at, tomorrow or on by calendar day, whatever the locale's date shape", () => {
    expect(resetPhrase("3:40 PM", now + 3 * HOUR, now)).toBe("at 3:40 PM");
    expect(resetPhrase("tomorrow at 8:00 AM", now + 20 * HOUR, now)).toBe("tomorrow at 8:00 AM");
    expect(resetPhrase("11/7 8:00 AM", now + 140 * HOUR, now)).toBe("on 11/7 8:00 AM");
    expect(resetPhrase("7.11. 08:00", now + 140 * HOUR, now)).toBe("on 7.11. 08:00");
  });
});
