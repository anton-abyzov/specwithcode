import * as NodeVM from "node:vm";
import { assert, describe, it } from "vite-plus/test";

import acTraceLint from "../../../../examples/mods/ac-trace-lint/register.js?raw";
import incrementStandup from "../../../../examples/mods/increment-standup/register.js?raw";
import readyToClose from "../../../../examples/mods/ready-to-close/register.js?raw";
import reviewQueue from "../../../../examples/mods/review-queue/register.js?raw";
import { buildModScript } from "./sandbox";
import { parseFrameMessage, parseModTree } from "./protocol";

/** Runs a mod's real worker script with a stand-in worker scope. */
function startMod(source: string) {
  const sent: Array<Record<string, unknown>> = [];
  const listeners: Array<(event: { data: unknown }) => void> = [];
  const scope: Record<string, unknown> = {
    postMessage: (message: unknown) =>
      sent.push(structuredClone(message) as Record<string, unknown>),
    setInterval: () => 0,
    addEventListener: (type: string, listener: (event: { data: unknown }) => void) => {
      if (type === "message") listeners.push(listener);
    },
  };
  scope.self = scope;
  NodeVM.runInNewContext(buildModScript(source), scope);
  const deliver = async (data: unknown) => {
    for (const listener of listeners) listener({ data });
    await new Promise((resolve) => setImmediate(resolve));
  };
  return { sent, deliver };
}

const MOD = `
export function register(on) {
  let pane = "none";
  const publish = ($, first, second) =>
    $.ui.status([
      { glyph: "blocked", count: 2, label: "Blocked", onPress: () => $.ui.open({ id: first, title: first }) },
      { glyph: "gap", count: 1, label: "Gap", onPress: () => $.ui.open({ id: second, title: second }) },
    ]);
  on("app.start", ($, e, next) => { publish($, "one", "two"); return next(e); });
  on("command.run", { name: "swap" }, ($) => publish($, "three", "four"));
  on("command.run", { name: "text" }, ($) => $.ui.status("Plain"));
  on("command.run", { name: "bad" }, ($) =>
    $.ui.status([{ glyph: "gap", count: 1, label: "Bad", detail: () => 1 }]),
  );
  on("command.run", { name: "clear" }, ($) => $.ui.status(undefined));
}`;

const statuses = (sent: ReadonlyArray<Record<string, unknown>>) =>
  sent.flatMap((message) => {
    const parsed = parseFrameMessage(message);
    return parsed?.type === "ui.status" ? [parsed] : [];
  });
const opened = (sent: ReadonlyArray<Record<string, unknown>>) =>
  sent.filter((message) => message.type === "ui.open").map((message) => message.id);

const boot = async () => {
  const mod = startMod(MOD);
  await mod.deliver({ type: "init", name: "m", surface: "web", permissions: [] });
  return mod;
};
const handlerOf = (sent: ReadonlyArray<Record<string, unknown>>, index: number) =>
  statuses(sent).at(-1)?.stats?.[index]?.handler ?? -1;

describe("stats in the mod runtime", () => {
  it("keeps functions in the worker and sends the host numbers", async () => {
    const { sent, deliver } = await boot();
    assert.deepEqual(
      statuses(sent)
        .at(-1)
        ?.stats?.map((stat) => stat.label),
      ["Blocked", "Gap"],
    );
    await deliver({ type: "press", id: "$status", handler: handlerOf(sent, 1) });
    assert.deepEqual(opened(sent), ["two"]);
  });

  it("ignores a press from a status already replaced", async () => {
    const { sent, deliver } = await boot();
    const old = handlerOf(sent, 0);
    await deliver({ type: "event", event: "command.run", e: { name: "swap" } });
    assert.notEqual(handlerOf(sent, 0), old);
    await deliver({ type: "press", id: "$status", handler: old });
    assert.deepEqual(opened(sent), []);
    await deliver({ type: "press", id: "$status", handler: handlerOf(sent, 0) });
    assert.deepEqual(opened(sent), ["three"]);
  });

  it("keeps the last rows working when a stat cannot be sent", async () => {
    const { sent, deliver } = await boot();
    const handler = handlerOf(sent, 0);
    await deliver({ type: "event", event: "command.run", e: { name: "bad" } });
    assert.isTrue(sent.some((message) => message.type === "error"));
    await deliver({ type: "press", id: "$status", handler });
    assert.deepEqual(opened(sent), ["one"]);
  });

  it("drops the stats' handlers when text or nothing replaces them", async () => {
    const { sent, deliver } = await boot();
    const old = handlerOf(sent, 0);
    await deliver({ type: "event", event: "command.run", e: { name: "text" } });
    assert.deepInclude(statuses(sent).at(-1), { text: "Plain", stats: null });
    await deliver({ type: "press", id: "$status", handler: old });
    await deliver({ type: "event", event: "command.run", e: { name: "clear" } });
    assert.deepInclude(statuses(sent).at(-1), { text: null, stats: null });
    assert.deepEqual(opened(sent), []);
  });
});

// The server's caps: 60 increments in all. Long text and many tasks are the worst case.
const longText = "x".repeat(300);
const increments = (
  status: "blocked" | "stale" | "done",
  tasksEach: number,
  verify: { ok: boolean; ranAt: string } | null = null,
) =>
  Array.from({ length: 60 }, (_, incrementIndex) => ({
    project: "project",
    id: `${String(incrementIndex).padStart(4, "0")}-increment`,
    title: longText,
    status: "active",
    updatedAt: null,
    readable: true,
    criteria: [],
    tasks: Array.from({ length: tasksEach }, (_, taskIndex) => ({
      id: `T-${taskIndex}`,
      title: tasksEach > 3 ? longText : "short",
      status,
      criteria: [],
      changedAt: null,
      note: null,
    })),
    malformedLedgerLines: 0,
    verify,
  }));

describe("example mods draw every stat's list", () => {
  const openStat = async (
    source: string,
    event: string,
    e: unknown,
    label: string,
  ): Promise<string> => {
    const { sent, deliver } = startMod(source);
    await deliver({ type: "init", name: "example", surface: "web", permissions: [] });
    await deliver({ type: "event", event, e });
    const stat = statuses(sent)
      .at(-1)
      ?.stats?.find((entry) => entry.label === label);
    assert.isDefined(stat, `reports ${label}`);
    await deliver({ type: "press", id: "$status", handler: stat?.handler ?? -1 });
    const tree = sent.findLast((message) => message.type === "ui.tree")?.tree;
    assert.isNotNull(parseModTree(tree), `${label} is over a tree limit`);
    return JSON.stringify(tree);
  };

  const openFromPalette = async (source: string, e: unknown, name: string) => {
    const { sent, deliver } = startMod(source);
    await deliver({ type: "init", name: "example", surface: "web", permissions: [] });
    await deliver({ type: "event", event: "specweave.changed", e });
    await deliver({ type: "event", event: "command.run", e: { name } });
    const tree = sent.findLast((message) => message.type === "ui.tree")?.tree;
    assert.isNotNull(parseModTree(tree), `${name} is over a tree limit`);
    return { tree: JSON.stringify(tree), sent };
  };

  // A sidebar count must open exactly what it counts; ledger tasks and increments
  // are not threads, so the number could never match anything the sidebar lists.
  it.each([
    ["increment-standup", incrementStandup, "standup"],
    ["ready-to-close", readyToClose, "close-queue"],
    ["ac-trace-lint", acTraceLint, "trace-gaps"],
  ])("%s reports no sidebar count", async (_name, source, command) => {
    for (const status of ["blocked", "stale", "done"] as const) {
      const { sent } = await openFromPalette(
        source,
        { increments: increments(status, 2), truncated: false },
        command,
      );
      assert.deepEqual(statuses(sent).at(-1)?.stats ?? [], []);
      assert.isNotOk(statuses(sent).at(-1)?.text);
    }
  });

  it.each([1, 2, 3, 40])("increment-standup with %i tasks per increment", async (tasksEach) => {
    const { tree } = await openFromPalette(
      incrementStandup,
      { increments: increments("blocked", tasksEach), truncated: false },
      "standup",
    );
    assert.include(tree, "blocked");
  });

  it("increment-standup never lists a stale claim", async () => {
    const { tree } = await openFromPalette(
      incrementStandup,
      { increments: increments("stale", 2), truncated: false },
      "standup",
    );
    assert.notInclude(tree.toLowerCase(), "stale");
  });

  it("ready-to-close says how many it left out", async () => {
    const { tree } = await openFromPalette(
      readyToClose,
      { increments: increments("done", 2), truncated: false },
      "close-queue",
    );
    assert.include(tree, "40 more not shown.");
  });

  it("review-queue with a thousand long titles", async () => {
    const threads = Array.from({ length: 1000 }, (_, index) => ({
      id: `thread-${index}`,
      title: longText,
      project: "project",
      state: "waiting",
      attention: "approval",
      working: false,
      updatedAt: null,
    }));
    const tree = await openStat(reviewQueue, "threads.changed", { threads }, "Needs you");
    assert.include(tree, "960 more waiting.");
  });
});
