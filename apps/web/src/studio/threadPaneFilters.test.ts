import { describe, expect, it } from "vite-plus/test";

import {
  agentChoices,
  machineChoices,
  threadMatchesPaneFilters,
  type ThreadPaneFacts,
} from "./threadPaneFilters";

const NONE = { machine: null, agent: null, openPullRequest: false };
const fact = (over: Partial<ThreadPaneFacts> = {}): ThreadPaneFacts => ({
  machine: "m4",
  agent: "Claude Code",
  openPullRequest: false,
  open: true,
  ...over,
});
const OPTIONS = [
  { machineId: "m4", label: "m4", count: 9 },
  { machineId: "alpha", label: "alpha", count: 5 },
  { machineId: "ministorm", label: "ministorm", count: 1 },
];

describe("threadMatchesPaneFilters", () => {
  it("keeps a thread only when it meets every filter", () => {
    const thread = fact({ machine: "ministorm", agent: "Codex", openPullRequest: true });
    expect(threadMatchesPaneFilters(thread, NONE)).toBe(true);
    expect(
      threadMatchesPaneFilters(thread, {
        machine: "ministorm",
        agent: "Codex",
        openPullRequest: true,
      }),
    ).toBe(true);
    expect(threadMatchesPaneFilters(thread, { ...NONE, machine: "m4" })).toBe(false);
    expect(threadMatchesPaneFilters(thread, { ...NONE, agent: "Claude Code" })).toBe(false);
    expect(threadMatchesPaneFilters(fact(), { ...NONE, openPullRequest: true })).toBe(false);
  });
});

describe("machineChoices", () => {
  it("puts this machine first and the rest by name, however busy each is", () => {
    const choices = machineChoices(OPTIONS, [], NONE, "ministorm");
    expect(choices.map((choice) => choice.machineId)).toEqual(["ministorm", "alpha", "m4"]);
    expect(choices.map((choice) => choice.current)).toEqual([true, false, false]);
  });

  it("orders by name when this machine runs no thread", () => {
    const choices = machineChoices(OPTIONS, [], NONE, "elsewhere");
    expect(choices.map((choice) => choice.machineId)).toEqual(["alpha", "m4", "ministorm"]);
  });

  it("keeps machines with the same name in one order however busy each is", () => {
    const same = (count: number) => [
      { machineId: "b", label: "another machine", count },
      { machineId: "a", label: "another machine", count: 1 },
    ];
    for (const count of [0, 9])
      expect(machineChoices(same(count), [], NONE, null).map((choice) => choice.machineId)).toEqual(
        ["a", "b"],
      );
  });

  it("counts open threads under the other filters, not its own", () => {
    const facts = [
      fact({ machine: "m4", agent: "Codex" }),
      fact({ machine: "m4" }),
      fact({ machine: "ministorm", agent: "Codex" }),
      fact({ machine: "ministorm", agent: "Codex", open: false }),
    ];
    const filters = { machine: "m4", agent: "Codex", openPullRequest: false };
    const counts = Object.fromEntries(
      machineChoices(OPTIONS, facts, filters, null).map((choice) => [
        choice.machineId,
        choice.count,
      ]),
    );
    expect(counts).toEqual({ alpha: 0, m4: 1, ministorm: 1 });
  });
});

describe("agentChoices", () => {
  it("lists agents by name, counting open threads on the chosen machine", () => {
    const facts = [
      fact({ agent: "Codex" }),
      fact({ agent: "Claude Code" }),
      fact({ agent: "Claude Code", machine: "ministorm" }),
      fact({ agent: "Grok", open: false }),
    ];
    expect(agentChoices(facts, { ...NONE, machine: "m4" })).toEqual([
      { agent: "Claude Code", count: 1 },
      { agent: "Codex", count: 1 },
      { agent: "Grok", count: 0 },
    ]);
  });

  it("offers nothing for a thread with no agent yet", () => {
    expect(agentChoices([fact({ agent: "" })], NONE)).toEqual([]);
  });
});
