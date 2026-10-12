import { CommandId, EventId, ProjectId } from "@specweave-studio/contracts";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as EventSink from "../orchestration-v2/EventSink.ts";

/** Replay thread creation has the same existing-project precondition as production. */
export const seedReplayProject = (id: string, workspaceRoot: string) =>
  Effect.gen(function* () {
    const projectId = ProjectId.make(id);
    const commandId = CommandId.make(`create:${id}`);
    const now = yield* DateTime.now;
    const timestamp = DateTime.formatIso(now);
    yield* (yield* EventSink.EventSinkV2).commitProjectCommand({
      commandId,
      projectId,
      commandType: "project.create",
      acceptedAt: now,
      event: {
        eventId: EventId.make(`event:${id}`),
        aggregateKind: "project",
        aggregateId: projectId,
        occurredAt: timestamp,
        commandId,
        causationEventId: null,
        correlationId: null,
        metadata: {},
        type: "project.created",
        payload: {
          projectId,
          title: id,
          workspaceRoot,
          defaultModelSelection: null,
          scripts: [],
          createdAt: timestamp,
          updatedAt: timestamp,
        },
      },
    });
  });
