import { expect, it } from "@effect/vitest";
import {
  EnvironmentId,
  OrchestratorMcpFailure,
  type OrchestrationV2ThreadShell,
  ProjectId,
  ProviderInstanceId,
  ThreadId,
} from "@specweave-studio/contracts";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";

import * as WorkGrants from "../fleet/WorkGrants.ts";
import * as ThreadManagement from "../orchestration-v2/ThreadManagementService.ts";
import * as McpInvocationContext from "./McpInvocationContext.ts";
import { explainThreadNotFound } from "./threadNotFoundHint.ts";

const AUDIT = ThreadId.make(
  "thread:delegated-task:command%3Amcp%3Ad25698a7-ed07-4574-a0b9-f1d8a6122b58%3Adelegate-task%3Aeasychamp-full-handoff-audit-20261022",
);
const GONE = ThreadId.make("thread:gone");
const LOCAL_SESSION_NAMED = ThreadId.make("session_0123456789abcdef");
const callerId = ThreadId.make("caller");
const providerInstanceId = ProviderInstanceId.make("codex");
const shell = (id: ThreadId, deletedAt: string | null = null) =>
  ({
    id,
    projectId: ProjectId.make("project"),
    providerInstanceId,
    runtimeMode: "full-access",
    interactionMode: "default",
    activeRunId: null,
    archivedAt: null,
    deletedAt,
  }) as unknown as OrchestrationV2ThreadShell;
const notFound = (id: string) =>
  new OrchestratorMcpFailure({ code: "thread_not_found", message: `Thread ${id} was not found.` });

const explain = (threadId: string, options: { readonly granted?: boolean } = {}) =>
  explainThreadNotFound(threadId, notFound(threadId)).pipe(
    Effect.provide(
      Layer.mergeAll(
        Layer.succeed(McpInvocationContext.McpInvocationContext, {
          environmentId: EnvironmentId.make("env-m4"),
          requestNamespace: "session",
          thread: { threadId: callerId, providerSessionId: "session", providerInstanceId },
          client: undefined,
          issuedAt: 0,
          capabilities: new Set(["orchestration" as const]),
        }),
        Layer.mock(ThreadManagement.ThreadManagementService)({
          getThreadShell: (id) =>
            Effect.succeed(
              id === callerId || id === AUDIT || id === LOCAL_SESSION_NAMED
                ? shell(id)
                : id === GONE
                  ? shell(id, "2026-10-23T00:00:00.000Z")
                  : null,
            ),
        }),
        Layer.succeed(WorkGrants.WorkGrants, {
          ...WorkGrants.WorkGrants.defaultValue(),
          enabled: options.granted === true,
          originOf: () =>
            Effect.succeed({ coordinatorEnvironmentId: EnvironmentId.make("env-m1") } as never),
          forCoordinator: () =>
            Effect.succeed({ coordinatorEnvironmentId: EnvironmentId.make("env-m1") } as never),
        }),
      ),
    ),
  );

it.effect("names the existing thread a near-miss ID meant", () =>
  Effect.gen(function* () {
    const answer = yield* explain(AUDIT.slice("thread:".length));
    expect(answer.code).toBe("thread_not_found");
    expect(answer.message).toContain(`Did you mean ${AUDIT}?`);
  }),
);

it.effect("suggests nothing to work started from another machine under a grant", () =>
  Effect.gen(function* () {
    const answer = yield* explain(AUDIT.slice("thread:".length), { granted: true });
    expect(answer.message).not.toContain("Did you mean");
    expect(answer.message).not.toContain(AUDIT);
  }),
);

it.effect("keeps the original answer for an exact ID whose thread was deleted", () =>
  Effect.gen(function* () {
    const answer = yield* explain(GONE);
    expect(answer.message).toBe(`Thread ${GONE} was not found.`);
  }),
);

it.effect("says a Claude projects session ID cannot be reached from here", () =>
  Effect.gen(function* () {
    for (const id of [
      "session_01RhCFc1su6eFVEQXBrw2Rjb",
      "cmsg_01A8jUDyJrsZdj1zng6pD3rHF1otS4iEnR9oY7Y69BrkZP",
    ]) {
      const answer = yield* explain(id);
      expect(answer.code).toBe("thread_not_found");
      expect(answer.message).toContain("not a SpecWithCode thread");
      expect(answer.message).toContain("Do not open a browser");
      expect(answer.message).not.toContain("studio_thread_search");
      expect((yield* explain(id, { granted: true })).message).toContain(
        "not a SpecWithCode thread",
      );
    }
  }),
);

it.effect("keeps the original answer when a thread with that ID exists here", () =>
  Effect.gen(function* () {
    const answer = yield* explain(LOCAL_SESSION_NAMED);
    expect(answer.message).toBe(`Thread ${LOCAL_SESSION_NAMED} was not found.`);
  }),
);
