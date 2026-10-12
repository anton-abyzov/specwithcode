// @effect-diagnostics nodeBuiltinImport:off
import * as NodeFS from "node:fs";
import * as NodePath from "node:path";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { expect, it } from "@effect/vitest";
import {
  CommandId,
  EventId,
  ProjectId,
  ThreadId,
  type ChatAttachment,
  type OrchestrationV2ConversationMessage,
} from "@specweave-studio/contracts";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Config from "../config.ts";
import * as Sqlite from "../persistence/Sqlite.ts";
import * as EventSink from "../orchestration-v2/EventSink.ts";
import * as EventStore from "../orchestration-v2/EventStore.ts";
import * as ProjectionStore from "../orchestration-v2/ProjectionStore.ts";
import * as Threads from "../orchestration-v2/ThreadManagementService.ts";
import * as Orchestrator from "../orchestration-v2/Orchestrator.ts";
import { createPendingAttachmentId, resolveAttachmentPath } from "../attachmentStore.ts";
import * as Attachments from "./ProjectCoordinatorAttachments.ts";

const projectId = ProjectId.make("attachment-project");
const threadId = ThreadId.make("project-coordinator:attachment-project");
const request = {
  projectId,
  commandId: CommandId.make("upload-request"),
  prompt: "Review these files",
};
const layerStore = Layer.merge(EventStore.layer, ProjectionStore.layer);
const layer = EventSink.layer.pipe(
  Layer.provideMerge(layerStore),
  Layer.provideMerge(Sqlite.layerMemory),
  Layer.provideMerge(
    Config.layerTest(process.cwd(), { prefix: "project-coordinator-attachments-" }),
  ),
  Layer.provideMerge(NodeServices.layer),
);
const stage = Effect.fn("test.stage")(function* (type: "image" | "file" = "image") {
  const config = yield* Config.ServerConfig;
  const attachment: ChatAttachment =
    type === "image"
      ? {
          id: createPendingAttachmentId(),
          type,
          name: "diagram.png",
          mimeType: "image/png",
          sizeBytes: 3,
        }
      : {
          id: createPendingAttachmentId("txt"),
          type,
          name: "notes.txt",
          mimeType: "text/plain",
          sizeBytes: 3,
        };
  NodeFS.mkdirSync(config.attachmentsDir, { recursive: true });
  NodeFS.writeFileSync(
    resolveAttachmentPath({ attachmentsDir: config.attachmentsDir, attachment })!,
    "abc",
  );
  return attachment;
});
const runScenario = (lostResponse: boolean) =>
  Effect.gen(function* () {
    const config = yield* Config.ServerConfig;
    const sink = yield* EventSink.EventSinkV2;
    const originals = [yield* stage(), yield* stage("file")];
    const input = { ...request, attachments: originals };
    const sending: Threads.ThreadManagementSendInput = {
      ...input,
      threadId,
      messageId: Attachments.messageId(input),
      text: input.prompt,
      commandId: CommandId.make(`coordinator-send:${projectId}:${input.commandId}`),
      mode: "queue",
      createdBy: "user",
      creationSource: "web",
    };
    let dispatched = 0;
    let delivered: ReadonlyArray<ChatAttachment> = [];
    const threads = Layer.mock(Threads.ThreadManagementService)({
      sendToThread: (value) =>
        Effect.gen(function* () {
          dispatched++;
          delivered = value.attachments;
          const now = DateTime.makeUnsafe("2026-10-09T00:00:00Z");
          const message: OrchestrationV2ConversationMessage = {
            id: value.messageId,
            threadId,
            role: "user",
            text: value.text,
            attachments: value.attachments,
            runId: null,
            nodeId: null,
            streaming: false,
            createdAt: now,
            updatedAt: now,
            createdBy: "user",
            creationSource: "web",
          };
          yield* sink.write({
            commandId: value.commandId,
            events: [
              {
                id: EventId.make("attachment-message-event"),
                type: "message.updated",
                threadId,
                occurredAt: now,
                payload: message,
              },
            ],
          });
          if (lostResponse)
            return yield* new Orchestrator.OrchestratorDispatchError({
              commandId: value.commandId,
              commandType: "message.dispatch",
              cause: new Error("Acknowledgement lost"),
            });
          return { message } as Threads.ThreadManagementSendResult;
        }).pipe(
          Effect.mapError(
            (cause) =>
              new Orchestrator.OrchestratorDispatchError({
                commandId: value.commandId,
                commandType: "message.dispatch",
                cause,
              }),
          ),
        ),
    });
    yield* Attachments.validate(input);
    const first = yield* Effect.exit(
      Attachments.send(sending).pipe(Effect.provide(EventSink.layer), Effect.provide(threads)),
    );
    expect(first._tag).toBe(lostResponse ? "Failure" : "Success");
    expect(dispatched).toBe(1);
    expect(delivered).toHaveLength(2);
    for (const attachment of delivered) {
      expect(attachment.id.startsWith("project-coordinator-attachment-project-")).toBe(true);
      expect(
        NodeFS.readFileSync(
          resolveAttachmentPath({ attachmentsDir: config.attachmentsDir, attachment })!,
          "utf8",
        ),
      ).toBe("abc");
    }
    // Simulate the upload sweep, then a restarted coordinator with fresh EventSink services
    // reading the same durable SQLite event records. No staged file remains to claim again.
    for (const attachment of originals)
      NodeFS.unlinkSync(
        resolveAttachmentPath({ attachmentsDir: config.attachmentsDir, attachment })!,
      );
    yield* Attachments.send(sending).pipe(Effect.provide(EventSink.layer), Effect.provide(threads));
    expect(dispatched).toBe(1);
    expect(NodeFS.readdirSync(config.attachmentsDir)).toHaveLength(2);
    for (const changed of [
      { ...sending, text: "Changed prompt" },
      { ...sending, senderThreadId: ThreadId.make("another-worker") },
      { ...sending, messageId: Attachments.messageId({ ...input, attachments: [originals[0]!] }) },
      { ...sending, threadId: ThreadId.make("foreign-coordinator") },
    ]) {
      const failure = yield* Attachments.send(changed).pipe(
        Effect.flip,
        Effect.provide(EventSink.layer),
        Effect.provide(threads),
      );
      expect(failure._tag).toBe("ProjectWorkspaceError");
    }
    expect(dispatched).toBe(1);
  });

it.effect(
  "delivers real staged bytes once and replays after service restart and staging expiry",
  () => runScenario(false).pipe(Effect.provide(layer)),
);
it.effect(
  "preserves committed bytes after lost acknowledgement and does not replay the user dispatch",
  () => runScenario(true).pipe(Effect.provide(layer)),
);
it.effect("rejects claimed, duplicate, unknown and empty submissions before intake", () =>
  Effect.gen(function* () {
    const pending = yield* stage();
    for (const input of [
      {
        ...request,
        attachments: [{ ...pending, id: "foreign-project-00000000-0000-4000-8000-000000000001" }],
      },
      { ...request, attachments: [pending, pending] },
      { ...request, attachments: [{ ...pending, type: "future-asset" }] },
      { ...request, prompt: "  " },
    ])
      expect((yield* Attachments.validate(input).pipe(Effect.flip))._tag).toBe(
        "ProjectWorkspaceError",
      );
    yield* Attachments.validate({ ...request, prompt: "", attachments: [pending] });
    expect(Attachments.messageId(request)).toBe(
      `coordinator-send:${projectId}:${request.commandId}`,
    );
  }).pipe(Effect.provide(layer)),
);
