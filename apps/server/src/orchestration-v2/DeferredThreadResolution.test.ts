import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";
import { describe, expect, it } from "@effect/vitest";
import type {
  OrchestrationV2DomainEvent,
  OrchestrationV2ThreadProjection,
} from "@specweave-studio/contracts";
import { OrchestrationV2Command, RunId } from "@specweave-studio/contracts";
import {
  DeferredResolutionActivation,
  deferredResolutionBlocked,
  invalidatesDeferredResolution,
} from "./DeferredThreadResolution.ts";

const runId = RunId.make("run:closing");
const base = () =>
  ({
    thread: { deletedAt: null, archivedAt: null, settledOverride: null, movedTo: null },
    runs: [{ id: runId, ordinal: 1, status: "completed" }],
    runtimeRequests: [],
    subagents: [],
    providerThreads: [],
    turnItems: [],
  }) as unknown as OrchestrationV2ThreadProjection;

describe("deferred resolution guards", () => {
  it("defaults activation off without any runtime or environment switch", () => {
    expect(Effect.runSync(DeferredResolutionActivation)).toBe(false);
  });
  it("keeps deferred lifecycle commands off the public wire", () => {
    const decode = Schema.decodeUnknownExit(OrchestrationV2Command);
    for (const type of [
      "thread.deferred-resolution.request",
      "thread.deferred-resolution.finish",
    ]) {
      expect(
        decode({ type, commandId: "command:external", threadId: "thread:external", runId })._tag,
      ).toBe("Failure");
    }
    const explicit = Schema.decodeUnknownSync(OrchestrationV2Command)({
      type: "thread.settle",
      commandId: "command:external",
      threadId: "thread:external",
      afterRunId: runId,
    });
    expect(explicit).not.toHaveProperty("afterRunId");
  });
  it("refuses a revoked exact run and explicit user reopen", () => {
    const projection = base();
    expect(
      deferredResolutionBlocked(
        {
          ...projection,
          thread: { ...projection.thread, deferredResolution: { runId, revoked: true } },
        },
        runId,
      ),
    ).toBe(true);
    expect(
      deferredResolutionBlocked(
        { ...projection, thread: { ...projection.thread, settledOverride: "active" } },
        runId,
      ),
    ).toBe(true);
  });
  it("accepts only an existing exact run with no pending work", () => {
    expect(deferredResolutionBlocked(base(), runId)).toBe(false);
    expect(deferredResolutionBlocked(base(), RunId.make("run:unknown"))).toBe(true);
  });
  for (const kind of ["user_input", "approval", "secret"] as const) {
    it(`refuses a pending ${kind} request`, () => {
      const projection = {
        ...base(),
        runtimeRequests: [{ kind, status: "pending" }],
      } as unknown as OrchestrationV2ThreadProjection;
      expect(deferredResolutionBlocked(projection, runId)).toBe(true);
    });
  }
  for (const status of ["idle", "pending", "running", "waiting"]) {
    it(`refuses ${status} child work`, () => {
      expect(
        deferredResolutionBlocked(
          { ...base(), subagents: [{ status }] } as unknown as OrchestrationV2ThreadProjection,
          runId,
        ),
      ).toBe(true);
    });
  }
  it("refuses a pending secret card", () => {
    expect(
      deferredResolutionBlocked(
        {
          ...base(),
          turnItems: [{ type: "secret_request", secretStatus: "pending" }],
        } as unknown as OrchestrationV2ThreadProjection,
        runId,
      ),
    ).toBe(true);
  });
  it("refuses undelivered child results and provider background work", () => {
    expect(
      deferredResolutionBlocked(
        {
          ...base(),
          subagents: [{ status: "completed", completionDelivery: { state: "pending" } }],
        } as unknown as OrchestrationV2ThreadProjection,
        runId,
      ),
    ).toBe(true);
    expect(
      deferredResolutionBlocked(
        {
          ...base(),
          providerThreads: [{ pendingBackgroundTasks: [{ kind: "subagent" }] }],
        } as unknown as OrchestrationV2ThreadProjection,
        runId,
      ),
    ).toBe(true);
  });
  it("refuses a newer run even after that run was cancelled", () => {
    const projection = base();
    expect(
      deferredResolutionBlocked(
        {
          ...projection,
          runs: [
            ...projection.runs,
            { id: RunId.make("run:new"), ordinal: 2, status: "cancelled" },
          ],
        } as OrchestrationV2ThreadProjection,
        runId,
      ),
    ).toBe(true);
  });
  for (const type of [
    "message.updated",
    "runtime-request.updated",
    "subagent.updated",
    "thread.unsettled",
    "thread.pinned",
    "thread.auto-settle-set",
  ]) {
    it(`invalidates on ${type}`, () => {
      const event = {
        type,
        payload: { role: "user", status: "pending" },
      } as unknown as OrchestrationV2DomainEvent;
      expect(invalidatesDeferredResolution(event, runId)).toBe(true);
    });
  }
  it("does not invalidate final assistant output", () => {
    expect(
      invalidatesDeferredResolution(
        {
          type: "message.updated",
          payload: { role: "assistant" },
        } as unknown as OrchestrationV2DomainEvent,
        runId,
      ),
    ).toBe(false);
  });
});
