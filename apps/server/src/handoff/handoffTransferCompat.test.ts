// @effect-diagnostics nodeBuiltinImport:off - disposable real Git fixtures only.
/**
 * This build against the latest release, in both directions (1390). The other
 * machine's side comes from `previousRelease381.test.fixture.ts`, copied from
 * the release tag: its request and answer bodies, its takeover and heartbeat
 * rules, and what its sender does with a refusal.
 *
 * A machine on that release does not keep transfer records, so it could not
 * say what became of a takeover. Nothing moves between the two until it is
 * updated, and neither side falls back to the older exchange.
 */
import * as NodeFS from "node:fs";

import { afterEach, describe, expect, it } from "@effect/vitest";
import { HANDOFF_V2_CAPABILITY, ThreadId } from "@specweave-studio/contracts";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import * as TestClock from "effect/testing/TestClock";

import { unscopedGrant } from "../fleet/workGrantPolicy.ts";
import { continuationThreadId } from "./HandoffReceiver.ts";
import { findIncoming } from "./handoffState.ts";
import { makeRig, type RigMachine } from "./handoffTransfer.test.fixture.ts";
import { turnRefusal } from "./HandoffTurnGate.ts";
import {
  HANDOFF_PROTOCOL_VERSION,
  PEER_PATHS,
  PeerPreflightRequest,
  TakeoverRequest,
} from "./handoffWire.ts";
import {
  PREVIOUS_PEER_PATHS,
  PREVIOUS_PROTOCOL_VERSION,
  PREVIOUS_RELEASE,
  PreviousPeerPreflightRequest,
  PreviousPeerPreflightResponse,
  PreviousTakeoverRequest,
  PreviousTakeoverResponse,
  encodePreviousPreflightRequest,
  encodePreviousTakeoverRequest,
  overTheWire,
  previousMarkContinued,
  previousReadAnswer,
  previousTakeoverFailure,
  previousTakeoverVerdict,
} from "./previousRelease381.test.fixture.ts";

const temporary: Array<string> = [];
afterEach(() => {
  for (const path of temporary.splice(0)) NodeFS.rmSync(path, { recursive: true, force: true });
});

const t1 = ThreadId.make("thread:one");
const withPrevious = [{ name: "a" }, { name: "b" }, { name: "old", previous: true }];
const caller = (machine: RigMachine) => ({
  sourceEnvironmentId: machine.environmentId,
  grant: unscopedGrant(machine.environmentId),
});
const transferOf = (machine: RigMachine) => Object.values(machine.transfers.document.transfers)[0];
const leaseOf = (machine: RigMachine) => machine.document.threads[t1]?.lease ?? null;

describe(`this build with a machine on ${PREVIOUS_RELEASE}`, () => {
  it("speaks the same protocol version, and adds only paths and optional fields", () => {
    expect(HANDOFF_PROTOCOL_VERSION).toBe(PREVIOUS_PROTOCOL_VERSION);
    for (const path of PREVIOUS_PEER_PATHS) expect(PEER_PATHS.has(path)).toBe(true);
    expect([...PEER_PATHS].filter((path) => !PREVIOUS_PEER_PATHS.has(path)).sort()).toEqual([
      "transfer-pull",
      "transfer-status",
    ]);
    // The release decodes this build's bodies and drops what it does not know.
    const takeover = Schema.encodeSync(TakeoverRequest)({
      sourceEnvironmentId: "env-a" as never,
      sourceThreadId: t1,
      epoch: 2,
      sequence: 1,
      reason: "handoff",
      modelSelection: null,
      operationId: "0a1b2c3d-1111-4222-8333-444455556666",
      trigger: { kind: "automatic", key: "limit-handoff:thread:one:run-1" },
    });
    const read = Schema.decodeUnknownOption(PreviousTakeoverRequest)(
      overTheWire(takeover),
    );
    expect(Option.isSome(read)).toBe(true);
    expect(Option.getOrThrow(read)).not.toHaveProperty("operationId");
    const preflight = Schema.encodeSync(PeerPreflightRequest)({
      sourceEnvironmentId: "env-a" as never,
      protocolVersion: HANDOFF_PROTOCOL_VERSION,
      appVersion: "1.0.382",
      capabilities: [HANDOFF_V2_CAPABILITY],
      threads: [],
    });
    expect(
      Option.isSome(
        Schema.decodeUnknownOption(PreviousPeerPreflightRequest)(
          overTheWire(preflight),
        ),
      ),
    ).toBe(true);
  });

  describe("as the destination", () => {
    it.effect('reads "Needs update" and is never a target, though all its own checks pass', () =>
      Effect.gen(function* () {
        const rig = yield* makeRig(temporary, withPrevious);
        const [a, , old] = rig.machines as [RigMachine, RigMachine, RigMachine];
        rig.addThread(a, t1, { running: true });

        const checked = yield* a.moves.preflight({
          destinationEnvironmentId: old.environmentId,
          threadIds: [t1],
        });
        const failures = checked[0]?.failures ?? [];
        expect(failures.map((failure) => failure.check)).toEqual(["version"]);
        expect(failures[0]?.message.startsWith("Needs update: ")).toBe(true);
        expect(failures[0]?.message).toContain("OLD");

        const failure = yield* a.moves
          .handOff({ threadId: t1, destinationEnvironmentId: old.environmentId })
          .pipe(Effect.flip);
        expect(failure.message).toContain("Needs update: ");
        const batch = yield* a.moves.handOffMachine({
          destinationEnvironmentId: old.environmentId,
          reason: "manual",
          threadIds: [t1],
        });
        expect(batch.results.map((result) => result.outcome)).toEqual(["stayed"]);
        expect(batch.results[0]?.detail).toContain("Needs update: ");

        // Refused before the hold: the turn was never stopped, nothing was sent.
        expect(rig.callsOf("takeover")).toHaveLength(0);
        expect(old.launches).toHaveLength(0);
        expect(leaseOf(a)).toMatchObject({ state: "active", epoch: 1 });
        expect(a.threads.get(t1)?.activeRunId).not.toBeNull();
        expect(a.dispatched.filter((command) => command.type === "run.interrupt")).toHaveLength(0);
      }),
    );

    it.effect("keeps an old hold until that machine shows twice it did not continue it", () =>
      Effect.gen(function* () {
        const rig = yield* makeRig(temporary, withPrevious);
        const [a, , old] = rig.machines as [RigMachine, RigMachine, RigMachine];
        rig.addThread(a, t1);
        yield* a.moves.preflight({ destinationEnvironmentId: old.environmentId, threadIds: [t1] });
        const record = a.document.threads[t1]!;
        const sequence = record.checkpoint!.sequence;
        // The hold the release left behind: no record, and nothing kept of what it sent.
        a.document = {
          ...a.document,
          threads: {
            ...a.document.threads,
            [t1]: { ...record, lease: { ...record.lease!, state: "handing-off" } },
          },
        };

        yield* a.moves.tick;
        // It cannot answer for a transfer, so it is told the epoch: a takeover still on its
        // way is stale there from now on.
        expect(rig.callsOf("transfer-status", old)).toHaveLength(1);
        expect(findIncoming(old.document, a.environmentId, t1)?.lease.epoch).toBe(2);
        expect(leaseOf(a)?.state).toBe("handing-off");
        expect(transferOf(a)?.candidates[0]).toMatchObject({ verdict: "fenced" });
        yield* a.moves.tick;
        expect(leaseOf(a)?.state).toBe("handing-off");
        expect(turnRefusal(a.document, t1, a.environmentId)).not.toBeNull();
        const stale = previousTakeoverVerdict(
          old.document,
          {
            sourceEnvironmentId: a.environmentId,
            sourceThreadId: t1,
            epoch: 2,
            sequence,
            reason: "handoff",
            modelSelection: null,
          },
          "OLD",
        );
        expect(stale).toMatchObject({ kind: "refuse", code: "fenced" });

        // A takeover that was already running there has had time to finish.
        yield* TestClock.adjust("201 seconds");
        yield* a.moves.tick;
        expect(leaseOf(a)).toMatchObject({ state: "active", epoch: 2 });
        expect(transferOf(a)?.state).toBe("failed");
        expect(old.launches).toHaveLength(0);
      }),
    );

    it.effect("fences an old hold that machine did continue", () =>
      Effect.gen(function* () {
        const rig = yield* makeRig(temporary, withPrevious);
        const [a, , old] = rig.machines as [RigMachine, RigMachine, RigMachine];
        rig.addThread(a, t1);
        yield* a.moves.preflight({ destinationEnvironmentId: old.environmentId, threadIds: [t1] });
        const record = a.document.threads[t1]!;
        const request = {
          sourceEnvironmentId: a.environmentId,
          sourceThreadId: t1,
          epoch: 2,
          sequence: record.checkpoint!.sequence,
          reason: "handoff" as const,
          modelSelection: null,
        };
        // The release's takeover went through; its answer never reached this machine.
        const threadId = continuationThreadId(a.environmentId, t1, 2);
        old.document = previousMarkContinued(
          old.document,
          request,
          { threadId, machineLabel: "OLD", modelSelection: null, resumed: true, notice: null },
          "2026-11-19T14:00:00.000Z",
        );
        a.document = {
          ...a.document,
          threads: {
            ...a.document.threads,
            [t1]: { ...record, lease: { ...record.lease!, state: "handing-off" } },
          },
        };

        yield* a.moves.tick;

        expect(a.document.threads[t1]?.continuedOn).toMatchObject({
          environmentId: old.environmentId,
          threadId,
        });
        expect(leaseOf(a)?.state).toBe("fenced");
        expect(transferOf(a)?.state).toBe("resumed");
      }),
    );
  });

  describe("as the source", () => {
    it.effect("is refused in a check it can read, before it holds anything", () =>
      Effect.gen(function* () {
        const rig = yield* makeRig(temporary);
        const [a, b] = rig.machines as [RigMachine, RigMachine];
        rig.addThread(a, t1);
        yield* a.moves.preflight({ destinationEnvironmentId: b.environmentId, threadIds: [t1] });
        const sequence = a.document.threads[t1]!.checkpoint!.sequence;
        // The body the release sends: its versions, and no capabilities.
        const body = encodePreviousPreflightRequest({
          sourceEnvironmentId: a.environmentId,
          protocolVersion: PREVIOUS_PROTOCOL_VERSION,
          appVersion: "1.0.381",
          threads: [
            {
              sourceThreadId: t1,
              sourceProjectId: a.projectId,
              sequence,
              modelSelection: null,
            },
          ],
        });
        const request = Option.getOrThrow(
          Schema.decodeUnknownOption(PeerPreflightRequest)(overTheWire(body)),
        );

        const answer = yield* b.receiver.preflight(caller(a), request);

        // What the release makes of the answer.
        const read = previousReadAnswer(
          200,
          overTheWire(answer),
          Schema.decodeUnknownOption(PreviousPeerPreflightResponse),
        );
        expect(read.kind).toBe("ok");
        const failures = read.kind === "ok" ? (read.value.results[0]?.failures ?? []) : [];
        expect(failures.map((failure) => failure.check)).toContain("version");
        expect(failures.find((failure) => failure.check === "version")?.message).toContain(
          "Needs update: ",
        );
      }),
    );

    it.effect("gets a definite refusal for a takeover, so it runs the thread again itself", () =>
      Effect.gen(function* () {
        const rig = yield* makeRig(temporary);
        const [a, b] = rig.machines as [RigMachine, RigMachine];
        rig.addThread(a, t1);
        yield* a.moves.preflight({ destinationEnvironmentId: b.environmentId, threadIds: [t1] });
        // The body the release sends after its hold: no operation id.
        const body = encodePreviousTakeoverRequest({
          sourceEnvironmentId: a.environmentId,
          sourceThreadId: t1,
          epoch: 2,
          sequence: a.document.threads[t1]!.checkpoint!.sequence,
          reason: "handoff",
          modelSelection: null,
        });
        const request = Option.getOrThrow(
          Schema.decodeUnknownOption(TakeoverRequest)(overTheWire(body)),
        );

        const refusal = yield* b.receiver.takeover(caller(a), request).pipe(Effect.flip);

        const read = previousReadAnswer(
          refusal.status,
          { error: refusal.message, code: refusal.code, check: refusal.check },
          Schema.decodeUnknownOption(PreviousTakeoverResponse),
        );
        expect(read).toMatchObject({ kind: "refused", check: "version", uncertain: false });
        expect(read.kind === "refused" ? read.message : "").toContain("Needs update: ");
        // The release releases its hold on that, and nothing started here.
        expect(read.kind === "refused" ? previousTakeoverFailure(read) : null).toBe("released");
        expect(b.launches).toHaveLength(0);
        expect(findIncoming(b.document, a.environmentId, t1)?.continuedThreadId).toBeNull();
        expect(Object.values(b.transfers.document.acceptances)).toHaveLength(0);
      }),
    );

    it.effect("still gets the first answer when it repeats a takeover this machine did", () =>
      Effect.gen(function* () {
        const rig = yield* makeRig(temporary);
        const [a, b] = rig.machines as [RigMachine, RigMachine];
        rig.addThread(a, t1);
        yield* a.moves.preflight({ destinationEnvironmentId: b.environmentId, threadIds: [t1] });
        const request = {
          sourceEnvironmentId: a.environmentId,
          sourceThreadId: t1,
          epoch: 2,
          sequence: a.document.threads[t1]!.checkpoint!.sequence,
          reason: "handoff" as const,
          modelSelection: null,
        };
        // Continued here before this machine was updated.
        const response = {
          threadId: continuationThreadId(a.environmentId, t1, 2),
          machineLabel: "B",
          modelSelection: null,
          resumed: true,
          notice: null,
        };
        b.document = previousMarkContinued(b.document, request, response, "2026-11-19T14:00:00.000Z");

        const repeat = yield* b.receiver.takeover(caller(a), request);

        expect(repeat).toEqual(response);
        expect(b.launches).toHaveLength(0);
      }),
    );
  });
});
