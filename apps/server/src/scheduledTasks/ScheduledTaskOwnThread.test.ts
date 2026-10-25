import { ProjectId, ThreadId } from "@specweave-studio/contracts";
import { describe, expect, it } from "@effect/vitest";

import { asOwnThreadRoutine } from "./ScheduledTaskOwnThread.ts";

const projectId = ProjectId.make("project-a");
const routine = (threadId: string | null, ownThread?: boolean) => ({
  projectId,
  threadId: threadId === null ? null : ThreadId.make(threadId),
  ...(ownThread === undefined ? {} : { ownThread }),
});

describe("asOwnThreadRoutine", () => {
  it("gives a routine with no thread one of its own", () => {
    expect(asOwnThreadRoutine(routine(null), null)).toEqual(routine(null, true));
  });

  it("takes a routine off the coordinator, by default id or the project's own", () => {
    expect(asOwnThreadRoutine(routine("project-coordinator:project-a"), null)).toEqual(
      routine(null, true),
    );
    const handedOff = { id: projectId, workspaceSettings: { coordinatorThreadId: "thread-lead" } };
    expect(asOwnThreadRoutine(routine("thread-lead"), handedOff)).toEqual(routine(null, true));
  });

  it("keeps a worker thread someone bound, and an own thread already started", () => {
    expect(asOwnThreadRoutine(routine("thread-worker"), null)).toEqual(routine("thread-worker"));
    expect(asOwnThreadRoutine(routine("thread-own", true), null)).toEqual(
      routine("thread-own", true),
    );
  });
});
