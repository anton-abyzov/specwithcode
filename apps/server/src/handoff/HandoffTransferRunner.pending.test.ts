// @effect-diagnostics nodeBuiltinImport:off - disposable real Git fixtures only.
/**
 * A thread that waits on an answer stays where it is (1390): a question, an
 * approval or a sign-in, whether it was there before the hold or arrived while
 * the hold was taken. Nothing is interrupted and nothing is sent.
 */
import * as NodeFS from "node:fs";

import { afterEach, describe, expect, it } from "@effect/vitest";
import { ThreadId } from "@specweave-studio/contracts";
import * as Effect from "effect/Effect";

import { makeRig, type Rig, type RigMachine } from "./handoffTransfer.test.fixture.ts";
import { ANSWER_FIRST } from "./HandoffTransferRunner.ts";

const temporary: Array<string> = [];
afterEach(() => {
  for (const path of temporary.splice(0))
    NodeFS.rmSync(path, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 });
});

const t1 = ThreadId.make("thread:one");
const takeovers = (rig: Rig) => rig.callsOf("takeover");
const transferOf = (machine: RigMachine) =>
  Object.values(machine.transfers.document.transfers).find(
    (record) => record.lineage.sourceThreadId === t1,
  );
const kinds = ["user_input", "command", "auth_refresh"] as const;
const asking = (kind: string) => ({
  id: `request:${kind}`,
  kind,
  createdAt: "2026-11-19T12:00:00.000Z",
});

const expectStayed = (rig: Rig, a: RigMachine, b: RigMachine) => {
  expect(takeovers(rig)).toHaveLength(0);
  expect(b.launches).toHaveLength(0);
  expect(a.dispatched.filter((command) => command.type === "run.interrupt")).toHaveLength(0);
  expect(a.threads.get(t1)?.activeRunId).toBe(`run:${t1}`);
  expect(a.document.threads[t1]?.lease).toMatchObject({ state: "active", epoch: 1 });
};

describe("a thread that waits on an answer", () => {
  it.effect.each(kinds)("stays when it already waits on %s, by hand too", (kind) =>
    Effect.gen(function* () {
      const rig = yield* makeRig(temporary);
      const [a, b] = rig.machines as [RigMachine, RigMachine];
      rig.addThread(a, t1, { running: true });
      a.threads.get(t1)!.pendingRuntimeRequest = asking(kind);

      const outcome = yield* a.moves
        .handOff({ threadId: t1, destinationEnvironmentId: b.environmentId })
        .pipe(Effect.result);

      expect(outcome._tag).toBe("Failure");
      if (outcome._tag === "Failure") expect(outcome.failure.message).toBe(ANSWER_FIRST);
      expectStayed(rig, a, b);
    }),
  );

  it.effect.each(kinds)("gives the hold back when %s arrives as it is taken", (kind) =>
    Effect.gen(function* () {
      const rig = yield* makeRig(temporary);
      const [a, b] = rig.machines as [RigMachine, RigMachine];
      rig.addThread(a, t1, { running: true });
      // The request arrives in the same moment the hold is written.
      a.onDocument = (document) =>
        Effect.sync(() => {
          if (document.threads[t1]?.lease?.state === "handing-off") {
            a.threads.get(t1)!.pendingRuntimeRequest = asking(kind);
          }
        });

      const outcome = yield* a.moves
        .handOff({ threadId: t1, destinationEnvironmentId: b.environmentId })
        .pipe(Effect.result);

      expect(outcome._tag).toBe("Failure");
      if (outcome._tag === "Failure") expect(outcome.failure.message).toBe(ANSWER_FIRST);
      expect(transferOf(a)?.state).toBe("stayed");
      expect(transferOf(a)?.detail).toBe(ANSWER_FIRST);
      expectStayed(rig, a, b);
    }),
  );
});
