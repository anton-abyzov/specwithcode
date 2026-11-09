import type { AwaySession, AwaySnapshot, EnvironmentId } from "@specweave-studio/contracts";
import { describe, expect, it } from "vite-plus/test";

import {
  awayItemLabel,
  awaySessionHeadline,
  showAwayWakeCard,
  summarizeAwaySession,
} from "./awaySession.logic";

const M4 = "env-m4" as EnvironmentId;
const MINI = "env-ministorm" as EnvironmentId;

const session: AwaySession = {
  sessionId: "s1",
  targetEnvironmentId: MINI,
  targetLabel: "Ministorm",
  trigger: "sleep",
  coordinatorScope: "live",
  startedAt: "2026-11-09T22:00:00.000Z",
  finishedAt: "2026-11-09T22:02:00.000Z",
  stage: "done",
  bringBackStartedAt: null,
  broughtBackAt: null,
  items: [
    { kind: "routine", id: "r1", title: "Instagram", outcome: "moved", detail: "Runs there." },
    {
      kind: "thread",
      id: "t1",
      title: "Build",
      outcome: "moved",
      detail: "Moved.",
      targetId: "t1m",
    },
    { kind: "coordinator", id: "p1", title: "Insta", outcome: "moved", detail: "Handed over." },
    { kind: "thread", id: "t2", title: "Docs", outcome: "handoff-ready", detail: "No .env.local" },
  ],
};

const snapshot = (patch: Partial<AwaySnapshot> = {}): AwaySnapshot => ({
  environmentId: M4,
  machineLabel: "M4",
  settings: {
    target: MINI,
    sleepTrigger: "on-battery",
    graceMinutes: 2,
    bringBack: "prompt",
    coordinatorScope: "live",
  },
  session,
  running: false,
  ...patch,
});

describe("summarizeAwaySession", () => {
  it("groups moved and stayed, coordinators first, with Open on links for moved threads", () => {
    const groups = summarizeAwaySession(session, M4);
    expect(groups.map((group) => group.title)).toEqual([
      "Moved to Ministorm (3)",
      "Stayed here (1)",
    ]);
    expect(groups[0]!.rows.map((row) => row.item.id)).toEqual(["p1", "t1", "r1"]);
    expect(groups[0]!.rows[1]!.open).toEqual({ threadId: "t1m", environmentId: MINI });
    expect(groups[1]!.rows[0]).toMatchObject({ label: "Ready to move", detail: "No .env.local" });
  });

  it("links a returned thread to its continuation here", () => {
    const back: AwaySession = {
      ...session,
      items: [
        {
          ...session.items[1]!,
          back: { outcome: "returned", detail: "Continues here.", at: "x", localId: "t1back" },
        },
      ],
    };
    const row = summarizeAwaySession(back, M4)[0]!.rows[0]!;
    expect(row).toMatchObject({ label: "Back", detail: "Continues here." });
    expect(row.open).toEqual({ threadId: "t1back", environmentId: M4 });
  });
});

describe("awayItemLabel and awaySessionHeadline", () => {
  it("words each state", () => {
    expect(awayItemLabel({ ...session.items[0]!, outcome: "failed" }, "Ministorm").label).toBe(
      "Not moved",
    );
    expect(awaySessionHeadline(session, false)).toBe("3 items moved to Ministorm. 1 stayed here.");
    expect(awaySessionHeadline({ ...session, finishedAt: null }, true)).toBe(
      "Moving work to Ministorm…",
    );
    expect(awaySessionHeadline({ ...session, broughtBackAt: "x" }, false)).toBe(
      "Your work is back from Ministorm.",
    );
  });
});

describe("showAwayWakeCard", () => {
  it("asks only for a finished session not back, with the prompt setting, until dismissed", () => {
    expect(showAwayWakeCard(snapshot(), null)).toBe(true);
    expect(showAwayWakeCard(snapshot(), "s1")).toBe(false);
    expect(showAwayWakeCard(snapshot({ running: true }), null)).toBe(false);
    expect(
      showAwayWakeCard(
        snapshot({ settings: { ...snapshot().settings, bringBack: "manual" } }),
        null,
      ),
    ).toBe(false);
    expect(showAwayWakeCard(snapshot({ session: { ...session, broughtBackAt: "x" } }), null)).toBe(
      false,
    );
    expect(showAwayWakeCard(snapshot({ session: null }), null)).toBe(false);
  });
});

describe("pending items while Leave runs", () => {
  it("lists them under Waiting, not Stayed here", () => {
    const session: AwaySession = {
      sessionId: "s2",
      targetEnvironmentId: "env-ministorm" as EnvironmentId,
      targetLabel: "Ministorm",
      trigger: "manual",
      coordinatorScope: "live",
      startedAt: "2026-11-09T10:00:00.000Z",
      finishedAt: null,
      stage: "threads",
      bringBackStartedAt: null,
      broughtBackAt: null,
      items: [
        { kind: "thread", id: "t1", title: "A", outcome: "pending", detail: "Waiting." },
        { kind: "thread", id: "t2", title: "B", outcome: "stayed", detail: "Kept here." },
      ],
    };
    const groups = summarizeAwaySession(session, "env-m4" as EnvironmentId);
    expect(groups.map((group) => group.title)).toEqual(["Stayed here (1)", "Waiting (1)"]);
  });
});

describe("the wake card after a lid close (#4)", () => {
  const sleepSession: AwaySession = {
    ...session,
    trigger: "sleep",
  };

  it("shows for a lid close that moved work, with prompt or auto on power, from a fresh mount", () => {
    expect(showAwayWakeCard(snapshot({ session: sleepSession }), null)).toBe(true);
    expect(
      showAwayWakeCard(
        snapshot({
          session: sleepSession,
          settings: { ...snapshot().settings, bringBack: "auto-on-power" },
        }),
        null,
      ),
    ).toBe(true);
  });

  it("waits while the wake check runs, and words it", () => {
    const pending: AwaySession = { ...sleepSession, stage: "pending-intent", finishedAt: null };
    expect(showAwayWakeCard(snapshot({ session: pending }), null)).toBe(false);
    expect(awaySessionHeadline(pending, false)).toBe(
      "Work goes to Ministorm if this machine stays asleep. Checking what moved…",
    );
  });
});
