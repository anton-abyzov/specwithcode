import { describe, expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as TestClock from "effect/testing/TestClock";
import { outgoing, PROJECT } from "./CoordinatorMessageReceiver.testkit.ts";
import {
  CoordinatorMessageStore,
  coordinatorMessageRowId,
  layerMemory,
} from "./CoordinatorMessageStore.ts";
import {
  CoordinatorMessageOutboxError,
  makeOutbox,
  COORDINATOR_MESSAGE_OUTBOX_TTL_MS,
} from "./CoordinatorMessageOutbox.ts";
import { HandoffPeerError } from "../handoff/handoffPeers.ts";

describe("coordinator message outbox", () => {
  it.effect("keeps a lost-response retry stable and persists before sending", () =>
    Effect.gen(function* () {
      const store = yield* CoordinatorMessageStore;
      const requests: string[] = [];
      const box = yield* makeOutbox({
        store,
        authorize: () => Effect.succeed(true),
        receiverProject: () => Effect.succeed(PROJECT),
        deliver: (_row, request) =>
          Effect.gen(function* () {
            expect(yield* store.all).toHaveLength(1);
            requests.push(request.clientRequestId);
            if (requests.length === 1)
              return yield* Effect.fail(
                new CoordinatorMessageOutboxError({ message: "reply lost" }),
              );
            return {
              capabilities: ["coordinator-message.v1"],
              outcome: "duplicate" as const,
              messageId: request.messageId,
              count: 1,
            };
          }),
      });
      const row = outgoing("message-outbox-test", "finding", { state: "queued" });
      const record = { ...row, id: coordinatorMessageRowId(row) };
      yield* box.enqueue(record);
      yield* box.enqueue(record);
      yield* box.flush;
      expect((yield* store.all)[0]!.state).toBe("queued");
      yield* box.flush;
      expect(requests).toEqual([record.clientRequestIds[0], record.clientRequestIds[0]]);
      expect((yield* store.all)[0]!.state).toBe("delivered");
    }).pipe(Effect.provide(layerMemory())),
  );

  it.effect("expires queued messages at 24 hours without contacting the peer", () =>
    Effect.gen(function* () {
      const store = yield* CoordinatorMessageStore;
      let sends = 0;
      const box = yield* makeOutbox({
        store,
        authorize: () => Effect.succeed(true),
        receiverProject: () => Effect.succeed(PROJECT),
        deliver: () => {
          sends++;
          return Effect.die("expired message sent");
        },
      });
      const row = outgoing("message-expiry-test", "finding", { state: "queued" });
      yield* box.enqueue({ ...row, id: coordinatorMessageRowId(row) });
      yield* TestClock.adjust(COORDINATOR_MESSAGE_OUTBOX_TTL_MS);
      yield* box.flush;
      expect(sends).toBe(0);
      expect((yield* store.all)[0]!.state).toBe("not_delivered");
    }).pipe(Effect.provide(layerMemory())),
  );
  it.effect("rechecks a grant revoked while resolving the remote project", () =>
    Effect.gen(function* () {
      const store = yield* CoordinatorMessageStore;
      let allowed = true;
      let sends = 0;
      const box = yield* makeOutbox({
        store,
        authorize: () => Effect.sync(() => allowed),
        receiverProject: () =>
          Effect.sync(() => {
            allowed = false;
            return PROJECT;
          }),
        deliver: () => {
          sends++;
          return Effect.die("revoked message sent");
        },
      });
      const row = outgoing("message-revoke-test", "finding", { state: "queued" });
      yield* box.enqueue({ ...row, id: coordinatorMessageRowId(row) });
      yield* box.flush;
      expect(sends).toBe(0);
      expect((yield* store.all)[0]!.state).toBe("not_delivered");
    }).pipe(Effect.provide(layerMemory())),
  );

  it.effect("does not accept a response from an older peer as delivery", () =>
    Effect.gen(function* () {
      const store = yield* CoordinatorMessageStore;
      const box = yield* makeOutbox({
        store,
        authorize: () => Effect.succeed(true),
        receiverProject: () => Effect.succeed(PROJECT),
        deliver: (_row, request) =>
          Effect.succeed({
            capabilities: [],
            outcome: "admitted" as const,
            messageId: request.messageId,
            count: 1,
          }),
      });
      const row = outgoing("message-old-peer", "finding", { state: "queued" });
      yield* box.enqueue({ ...row, id: coordinatorMessageRowId(row) });
      yield* box.flush;
      expect((yield* store.all)[0]!.state).toBe("queued");
    }).pipe(Effect.provide(layerMemory())),
  );
  it.effect("refuses changing content under a persisted retry key", () =>
    Effect.gen(function* () {
      const store = yield* CoordinatorMessageStore;
      const box = yield* makeOutbox({
        store,
        authorize: () => Effect.succeed(true),
        receiverProject: () => Effect.succeed(PROJECT),
        deliver: () => Effect.die("must not send"),
      });
      const row = outgoing("message-collision", "finding", { state: "queued" });
      const record = { ...row, id: coordinatorMessageRowId(row) };
      yield* box.enqueue(record);
      const error = yield* box
        .enqueue({ ...record, text: "changed private content" })
        .pipe(Effect.flip);
      expect(error.message).toContain("cannot be reused");
      expect((yield* store.all)[0]!.text).toBe(record.text);
    }).pipe(Effect.provide(layerMemory())),
  );
  it.effect("records read receipts without resending a delivered message", () =>
    Effect.gen(function* () {
      const store = yield* CoordinatorMessageStore;
      const box = yield* makeOutbox({
        store,
        authorize: () => Effect.succeed(true),
        receiverProject: () => Effect.succeed(PROJECT),
        deliver: () => Effect.die("must not resend"),
        receipt: () => Effect.succeed("read" as const),
      });
      yield* box.flush;
      expect((yield* store.all)[0]!.state).toBe("read");
    }).pipe(Effect.provide(layerMemory([outgoing("message-read-receipt", "finding")]))),
  );
  it.effect("does not downgrade an answered message during a receipt request", () =>
    Effect.gen(function* () {
      const store = yield* CoordinatorMessageStore;
      const box = yield* makeOutbox({
        store,
        authorize: () => Effect.succeed(true),
        receiverProject: () => Effect.succeed(PROJECT),
        deliver: () => Effect.die("must not resend"),
        receipt: () =>
          store.update(0, (rows) => ({
            records: rows.map((row) => ({ ...row, state: "answered" as const })),
            result: "read" as const,
          })),
      });
      yield* box.flush;
      expect((yield* store.all)[0]!.state).toBe("answered");
    }).pipe(Effect.provide(layerMemory([outgoing("message-answer-receipt", "finding")]))),
  );
  it.effect("settles a definite peer refusal and keeps its reason", () =>
    Effect.gen(function* () {
      const store = yield* CoordinatorMessageStore;
      const box = yield* makeOutbox({
        store,
        authorize: () => Effect.succeed(true),
        receiverProject: () => Effect.succeed(PROJECT),
        deliver: () =>
          Effect.fail(
            new HandoffPeerError({
              code: "needs_grant",
              message: "linux-mini refused: no grant.",
              uncertain: false,
            }),
          ),
      });
      const row = outgoing("message-refused", "finding", { state: "queued" });
      const record = { ...row, id: coordinatorMessageRowId(row) };
      yield* box.enqueue(record);
      yield* box.flush;
      expect((yield* store.all)[0]!.state).toBe("not_delivered");
      expect(box.refusal(record.id)).toBe("linux-mini refused: no grant.");
    }).pipe(Effect.provide(layerMemory())),
  );
  it.effect("keeps a message queued on a transient peer failure", () =>
    Effect.gen(function* () {
      const store = yield* CoordinatorMessageStore;
      const failures = [
        new HandoffPeerError({ code: "unreachable", message: "offline", uncertain: false }),
        new HandoffPeerError({ code: "busy", message: "busy", uncertain: false }),
        new HandoffPeerError({ code: "invalid", message: "lost", uncertain: true }),
      ];
      const box = yield* makeOutbox({
        store,
        authorize: () => Effect.succeed(true),
        receiverProject: () => Effect.succeed(PROJECT),
        deliver: () => Effect.fail(failures.shift()!),
      });
      const row = outgoing("message-transient", "finding", { state: "queued" });
      yield* box.enqueue({ ...row, id: coordinatorMessageRowId(row) });
      for (let pass = 0; pass < 3; pass++) {
        yield* box.flush;
        expect((yield* store.all)[0]!.state).toBe("queued");
      }
    }).pipe(Effect.provide(layerMemory())),
  );
  it.effect("keeps a row queued when authority cannot be read", () =>
    Effect.gen(function* () {
      const store = yield* CoordinatorMessageStore;
      let readable = true;
      const box = yield* makeOutbox({
        store,
        authorize: () =>
          readable
            ? Effect.succeed(true)
            : Effect.fail(new CoordinatorMessageOutboxError({ message: "store busy" })),
        receiverProject: () => Effect.succeed(PROJECT),
        deliver: () => Effect.die("must not send"),
      });
      const row = outgoing("message-auth-io", "finding", { state: "queued" });
      yield* box.enqueue({ ...row, id: coordinatorMessageRowId(row) });
      readable = false;
      yield* box.flush;
      expect((yield* store.all)[0]!.state).toBe("queued");
    }).pipe(Effect.provide(layerMemory())),
  );
  it.effect("stops asking for receipts once the receiver folded a message quietly", () =>
    Effect.gen(function* () {
      const store = yield* CoordinatorMessageStore;
      let asks = 0;
      const box = yield* makeOutbox({
        store,
        authorize: () => Effect.succeed(true),
        receiverProject: () => Effect.succeed(PROJECT),
        deliver: () => Effect.die("must not resend"),
        receipt: () => Effect.sync(() => (asks++, "quiet" as const)),
      });
      yield* box.flush;
      yield* box.flush;
      expect(asks).toBe(1);
      expect((yield* store.all)[0]!.state).toBe("quiet");
    }).pipe(Effect.provide(layerMemory([outgoing("message-quiet-receipt", "finding")]))),
  );
  it.effect("stops asking an older peer that has no receipt path", () =>
    Effect.gen(function* () {
      const store = yield* CoordinatorMessageStore;
      let asks = 0;
      const box = yield* makeOutbox({
        store,
        authorize: () => Effect.succeed(true),
        receiverProject: () => Effect.succeed(PROJECT),
        deliver: () => Effect.die("must not resend"),
        receipt: () =>
          Effect.suspend(() => {
            asks++;
            return Effect.fail(
              new HandoffPeerError({
                code: "invalid",
                message: "Needs update",
                uncertain: false,
                needsUpdate: true,
              }),
            );
          }),
      });
      yield* box.flush;
      yield* box.flush;
      expect(asks).toBe(1);
      expect((yield* store.all)[0]!.state).toBe("not_delivered");
    }).pipe(Effect.provide(layerMemory([outgoing("message-old-receipt", "finding")]))),
  );
});
