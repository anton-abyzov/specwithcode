import { describe, expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Outbox from "../../../project/CoordinatorMessageOutbox.ts";
import * as Store from "../../../project/CoordinatorMessageStore.ts";
import { ProjectService } from "../../../project/ProjectService.ts";
import { ServerEnvironment } from "../../../environment/ServerEnvironment.ts";
import { HandoffPeers } from "../../../handoff/handoffPeers.ts";
import type { CoordinatorMessageRecord } from "../../../project/CoordinatorMessageStore.ts";
import {
  body,
  COORDINATOR,
  LINUX,
  M5,
  PROJECT,
  projectOf,
  members,
  outgoing,
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
            : Effect.fail(new Outbox.CoordinatorMessageOutboxError({ message: "offline" }));
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
        runId: "run-coordinator-1",
        machine: "linux-mini",
        clientRequestId: "stable-request",
        message: body({ refs: [] }),
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
      Effect.provide(
        Outbox.layer.pipe(Layer.provide(services), Layer.provideMerge(Store.layerMemory())),
      ),
    );
  });

  const refusing = (rows: CoordinatorMessageRecord[]) => {
    const sent: string[] = [];
    const services = Layer.mergeAll(
      Layer.succeed(HandoffPeers, {
        targets: Effect.succeed([
          { machineId: "linux-mini", environmentId: LINUX, label: "build box" },
        ]),
        coordinatorMessage: (_peer: unknown, request: { messageId: string }) =>
          Effect.sync(() => {
            sent.push(request.messageId);
            return {
              capabilities: ["coordinator-message.v1"],
              outcome: "admitted",
              messageId: request.messageId,
              count: 1,
            };
          }),
      } as unknown as HandoffPeers["Service"]),
      Layer.succeed(ProjectService, {
        getById: () => Effect.succeed(Option.some(projectOf(PROJECT))),
      } as unknown as ProjectService["Service"]),
      Layer.succeed(ServerEnvironment, {
        getEnvironmentId: Effect.succeed(M5),
      } as unknown as ServerEnvironment["Service"]),
    );
    return {
      sent,
      layer: Outbox.layer.pipe(
        Layer.provide(services),
        Layer.provideMerge(Store.layerMemory(rows)),
      ),
    };
  };
  const base = {
    projectId: PROJECT,
    threadId: COORDINATOR,
    runId: "run-coordinator-1",
    machine: "linux-mini",
    clientRequestId: "refused-request",
    message: body({ refs: [] }),
  };
  const incoming = (
    externalId: string,
    overrides: Partial<CoordinatorMessageRecord> = {},
  ): CoordinatorMessageRecord =>
    outgoing(externalId, "request", {
      direction: "incoming",
      outgoingMembership: undefined,
      ...overrides,
    });
  const cases: ReadonlyArray<{
    name: string;
    rows?: CoordinatorMessageRecord[];
    input: Partial<Omit<typeof base, "runId">> & { runId?: string | null };
    refusal: string;
  }> = [
    {
      name: "a send outside a running turn",
      input: { runId: null },
      refusal: "running coordinator turn",
    },
    {
      name: "a target named only by its label",
      input: { machine: "build box" },
      refusal: "Name one linked machine",
    },
    {
      name: "a report of another machine",
      input: {
        message: body({
          refs: [{ kind: "report", environmentId: LINUX, path: "reports/a.md", bytes: 10 }],
        }),
      },
      refusal: "A report reference names a report of this machine",
    },
    {
      name: "a reply to a message that never arrived",
      input: { message: body({ kind: "reply", replyTo: "unknown-message", refs: [] }) },
      refusal: "A reply must answer an incoming message",
    },
    {
      name: "a reply to a refused message",
      rows: [incoming("refused-question", { state: "refused" })],
      input: { message: body({ kind: "reply", replyTo: "refused-question", refs: [] }) },
      refusal: "never reached this coordinator",
    },
    {
      name: "a new message from a turn a message woke",
      rows: [
        incoming("waking-question", {
          state: "read",
          wokenRunId: "run-coordinator-1",
        } as Partial<CoordinatorMessageRecord>),
      ],
      input: {},
      refusal: "may only reply to that message",
    },
  ];
  it.effect.each(cases)("refuses $name and sends nothing", (testCase) => {
    const harness = refusing(testCase.rows ?? []);
    return Effect.gen(function* () {
      const outbox = yield* Outbox.CoordinatorMessageOutbox;
      const error = yield* Effect.flip(
        outbox.send({ ...base, ...testCase.input } as Parameters<typeof outbox.send>[0]),
      );
      expect(error.message).toContain(testCase.refusal);
      expect(harness.sent).toEqual([]);
      expect(
        (yield* (yield* Store.CoordinatorMessageStore).all).filter(
          (row) => row.direction === "outgoing",
        ),
      ).toEqual([]);
    }).pipe(Effect.provide(harness.layer));
  });
});
