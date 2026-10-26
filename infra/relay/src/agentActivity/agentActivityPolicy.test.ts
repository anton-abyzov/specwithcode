import { describe, expect, it } from "@effect/vitest";
import { EnvironmentId, ThreadId } from "@specweave-studio/contracts";
import type { RelayAgentActivityState } from "@specweave-studio/contracts/relay";
import { makeAggregateState } from "./agentActivityAggregate.ts";
import {
  alertForTerminalAggregate,
  attentionTransitionRows,
  terminalTransitionRows,
  shouldAlertForActivity,
} from "./agentActivityAlerts.ts";

const state: RelayAgentActivityState = {
  environmentId: EnvironmentId.make("env"),
  threadId: ThreadId.make("thread"),
  projectTitle: "Project",
  threadTitle: "Thread",
  modelTitle: "Model",
  headline: "Working",
  phase: "running",
  updatedAt: "1970-01-01T00:00:00.000Z",
  deepLink: "/threads/env/thread",
};
const preferences = {
  notificationsEnabled: true,
  liveActivitiesEnabled: true,
  notifyOnApproval: true,
  notifyOnInput: true,
  notifyOnCompletion: true,
  notifyOnFailure: true,
};
const aggregate = (states: RelayAgentActivityState[]) =>
  makeAggregateState({ activeStates: states, terminalState: null, nowMs: 0 })!;

describe("shared agent activity policy", () => {
  it.each(["waiting_for_approval", "waiting_for_input"] as const)(
    "keeps an older %s ahead of five running rows",
    (phase) => {
      const running = Array.from({ length: 5 }, (_, i) => ({
        ...state,
        threadId: ThreadId.make(`running-${i}`),
      }));
      const waiting = { ...state, phase, updatedAt: "1969-12-31T23:59:00.000Z" };
      const next = aggregate([...running, waiting]);
      expect(next.activities[0]?.threadId).toBe(state.threadId);
      expect(next.activeCount).toBe(6);
      expect(next.activities).toHaveLength(5);
      expect(
        attentionTransitionRows({
          previousAggregate: aggregate(running),
          nextAggregate: next,
          preferences,
        }),
      ).toMatchObject([{ threadId: state.threadId }]);
    },
  );

  it("allows fresh unobserved completions for events, but not reconciliation or repeats", () => {
    const previousAggregate = aggregate([
      { ...state, threadId: ThreadId.make("old"), phase: "completed" },
    ]);
    const nextAggregate = aggregate([{ ...state, phase: "completed" }]);
    const input = { previousAggregate, nextAggregate, preferences, nowMs: 0 };
    expect(terminalTransitionRows(input)).toEqual([]);
    expect(terminalTransitionRows({ ...input, includeUnobserved: true })).toHaveLength(1);
    expect(
      terminalTransitionRows({
        ...input,
        includeUnobserved: true,
        previousAggregate: nextAggregate,
      }),
    ).toEqual([]);
    expect(terminalTransitionRows({ ...input, includeUnobserved: true, nowMs: 180_000 })).toEqual(
      [],
    );
  });

  it("distinguishes equal thread IDs across environments", () => {
    const waiting = { ...state, phase: "waiting_for_input" as const };
    const other = { ...waiting, environmentId: EnvironmentId.make("other") };
    expect(
      attentionTransitionRows({
        previousAggregate: aggregate([waiting]),
        nextAggregate: aggregate([waiting, other]),
        preferences,
      }),
    ).toMatchObject([{ environmentId: other.environmentId }]);
  });

  it("checks current permission, event preferences, and freshness together", () => {
    const input = { ...state, phase: "completed" as const, preferences, nowMs: 0 };
    expect(shouldAlertForActivity(input)).toBe(true);
    expect(
      shouldAlertForActivity({
        ...input,
        preferences: { ...preferences, notificationsEnabled: false },
      }),
    ).toBe(false);
    expect(
      shouldAlertForActivity({
        ...input,
        preferences: { ...preferences, notifyOnCompletion: false },
      }),
    ).toBe(false);
    expect(shouldAlertForActivity({ ...input, nowMs: 180_000 })).toBe(false);
  });

  it("keeps a quiet project's rows off alerts but in the aggregate", () => {
    const previousAggregate = aggregate([state]);
    const waiting = { ...state, phase: "waiting_for_input" as const };
    expect(
      attentionTransitionRows({
        previousAggregate,
        nextAggregate: aggregate([waiting]),
        preferences,
      }),
    ).toHaveLength(1);
    const quietWaiting = aggregate([{ ...waiting, quiet: true }]);
    expect(quietWaiting.activities).toMatchObject([{ threadId: state.threadId, quiet: true }]);
    expect(
      attentionTransitionRows({ previousAggregate, nextAggregate: quietWaiting, preferences }),
    ).toEqual([]);

    const done = { ...state, phase: "completed" as const };
    const finished = (terminal: RelayAgentActivityState) =>
      makeAggregateState({ activeStates: [], terminalState: terminal, nowMs: 0 })!;
    const terminal = (next: RelayAgentActivityState) =>
      terminalTransitionRows({
        previousAggregate,
        nextAggregate: finished(next),
        preferences,
        nowMs: 0,
      });
    expect(terminal(done)).toHaveLength(1);
    expect(terminal({ ...done, quiet: true })).toEqual([]);
    expect(alertForTerminalAggregate({ aggregate: finished(done), preferences })).not.toBeNull();
    expect(
      alertForTerminalAggregate({ aggregate: finished({ ...done, quiet: true }), preferences }),
    ).toBeNull();
    expect(shouldAlertForActivity({ ...done, preferences, nowMs: 0 })).toBe(true);
    expect(shouldAlertForActivity({ ...done, quiet: true, preferences, nowMs: 0 })).toBe(false);
  });
});
