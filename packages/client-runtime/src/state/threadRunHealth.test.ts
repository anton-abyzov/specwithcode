import {
  EnvironmentId,
  RunId,
  RuntimeRequestId,
  type OrchestrationV2ThreadShell,
} from "@specweave-studio/contracts";
import * as DateTime from "effect/DateTime";
import { describe, expect, it } from "vite-plus/test";

import { presentThreadShell, threadAwaitingPerson, threadRunHealth } from "./models.ts";
import { v2Now, v2ThreadShell } from "./orchestrationV2TestFixtures.ts";

const environmentId = EnvironmentId.make("environment-1");
const hours = (count: number) => count * 60 * 60_000;
const nowMs = DateTime.toEpochMillis(v2Now) + hours(15);

/** A Codex worker whose run has been quiet since it asked for something at v2Now. */
function quietRunningThread(
  pendingRuntimeRequest: OrchestrationV2ThreadShell["pendingRuntimeRequest"],
) {
  return presentThreadShell(environmentId, {
    ...v2ThreadShell,
    latestRunId: RunId.make("run-1"),
    activeRunId: RunId.make("run-1"),
    status: "running",
    pendingRuntimeRequest,
    activeWork: { label: "pnpm install", startedAt: v2Now },
  });
}

const request = (
  kind: NonNullable<OrchestrationV2ThreadShell["pendingRuntimeRequest"]>["kind"],
) => ({
  id: RuntimeRequestId.make("request-1"),
  kind,
  createdAt: v2Now,
});

describe("threadRunHealth", () => {
  it("reads a worker held 15 hours on a command approval as waiting on you, never stalled", () => {
    expect(threadRunHealth(quietRunningThread(request("command")), nowMs)).toEqual({
      state: "waiting",
      idleMs: hours(15),
      label: "your approval",
      waitingMs: hours(15),
      awaitingPerson: "approval",
    });
  });

  it("reads an open question and a sign-in as waiting on you too", () => {
    expect(threadRunHealth(quietRunningThread(request("user_input")), nowMs)).toMatchObject({
      state: "waiting",
      label: "your answer",
    });
    expect(threadRunHealth(quietRunningThread(request("auth_refresh")), nowMs)).toMatchObject({
      state: "waiting",
      label: "your sign-in",
    });
  });

  it("still calls the same quiet run stalled once nothing is asked of the person", () => {
    expect(threadRunHealth(quietRunningThread(null), nowMs)).toMatchObject({
      state: "stalled",
      label: "pnpm install",
    });
  });

  it("goes by the shell flags when the thread carries no request summary", () => {
    const { source: _source, ...withoutSource } = quietRunningThread(null);
    expect(threadRunHealth({ ...withoutSource, hasPendingApprovals: true }, nowMs)).toMatchObject({
      state: "waiting",
      awaitingPerson: "approval",
      waitingMs: hours(15),
    });
  });

  it("reads every approval kind as your approval", () => {
    for (const kind of [
      "command",
      "file-read",
      "file-change",
      "permission",
      "mcp-elicitation",
    ] as const) {
      expect(threadRunHealth(quietRunningThread(request(kind)), nowMs)).toMatchObject({
        state: "waiting",
        label: "your approval",
        awaitingPerson: "approval",
      });
    }
  });

  it("does not read a dynamic tool call the app answers as waiting on you", () => {
    const thread = quietRunningThread(request("dynamic_tool_call"));
    // Nothing for the person to answer, so Needs you shows no approval either.
    expect(thread.hasPendingApprovals).toBe(false);
    expect(thread.hasPendingUserInput).toBe(false);
    expect(threadAwaitingPerson(thread)).toBeNull();
    const health = threadRunHealth(thread, nowMs);
    expect(health).toMatchObject({ state: "stalled", label: "pnpm install" });
    expect(health).not.toHaveProperty("awaitingPerson");
  });
});

describe("presentThreadShell hasPendingApprovals", () => {
  it("flags exactly the kinds threadAwaitingPerson reads as an approval", () => {
    for (const kind of [
      "command",
      "file-read",
      "file-change",
      "permission",
      "mcp-elicitation",
      "user_input",
      "auth_refresh",
      "dynamic_tool_call",
    ] as const) {
      const thread = quietRunningThread(request(kind));
      expect(thread.hasPendingApprovals, kind).toBe(
        threadAwaitingPerson(thread)?.kind === "approval",
      );
    }
    expect(quietRunningThread(null).hasPendingApprovals).toBe(false);
  });
});

describe("threadAwaitingPerson", () => {
  it("names what each request kind asks of the person", () => {
    const kindOf = (kind: Parameters<typeof request>[0]) =>
      threadAwaitingPerson(quietRunningThread(request(kind)))?.kind ?? null;
    expect(kindOf("command")).toBe("approval");
    expect(kindOf("file-read")).toBe("approval");
    expect(kindOf("file-change")).toBe("approval");
    expect(kindOf("permission")).toBe("approval");
    expect(kindOf("mcp-elicitation")).toBe("approval");
    expect(kindOf("user_input")).toBe("answer");
    expect(kindOf("auth_refresh")).toBe("sign-in");
    expect(kindOf("dynamic_tool_call")).toBeNull();
    expect(threadAwaitingPerson(quietRunningThread(null))).toBeNull();
  });

  it("keeps a stalled turn stalled while messages queued behind it bump the thread", () => {
    // Child threads reported a minute ago (updatedAt), but the run itself has
    // sent nothing for two and a half hours.
    const thread = presentThreadShell(environmentId, {
      ...v2ThreadShell,
      latestRunId: RunId.make("run-1"),
      activeRunId: RunId.make("run-1"),
      status: "running",
      pendingRuntimeRequest: null,
      activeWork: null,
      activeRunActivityAt: v2Now,
      updatedAt: DateTime.makeUnsafe(nowMs - 60_000),
    });
    expect(threadRunHealth(thread, nowMs)).toMatchObject({
      state: "stalled",
      idleMs: hours(15),
    });
    // A server that does not report run activity keeps the old clock.
    const { activeRunActivityAt: _omit, ...older } = thread;
    expect(threadRunHealth(older, nowMs)).toMatchObject({ state: "working", idleMs: 60_000 });
  });
});
