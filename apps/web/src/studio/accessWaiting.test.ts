import type { EnvironmentThreadShell } from "@specweave-studio/client-runtime/state/shell";
import {
  EnvironmentId,
  RuntimeRequestId,
  ThreadId,
  type OrchestrationV2PendingAccessRequest,
} from "@specweave-studio/contracts";
import * as DateTime from "effect/DateTime";
import { describe, expect, it } from "vite-plus/test";

import { makeThreadFixture } from "../test-fixtures";
import {
  accessWaitingMachineLabel,
  accessWaitingThreads,
  pendingAccessRequest,
  remoteWorkerThreads,
} from "./accessWaiting";
import { threadStatusWord, threadTone } from "./shellModel";

const access: OrchestrationV2PendingAccessRequest = {
  accessTitle: "Use SpecWithCode",
  reason: "Capture a few clean screenshots of the app for the showcase.",
  subjects: [{ kind: "app", label: "SpecWithCode" }],
};

function waiting(
  id: string,
  options: {
    readonly access?: OrchestrationV2PendingAccessRequest;
    readonly kind?: "permission" | "command";
    readonly at?: string;
    readonly title?: string;
    readonly requestId?: string;
  } = {},
): EnvironmentThreadShell {
  const base = makeThreadFixture({ id: id as never, title: options.title ?? `Thread ${id}` });
  const pendingRuntimeRequest = {
    id: RuntimeRequestId.make(options.requestId ?? `turn-item:access-request:${id}`),
    kind: options.kind ?? "permission",
    createdAt: DateTime.makeUnsafe(options.at ?? "2026-11-04T12:00:00.000Z"),
    ...(options.access === undefined ? {} : { access: options.access }),
  };
  return {
    ...base,
    runtime: { ...base.runtime, status: "running" } as EnvironmentThreadShell["runtime"],
    hasPendingApprovals: true,
    source: { ...base.source!, status: "running", pendingRuntimeRequest },
  };
}

describe("threads waiting on an access request", () => {
  it("read as waiting for you, with their own status word", () => {
    const thread = waiting("a", { access });
    expect(threadTone(thread)).toBe("waiting");
    expect(threadStatusWord(thread)).toBe("Access requested");
    // A card whose summary lost its access block still reads as one, by its id.
    expect(threadStatusWord(waiting("c", { kind: "permission" }))).toBe("Access requested");
    // A plain permission keeps its wording.
    expect(threadStatusWord(waiting("b", { kind: "permission", requestId: "approval:b" }))).toBe(
      "Approval requested",
    );
  });

  it("list only access requests, oldest ask first, worded by the shared helpers", () => {
    const entries = accessWaitingThreads(
      [
        waiting("late", { access, at: "2026-11-04T12:05:00.000Z", title: "Later" }),
        waiting("plain"),
        waiting("early", {
          access: {
            ...access,
            reason: "To find the slow test.",
            subjects: [{ kind: "device", label: "iPhone 17 Pro" }],
          },
          at: "2026-11-04T12:01:00.000Z",
          title: "Earlier",
        }),
      ],
      () => "Anton's MacBook M4",
    );
    expect(entries.map((entry) => entry.title)).toEqual(["Earlier", "Later"]);
    expect(entries[0]).toMatchObject({
      subtitle: "Asking to control a device",
      sentence: "is waiting for you to allow access to MacBook M4, so it can find the slow test.",
    });
    expect(entries[1]?.subtitle).toBe("Asking to use apps on your computer");
    expect(pendingAccessRequest(waiting("plain"))).toBeNull();
  });

  it("names the subject's machine first, then the thread's, then this computer", () => {
    const onM1 = {
      ...access,
      subjects: [{ kind: "app" as const, label: "Xcode", hostLabel: "M1" }],
    };
    expect(accessWaitingMachineLabel(onM1, "M4")).toBe("M1");
    expect(accessWaitingMachineLabel(access, "M4")).toBe("M4");
    expect(accessWaitingMachineLabel(access, null)).toBe("this computer");
    expect(accessWaitingMachineLabel(access, "  ")).toBe("this computer");
  });

  it("include this project's workers on other machines, once each, with their host", () => {
    const m1 = EnvironmentId.make("environment-m1");
    const local = waiting("local", { access, at: "2026-11-04T12:00:00.000Z", title: "Here" });
    const remote = {
      ...waiting("remote", { access, at: "2026-11-04T12:02:00.000Z", title: "On M1" }),
      environmentId: m1,
    };
    const unrelated = { ...waiting("other", { access }), environmentId: m1 };
    const gone = { ...waiting("gone", { access }), environmentId: m1 };
    const shells = [local, remote, unrelated, gone];
    const threads = remoteWorkerThreads(shells, [
      { environmentId: m1, remoteThreadId: ThreadId.make("remote"), state: "following" },
      { environmentId: m1, remoteThreadId: ThreadId.make("gone"), state: "disposed" },
      { environmentId: m1, remoteThreadId: null, state: "launching" },
    ]);
    expect(threads).toEqual([remote]);

    const entries = accessWaitingThreads([local, ...threads, remote], (thread) =>
      thread.environmentId === m1 ? "Anton's MacBook M1" : "Anton's MacBook M4",
    );
    expect(entries.map((entry) => [entry.title, entry.thread.environmentId])).toEqual([
      ["Here", local.environmentId],
      ["On M1", m1],
    ]);
    expect(entries[1]?.sentence).toBe(
      "is waiting for you to allow access to MacBook M1, so it can capture a few clean screenshots of the app for the showcase.",
    );
    expect(remoteWorkerThreads(shells, [])).toEqual([]);
  });
});
