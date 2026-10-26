import {
  EnvironmentId,
  ProjectId,
  ProviderInstanceId,
  RuntimeRequestId,
  ThreadId,
  type OrchestrationV2ThreadShell,
  type ServiceUpdateBlocker,
} from "@specweave-studio/contracts";
import * as DateTime from "effect/DateTime";
import { describe, expect, it } from "vite-plus/test";

import {
  keepLiveQuestionBlockers,
  threadsWaitingOnPerson,
  waitingKey,
} from "./liveQuestionThreads";

const environmentId = EnvironmentId.make("env-1");
const asked = DateTime.makeUnsafe("2026-10-25T20:00:00.000Z");
const later = DateTime.makeUnsafe("2026-10-25T21:00:00.000Z");
const codex = ProviderInstanceId.make("codex");

const thread = (
  id: string,
  values: Partial<OrchestrationV2ThreadShell> = {},
): OrchestrationV2ThreadShell => ({
  id: ThreadId.make(id),
  projectId: ProjectId.make("project-1"),
  title: id,
  providerInstanceId: codex,
  modelSelection: { instanceId: codex, model: "gpt-5.4" },
  runtimeMode: "full-access",
  interactionMode: "default",
  branch: null,
  worktreePath: null,
  activeProviderThreadId: null,
  lineage: { rootThreadId: ThreadId.make(id), parentThreadId: null, relationshipToParent: null },
  forkedFrom: null,
  createdBy: "user",
  creationSource: "web",
  latestRunId: null,
  activeRunId: null,
  status: "idle",
  pendingRuntimeRequest: {
    id: RuntimeRequestId.make(`${id}-q`),
    kind: "user_input",
    createdAt: asked,
  },
  latestVisibleMessage: null,
  latestUserMessageAt: null,
  hasActionableProposedPlan: false,
  itemCount: 0,
  visibleItemCount: 0,
  createdAt: asked,
  updatedAt: asked,
  archivedAt: null,
  settledOverride: null,
  settledAt: null,
  lastVisitedAt: null,
  deletedAt: null,
  ...values,
});

const request = (threadId: string | null) =>
  ({
    kind: "request",
    count: 1,
    threadId,
    threadTitle: threadId,
    projectId: null,
    projectTitle: null,
  }) as unknown as ServiceUpdateBlocker;

describe("threadsWaitingOnPerson", () => {
  it("lists only the threads Needs you shows waiting on the person", () => {
    const waiting = threadsWaitingOnPerson(environmentId, [
      thread("open"),
      thread("approval", {
        pendingRuntimeRequest: {
          id: RuntimeRequestId.make("a"),
          kind: "command",
          createdAt: asked,
        },
      }),
      thread("answered", { pendingRuntimeRequest: null }),
      thread("archived", { archivedAt: later }),
      // Resolved after the question was asked: nobody is shown it.
      thread("resolved", { settledOverride: "settled", settledAt: later }),
      // Asked after the resolve: it opens the thread again in Needs you.
      thread("reopened", { settledOverride: "settled", settledAt: DateTime.makeUnsafe(0) }),
    ]);
    expect([...waiting.keys()].toSorted()).toEqual(["approval", "open", "reopened"]);
  });

  it("changes its key when a thread starts or stops waiting", () => {
    const before = waitingKey(threadsWaitingOnPerson(environmentId, [thread("a"), thread("b")]));
    const after = waitingKey(threadsWaitingOnPerson(environmentId, [thread("a")]));
    expect(before).not.toBe(after);
    expect(waitingKey(null)).toBeNull();
  });
});

describe("keepLiveQuestionBlockers", () => {
  it("drops requests the live shell no longer shows, keeping the rest", () => {
    const run = { ...request("worker"), kind: "run" } as ServiceUpdateBlocker;
    const blockers = [request("a"), request("b"), request(null), run];
    expect(keepLiveQuestionBlockers(blockers, new Map([["a", "k"]]))).toEqual([
      request("a"),
      request(null),
      run,
    ]);
  });

  it("drops nothing without a live shell", () => {
    const blockers = [request("a")];
    expect(keepLiveQuestionBlockers(blockers, null)).toBe(blockers);
  });
});
