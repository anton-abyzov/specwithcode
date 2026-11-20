import { describe, expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import { OTHER_PROJECT, outgoing, PROJECT } from "./CoordinatorMessageReceiver.testkit.ts";
import { listCoordinatorMessages, toCoordinatorMessageView } from "./CoordinatorMessageRpc.ts";
import { layerMemory } from "./CoordinatorMessageStore.ts";

describe("projects.coordinatorMessages", () => {
  it.effect("lists one project's messages oldest first, without refused ones", () =>
    Effect.gen(function* () {
      const snapshot = yield* listCoordinatorMessages({ projectId: PROJECT });
      expect(snapshot.messages.map((message) => message.externalId)).toEqual([
        "message-first",
        "message-second",
      ]);
    }).pipe(
      Effect.provide(
        layerMemory([
          outgoing("message-second", "finding", { receivedAt: 20 }),
          outgoing("message-refused", "finding", { receivedAt: 5, state: "refused" }),
          outgoing("message-other", "finding", { receivedAt: 1, projectId: OTHER_PROJECT }),
          outgoing("message-first", "problem", { receivedAt: 10 }),
        ]),
      ),
    ),
  );

  it("never shows admission or membership bookkeeping", () => {
    const view = toCoordinatorMessageView(
      outgoing("message-view", "reply", {
        outgoingMembership: "membership-secret",
        receiverMessageId: "message-on-linux",
        sourceRunId: "run-1",
      }),
    );
    expect(view).not.toHaveProperty("outgoingMembership");
    expect(view).not.toHaveProperty("clientRequestIds");
    expect(view).not.toHaveProperty("dedupeKey");
    expect(view).not.toHaveProperty("logicalProjectId");
    expect(view).toMatchObject({
      receiverMessageId: "message-on-linux",
      replyTo: "message-from-linux",
      sourceRunId: "run-1",
    });
  });
});
