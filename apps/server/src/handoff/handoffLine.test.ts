// @effect-diagnostics nodeBuiltinImport:off - disposable real Git fixtures only.
/**
 * The line an automatic hand off leaves in the thread on both machines (1390
 * AC-28): "Handed off to M5 at 14:02: Claude usage limit on m4". The source
 * puts it on its link to the continuation; the destination on the
 * continuation's link back.
 */
import * as NodeFS from "node:fs";

import { afterEach, describe, expect, it } from "@effect/vitest";
import { ThreadId } from "@specweave-studio/contracts";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";

import { arrivalLink, handoffLine } from "./handoffLine.ts";
import { makeRig, type RigMachine } from "./handoffTransfer.test.fixture.ts";

const temporary: Array<string> = [];
afterEach(() => {
  for (const path of temporary.splice(0))
    NodeFS.rmSync(path, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 });
});

const t1 = ThreadId.make("thread:one");
const utc = DateTime.zoneMakeNamedUnsafe("UTC");
const at = Date.parse("2026-11-19T14:02:41.000Z");

describe("the line an automatic hand off leaves (AC-28)", () => {
  it("names the machine, the time there and why", () => {
    expect(
      handoffLine({
        machineLabel: "M5",
        atMs: at,
        reason: "Claude usage limit on m4",
        timeZone: utc,
      }),
    ).toBe("Handed off to M5 at 14:02: Claude usage limit on m4");
  });

  it("keeps within a link's 300 characters", () => {
    const line = handoffLine({
      machineLabel: "M5",
      atMs: at,
      reason: "x".repeat(400),
      timeZone: utc,
    });
    expect(line.length).toBeLessThanOrEqual(300);
    expect(line.startsWith("Handed off to M5 at 14:02: x")).toBe(true);
  });

  it("is written only for an automatic move that says why", () => {
    const base = {
      sourceThreadId: t1,
      sourceProjectId: "project-1",
      title: "Ship it",
      sourceEnvironmentId: "env-m4",
      sourceLabel: "M4",
      machineLabel: "M5",
      atMs: at,
      timeZone: utc,
    } as const;
    expect(
      arrivalLink({
        ...base,
        trigger: { kind: "automatic", reason: "Daily track out of tokens on M4" },
      }),
    ).toMatchObject({
      threadId: t1,
      kind: "handoff",
      machineLabel: "M4",
      note: "Handed off to M5 at 14:02: Daily track out of tokens on M4",
    });
    expect(arrivalLink({ ...base, trigger: { kind: "manual" } })).toBeNull();
    expect(arrivalLink({ ...base, trigger: { kind: "automatic" } })).toBeNull();
    expect(arrivalLink({ ...base, trigger: null })).toBeNull();
  });
});

const targetLinks = (machine: RigMachine) =>
  machine.dispatched.filter(
    (command) => command.type === "thread.project-move.record" && command.side === "target",
  ) as unknown as ReadonlyArray<{
    readonly link: { readonly note?: string; readonly threadId: string };
  }>;

describe("the destination of an automatic hand off (AC-28)", () => {
  it.effect("records the line on the continuation, linked to the thread it came from", () =>
    Effect.gen(function* () {
      const rig = yield* makeRig(temporary);
      const [a, b] = rig.machines as [RigMachine, RigMachine];
      rig.addThread(a, t1);
      const there = yield* a.moves.handOff({
        threadId: t1,
        destinationEnvironmentId: b.environmentId,
        trigger: {
          kind: "automatic",
          key: "limit-handoff:thread:one:run-1",
          reason: "Claude limit reached on M4",
        },
      });
      const links = targetLinks(b);
      expect(links).toHaveLength(1);
      expect(links[0]?.link.threadId).toBe(t1);
      expect(links[0]?.link.note).toMatch(
        new RegExp(`^Handed off to ${b.label} at \\d\\d:\\d\\d: Claude limit reached on M4$`),
      );
      expect(there.threadId).not.toBe(t1);
    }),
  );

  it.effect("records nothing for a hand off someone asked for", () =>
    Effect.gen(function* () {
      const rig = yield* makeRig(temporary);
      const [a, b] = rig.machines as [RigMachine, RigMachine];
      rig.addThread(a, t1);
      yield* a.moves.handOff({ threadId: t1, destinationEnvironmentId: b.environmentId });
      expect(targetLinks(b)).toEqual([]);
    }),
  );
});
