import { describe, expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as TestClock from "effect/testing/TestClock";
import { outgoing, PROJECT } from "./CoordinatorMessageReceiver.testkit.ts";
import {
  CoordinatorMessageStore,
  coordinatorMessageRowId,
  layerMemory,
} from "./CoordinatorMessageStore.ts";
import { makeOutbox, COORDINATOR_MESSAGE_OUTBOX_TTL_MS } from "./CoordinatorMessageOutbox.ts";

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
            if (requests.length === 1) return yield* Effect.fail(new Error("reply lost"));
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
});
