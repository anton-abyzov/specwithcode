// @effect-diagnostics nodeBuiltinImport:off - a disposable state directory.
/**
 * The rules over the transfer records, and the file they live in: what a
 * destination answers for a lineage, when a reverse move is left out, and a
 * file that cannot be read failing every read instead of reading as empty.
 */
import * as NodeFS from "node:fs";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";

import * as NodeCrypto from "@effect/platform-node/NodeCrypto";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { afterEach, describe, expect, it } from "@effect/vitest";
import {
  EnvironmentId,
  type HandoffTransferAcceptance,
  type HandoffTransferRecord,
  ProjectId,
  ThreadId,
} from "@specweave-studio/contracts";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";

import * as ServerConfig from "../config.ts";
import {
  arrivalOf,
  claimAcceptance,
  EMPTY_HANDOFF_TRANSFER_DOCUMENT,
  HANDOFF_TRANSFER_ACCEPTANCE_MAX,
  HANDOFF_TRANSFER_FINISHED_MAX,
  HandoffTransferStore,
  layer,
  markLaunched,
  openTransfer,
  putTransfer,
  reverseMoveSuppressed,
  revokeAcceptance,
  settleLineage,
  transitionTransfer,
} from "./HandoffTransferStore.ts";

const a = EnvironmentId.make("env-a");
const b = EnvironmentId.make("env-b");
const thread = ThreadId.make("thread:one");
const now = "2026-11-19T14:00:00.000Z";
const lineage = { sourceEnvironmentId: a, sourceThreadId: thread, epoch: 2 };
const receipt = {
  threadId: ThreadId.make("handoff:continued"),
  machineLabel: "B",
  modelSelection: null,
  resumed: true,
  notice: null,
};
const claim = (
  document = EMPTY_HANDOFF_TRANSFER_DOCUMENT,
  change: Partial<Parameters<typeof claimAcceptance>[1]> = {},
) =>
  claimAcceptance(document, {
    lineage,
    operationId: "op-1",
    sequence: 4,
    receipt,
    trigger: null,
    reason: "handoff",
    modelSelection: null,
    now,
    ...change,
  });

const record = (change: Partial<HandoffTransferRecord> = {}): HandoffTransferRecord => ({
  operationId: "op-1",
  batchId: null,
  lineage,
  projectId: ProjectId.make("project-a"),
  targetEnvironmentId: b,
  sequence: 4,
  disposition: "resume",
  state: "held",
  legacy: false,
  candidates: [],
  trigger: { kind: "manual" },
  reason: "handoff",
  modelSelection: null,
  receipt: null,
  detail: null,
  createdAt: now,
  updatedAt: now,
  sentAt: null,
  ...change,
});

describe("a destination's verdict for a lineage", () => {
  it("is claimed once, repeated for the same operation, and refused for any other", () => {
    const [first, document] = claim();
    expect(first.kind).toBe("claimed");
    expect(first.acceptance).toMatchObject({ verdict: "accepted", launched: false, receipt });

    const [repeat, unchanged] = claim(document);
    expect(repeat.kind).toBe("duplicate");
    expect(repeat.acceptance.receipt).toEqual(receipt);
    expect(unchanged).toBe(document);

    // Another operation, or another checkpoint of this one: neither history changes.
    expect(claim(document, { operationId: "op-2" })[0].kind).toBe("divergent");
    expect(claim(document, { sequence: 5 })[0].kind).toBe("divergent");
    expect(claim(document, { sequence: 3 })[0].kind).toBe("divergent");
    // An older epoch of a thread this machine accepted at a newer one.
    expect(claim(document, { lineage: { ...lineage, epoch: 1 }, operationId: "op-0" })[0].kind).toBe(
      "stale",
    );
    // A newer epoch is a new lineage.
    expect(claim(document, { lineage: { ...lineage, epoch: 3 }, operationId: "op-3" })[0].kind).toBe(
      "claimed",
    );
  });

  it('answers "not accepted" for good once the source was told so', () => {
    const [refused, document] = settleLineage(EMPTY_HANDOFF_TRANSFER_DOCUMENT, {
      lineage,
      operationId: "op-1",
      now,
    });
    expect(refused.verdict).toBe("not-accepted");
    // The takeover the question overtook.
    expect(claim(document)[0].kind).toBe("not-accepted");
    expect(claim(document)[1]).toBe(document);
    // Asking again reads the same verdict.
    expect(settleLineage(document, { lineage, operationId: "op-1", now })[0]).toBe(refused);
  });

  it("answers accepted when asked about a lineage it claimed, at this epoch or a newer one", () => {
    const [, document] = claim();
    expect(settleLineage(document, { lineage, operationId: "op-1", now })[0]).toMatchObject({
      verdict: "accepted",
      operationId: "op-1",
    });
    const older = { ...lineage, epoch: 1 };
    const [verdict, unchanged] = settleLineage(document, { lineage: older, operationId: null, now });
    expect(verdict).toMatchObject({ verdict: "accepted", lineage });
    expect(unchanged).toBe(document);
  });

  it("turns a launch that failed into not accepted, and leaves a launched one alone", () => {
    const [, claimed] = claim();
    const revoked = revokeAcceptance(claimed, lineage, "no space left");
    expect(Object.values(revoked.acceptances)[0]).toMatchObject({
      verdict: "not-accepted",
      receipt: null,
      detail: "no space left",
    });
    expect(claim(revoked)[0].kind).toBe("not-accepted");

    const launched = markLaunched(claimed, lineage);
    expect(Object.values(launched.acceptances)[0]?.launched).toBe(true);
    expect(revokeAcceptance(launched, lineage, "late failure")).toBe(launched);
    expect(arrivalOf(launched, receipt.threadId)?.operationId).toBe("op-1");
    expect(arrivalOf(revoked, receipt.threadId)).toBeUndefined();
  });

  it("never drops a verdict whose launch is not finished", () => {
    let document = claim()[1];
    for (let index = 0; index < HANDOFF_TRANSFER_ACCEPTANCE_MAX + 5; index += 1) {
      const other = { ...lineage, sourceThreadId: ThreadId.make(`thread:${index}`) };
      document = claim(document, { lineage: other, now: `2026-11-20T00:00:${index % 60}.000Z` })[1];
      document = markLaunched(document, other);
    }
    expect(Object.keys(document.acceptances).length).toBeLessThanOrEqual(
      HANDOFF_TRANSFER_ACCEPTANCE_MAX,
    );
    // The oldest one is still being launched.
    expect(claim(document)[0].kind).toBe("duplicate");
  });
});

describe("a source's record of a move", () => {
  it("lets exactly one of two changes from the same state apply", () => {
    const document = putTransfer(EMPTY_HANDOFF_TRANSFER_DOCUMENT, record());
    // "Sent" and "Resume here" both start from a held record.
    const [sent, afterSend] = transitionTransfer(document, "op-1", ["held"], { state: "sent" }, now);
    expect(sent?.state).toBe("sent");
    const [resumed, afterBoth] = transitionTransfer(
      afterSend,
      "op-1",
      ["pending", "held"],
      { state: "stayed" },
      now,
    );
    expect(resumed).toBeNull();
    expect(afterBoth).toBe(afterSend);
    expect(openTransfer(afterBoth, a, thread)?.state).toBe("sent");
  });

  it("keeps every open record and only the newest finished ones", () => {
    let document = putTransfer(EMPTY_HANDOFF_TRANSFER_DOCUMENT, record({ state: "unknown" }));
    for (let index = 0; index < HANDOFF_TRANSFER_FINISHED_MAX + 20; index += 1) {
      document = putTransfer(
        document,
        record({
          operationId: `done-${index}`,
          lineage: { ...lineage, sourceThreadId: ThreadId.make(`thread:${index}`) },
          state: "resumed",
          updatedAt: `2026-11-20T00:${String(Math.floor(index / 60)).padStart(2, "0")}:${String(index % 60).padStart(2, "0")}.000Z`,
        }),
      );
    }
    expect(Object.keys(document.transfers)).toHaveLength(HANDOFF_TRANSFER_FINISHED_MAX + 1);
    expect(document.transfers["op-1"]?.state).toBe("unknown");
    expect(document.transfers["done-0"]).toBeUndefined();
  });
});

describe("an automatic move back to where a thread came from", () => {
  const arrival: HandoffTransferAcceptance = {
    ...claim(EMPTY_HANDOFF_TRANSFER_DOCUMENT, {
      trigger: { kind: "automatic", key: "limit-handoff:one:run-1", usageWindowKey: "2026-11-19T19:00:00.000Z" },
    })[0].acceptance,
  };
  const input = {
    arrival,
    destinationEnvironmentId: a,
    trigger: { kind: "automatic" as const },
    runsSinceArrival: 1,
    now: Date.parse("2026-11-19T15:00:00.000Z"),
  };

  it("is left out for the run it arrived with while the usage window has not reset", () => {
    expect(reverseMoveSuppressed(input)).toBe(true);
    expect(reverseMoveSuppressed({ ...input, runsSinceArrival: 0 })).toBe(true);
    // A window nobody named counts as not reset.
    expect(
      reverseMoveSuppressed({
        ...input,
        arrival: { ...arrival, trigger: { kind: "automatic" } },
        now: Date.parse("2027-01-01T00:00:00.000Z"),
      }),
    ).toBe(true);
  });

  it("goes ahead by hand, to another machine, on a later run, or after the reset", () => {
    expect(reverseMoveSuppressed({ ...input, trigger: { kind: "manual" } })).toBe(false);
    expect(reverseMoveSuppressed({ ...input, trigger: { kind: "pull" } })).toBe(false);
    expect(reverseMoveSuppressed({ ...input, destinationEnvironmentId: b })).toBe(false);
    expect(reverseMoveSuppressed({ ...input, runsSinceArrival: 2 })).toBe(false);
    expect(reverseMoveSuppressed({ ...input, now: Date.parse("2026-11-19T19:00:01.000Z") })).toBe(
      false,
    );
    // It arrived by hand, or did not arrive at all.
    expect(
      reverseMoveSuppressed({ ...input, arrival: { ...arrival, trigger: { kind: "manual" } } }),
    ).toBe(false);
    expect(reverseMoveSuppressed({ ...input, arrival: undefined })).toBe(false);
  });
});

describe("the transfer record file", () => {
  const temporary: Array<string> = [];
  afterEach(() => {
    for (const path of temporary.splice(0)) NodeFS.rmSync(path, { recursive: true, force: true });
  });
  const stateDirectory = () => {
    const stateDir = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "swc-transfer-store-"));
    temporary.push(stateDir);
    return stateDir;
  };
  /** A server over `stateDir`: each call is a new start reading the file again. */
  const server = <A, E>(
    stateDir: string,
    body: (store: HandoffTransferStore["Service"]) => Effect.Effect<A, E>,
  ) =>
    Effect.flatMap(HandoffTransferStore, body).pipe(
      Effect.provide(
        layer.pipe(
          Layer.provide(Layer.succeed(ServerConfig.ServerConfig, { stateDir } as never)),
          Layer.provide(Layer.mergeAll(NodeServices.layer, NodeCrypto.layer)),
        ),
      ),
    );

  it.effect("keeps a record across a restart, written before the change is visible", () =>
    Effect.gen(function* () {
      const stateDir = stateDirectory();
      yield* server(stateDir, (store) =>
        store.update((document) => [undefined, putTransfer(document, record())] as const),
      );
      expect(NodeFS.readdirSync(stateDir)).toEqual(["handoff-transfers.json"]);
      const read = yield* server(stateDir, (store) => store.read);
      expect(read.transfers["op-1"]).toEqual(record());
    }),
  );

  it.effect("fails every read and write of a file it cannot decode, and never empties it", () =>
    Effect.gen(function* () {
      const stateDir = stateDirectory();
      const file = NodePath.join(stateDir, "handoff-transfers.json");
      for (const content of ["{ not json", JSON.stringify({ version: 9, transfers: {} })]) {
        NodeFS.writeFileSync(file, content);
        const read = yield* server(stateDir, (store) => store.read).pipe(Effect.flip);
        expect(read.message).toContain("cannot read its handoff transfer records");
        // An empty answer would say "this machine accepted nothing".
        const write = yield* server(stateDir, (store) =>
          store.update((document) => [undefined, putTransfer(document, record())] as const),
        ).pipe(Effect.flip);
        expect(write.code).toBe("failed");
        expect(NodeFS.readFileSync(file, "utf8")).toBe(content);
      }
    }),
  );
});
