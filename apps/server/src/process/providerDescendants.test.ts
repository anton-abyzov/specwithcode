import { describe, expect, it } from "vite-plus/test";

import {
  type ProcessRow,
  makeDescendantLedger,
  observeDescendants,
  parseProcessTable,
  reapTargets,
} from "./providerDescendants.ts";

const SERVER = { pid: 100, pgid: 90 };

const row = (
  pid: number,
  ppid: number,
  pgid: number,
  startedAt = `t${pid}`,
  nice = 0,
): ProcessRow => ({
  pid,
  ppid,
  pgid,
  nice,
  startedAt,
});

// launchd, the server's own launcher group, and processes that have nothing to do with the provider.
const host = [row(1, 0, 1), row(90, 1, 90), row(100, 90, 90), row(400, 1, 400), row(401, 400, 400)];

describe("parseProcessTable", () => {
  it("reads ps rows with their full start time", () => {
    const rows = parseProcessTable(
      [
        "    1     0     1   0 Sat Oct 17 00:24:06 2026    ",
        "18347     1 18260  10 Mon Oct 19 05:50:00 2026",
        "garbage",
        "",
      ].join("\n"),
    );
    expect(rows).toEqual([
      { pid: 1, ppid: 0, pgid: 1, nice: 0, startedAt: "Sat Oct 17 00:24:06 2026" },
      { pid: 18347, ppid: 1, pgid: 18260, nice: 10, startedAt: "Mon Oct 19 05:50:00 2026" },
    ]);
  });
});

describe("provider descendant ledger", () => {
  // Copilot (pgid 200) runs a shell tool in a fresh group 300, which starts
  // `(nohup python &)`. The shell exits and python is reparented to launchd.
  const copilotRunningTool = [
    ...host,
    row(200, 100, 200),
    row(201, 200, 200),
    row(300, 201, 300),
    row(301, 300, 300),
  ];
  const toolEscaped = [
    ...host,
    row(200, 100, 200),
    row(201, 200, 200),
    row(301, 1, 300),
    row(302, 301, 300),
  ];

  it("keeps a tool group that escaped the provider after its shell exited", () => {
    const ledger = makeDescendantLedger(200);
    observeDescendants(ledger, copilotRunningTool, SERVER.pgid);
    expect([...ledger.processes.keys()].sort()).toEqual([200, 201, 300, 301]);
    expect([...ledger.groups].sort()).toEqual([200, 300]);

    const added = observeDescendants(ledger, toolEscaped, SERVER.pgid);
    // The later python fork is admitted through its recorded group, not its parent chain.
    expect(added.map((process) => process.pid)).toEqual([302]);
    // The provider itself is alive: its own shutdown ends it and its group.
    expect(reapTargets(ledger, toolEscaped, SERVER)).toEqual([
      { kind: "group", pgid: 300 },
      { kind: "process", pid: 201 },
    ]);
  });

  it("group-kills the provider's own group once the provider has exited", () => {
    const ledger = makeDescendantLedger(200);
    observeDescendants(ledger, copilotRunningTool, SERVER.pgid);
    const providerGone = [...host, row(201, 1, 200), row(301, 1, 300)];
    observeDescendants(ledger, providerGone, SERVER.pgid);
    expect(reapTargets(ledger, providerGone, SERVER)).toEqual([
      { kind: "group", pgid: 200 },
      { kind: "group", pgid: 300 },
    ]);
  });

  it("never targets this server, its group, launchd or unrelated processes", () => {
    // A provider spawned without its own group shares the server's.
    const sharedGroup = [...host, row(200, 100, 90), row(201, 200, 90), row(300, 201, 300)];
    const ledger = makeDescendantLedger(200);
    observeDescendants(ledger, sharedGroup, SERVER.pgid);
    expect(ledger.groups.has(90)).toBe(false);
    const targets = reapTargets(ledger, sharedGroup, SERVER);
    expect(targets).toEqual([
      { kind: "group", pgid: 300 },
      { kind: "process", pid: 201 },
    ]);
    for (const pid of [1, 90, 100, 400, 401]) {
      expect(targets).not.toContainEqual({ kind: "process", pid });
      expect(targets).not.toContainEqual({ kind: "group", pgid: pid });
    }
  });

  it("does not take over a group that holds processes from outside the tree", () => {
    // Descendant 202 joined unrelated group 400; it is signalled alone, never group 400.
    const joined = [...host, row(200, 100, 200), row(202, 200, 400)];
    const ledger = makeDescendantLedger(200);
    observeDescendants(ledger, joined, SERVER.pgid);
    expect(ledger.groups.has(400)).toBe(false);
    expect(reapTargets(ledger, joined, SERVER)).toEqual([{ kind: "process", pid: 202 }]);
  });

  it("forgets a reused pid and a group that emptied", () => {
    const ledger = makeDescendantLedger(200);
    observeDescendants(ledger, copilotRunningTool, SERVER.pgid);
    // 301 is now another process with the same pid, and group 300 had no member in between.
    observeDescendants(ledger, [...host, row(200, 100, 200)], SERVER.pgid);
    const reused = [...host, row(200, 100, 200), row(301, 1, 300, "later")];
    observeDescendants(ledger, reused, SERVER.pgid);
    expect(ledger.processes.has(301)).toBe(false);
    expect(ledger.groups.has(300)).toBe(false);
    expect(reapTargets(ledger, reused, SERVER)).toEqual([]);
  });

  it("records the group a recorded process moved into with setsid", () => {
    const ledger = makeDescendantLedger(200);
    // Sampled between fork and setsid: 300 still sits in the provider's group.
    observeDescendants(ledger, [...host, row(200, 100, 200), row(300, 200, 200)], SERVER.pgid);
    // Then it leads a group of its own, forks a job and exits before the next sample.
    observeDescendants(ledger, [...host, row(200, 100, 200), row(300, 200, 300)], SERVER.pgid);
    expect(ledger.groups.has(300)).toBe(true);
    const escaped = [...host, row(200, 100, 200), row(301, 1, 300)];
    observeDescendants(ledger, escaped, SERVER.pgid);
    expect(ledger.processes.has(301)).toBe(true);
    expect(reapTargets(ledger, escaped, SERVER)).toEqual([{ kind: "group", pgid: 300 }]);
  });

  it("never records a later process that reuses the provider's pid", () => {
    const ledger = makeDescendantLedger(200);
    observeDescendants(ledger, [...host, row(200, 100, 200)], SERVER.pgid);
    observeDescendants(ledger, host, SERVER.pgid);
    const reusedRoot = [...host, row(200, 1, 200, "later"), row(500, 200, 200)];
    expect(observeDescendants(ledger, reusedRoot, SERVER.pgid)).toEqual([]);
    expect(reapTargets(ledger, reusedRoot, SERVER)).toEqual([]);
  });
});
