import { describe, expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Outbox from "../../../project/CoordinatorMessageOutbox.ts";
import * as Store from "../../../project/CoordinatorMessageStore.ts";
import { ProjectService } from "../../../project/ProjectService.ts";
import { ServerEnvironment } from "../../../environment/ServerEnvironment.ts";
import { HandoffPeers } from "../../../handoff/handoffPeers.ts";
import {
  body,
  COORDINATOR,
  LINUX,
  M5,
  PROJECT,
  projectOf,
  members,
} from "../../../project/CoordinatorMessageReceiver.testkit.ts";

describe("live coordinator outbox wiring", () => {
  it.effect("reuses persisted ids across tool retries and fences a remove/rejoin", () => {
    let project = projectOf(PROJECT);
    const sent: string[] = [];
    let online = true;
    const peers = Layer.succeed(HandoffPeers, {
      targets: Effect.succeed([
        { machineId: "linux-mini", environmentId: LINUX, label: "linux-mini" },
      ]),
      coordinatorMessage: (_peer: unknown, request: { messageId: string }) =>
        Effect.suspend(() => {
          sent.push(request.messageId);
          return online
            ? Effect.succeed({
                capabilities: ["coordinator-message.v1"],
                outcome: "admitted",
                messageId: request.messageId,
                count: 1,
              })
            : Effect.fail(new Error("offline"));
        }),
      coordinatorMessageReceipt: () =>
        Effect.succeed({ capabilities: ["coordinator-message.v1"], state: "settling" }),
    } as unknown as HandoffPeers["Service"]);
    const services = Layer.mergeAll(
      peers,
      Layer.succeed(ProjectService, {
        getById: () => Effect.sync(() => Option.some(project)),
      } as unknown as ProjectService["Service"]),
      Layer.succeed(ServerEnvironment, {
        getEnvironmentId: Effect.succeed(M5),
      } as unknown as ServerEnvironment["Service"]),
    );
    return Effect.gen(function* () {
      const outbox = yield* Outbox.CoordinatorMessageOutbox;
      const input = {
        projectId: PROJECT,
        threadId: COORDINATOR,
        runId: null,
        machine: "linux-mini",
        clientRequestId: "stable-request",
        message: body(),
      };
      const first = yield* outbox.send(input);
      const retry = yield* outbox.send(input);
      expect(retry.externalId).toBe(first.externalId);
      expect(sent).toEqual([first.externalId]);
      online = false;
      const queued = yield* outbox.send({ ...input, clientRequestId: "offline-request" });
      expect(queued.state).toBe("queued");
      project = projectOf(PROJECT, {
        members: members.map((member) =>
          member.environmentId === LINUX
            ? { ...member, generation: 2, linkId: "rejoined" }
            : member,
        ),
      });
      online = true;
      yield* outbox.flush;
      const rows = yield* (yield* Store.CoordinatorMessageStore).all;
      expect(rows.find((row) => row.externalId === queued.externalId)!.state).toBe("not_delivered");
      expect(sent.filter((id) => id === queued.externalId)).toHaveLength(1);
    }).pipe(
      Effect.provide(Outbox.layer.pipe(Layer.provide(services))),
      Effect.provide(Store.layerMemory()),
    );
  });
});
