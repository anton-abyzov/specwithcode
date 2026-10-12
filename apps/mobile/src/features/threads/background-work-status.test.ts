import { presentPendingBackgroundWork } from "@specweave-studio/client-runtime/state/thread-execution";
import type { OrchestrationV2PendingBackgroundTask } from "@specweave-studio/contracts";
import { describe, expect, it, vi } from "vite-plus/test";

import {
  BACKGROUND_WORK_SYMBOLS,
  backgroundFloatingStatus,
  type BackgroundWorkStop,
} from "./background-work-status";

const GH_COMMAND =
  "ID=$(gh run list -R octo-org/example-api --branch feat/1234-example -L 1 --json databaseId)";

function status(
  tasks: ReadonlyArray<OrchestrationV2PendingBackgroundTask>,
  stop: BackgroundWorkStop | null = null,
) {
  const presentation = presentPendingBackgroundWork(tasks);
  if (presentation === null) throw new Error("expected background work");
  return backgroundFloatingStatus(presentation, stop);
}

describe("backgroundFloatingStatus", () => {
  it("shows a shell command cut to what it runs, in monospace, without a Running label", () => {
    const pill = status([{ taskId: "watch", kind: "command", description: GH_COMMAND }]);
    expect(pill).toMatchObject({
      kind: "background",
      workKind: "command",
      label:
        "gh run list -R octo-org/example-api --branch feat/1234-example -L 1 --json databaseId",
      code: true,
      details: GH_COMMAND,
      detailsTitle: "Running in the background",
      stop: null,
    });
    expect(pill.label).not.toContain("Running");
    // Screen readers hear the full command.
    expect(pill.accessibilityLabel).toBe(`Running: ${GH_COMMAND}`);
  });

  it("reads unnamed work as a phrase, not as code, with nothing more to show", () => {
    expect(status([{ taskId: "a", kind: "command" }])).toMatchObject({
      label: "Running a command",
      code: false,
      accessibilityLabel: "Running a command",
      details: null,
    });
    expect(status([{ taskId: "a", kind: "subagent" }])).toMatchObject({
      label: "Waiting on a subagent",
      details: null,
    });
  });

  it("keeps a workflow's live progress in its details", () => {
    expect(
      status([{ taskId: "wf", kind: "workflow", description: "Ship", progress: "Phase 2" }]),
    ).toMatchObject({ label: "Ship · Phase 2", details: "Ship · Phase 2" });
  });

  it("names a single subagent or workflow without monospace", () => {
    expect(
      status([{ taskId: "a", kind: "subagent", description: "Review src/math.ts" }]),
    ).toMatchObject({
      workKind: "subagent",
      label: "Review src/math.ts",
      code: false,
      details: "Review src/math.ts",
      accessibilityLabel: "Waiting on subagent Review src/math.ts",
      detailsTitle: "Waiting on background work",
    });
  });

  it("summarises several pieces of work by count and lists each in full", () => {
    const pill = status([
      { taskId: "cmd", kind: "command", description: GH_COMMAND },
      { taskId: "dev", kind: "command", description: "vp run dev" },
      { taskId: "agent", kind: "subagent", description: "Read project" },
    ]);
    expect(pill).toMatchObject({
      workKind: "subagent",
      label: "1 subagent · 2 commands",
      code: false,
      accessibilityLabel: `Waiting on 1 subagent and 2 commands: Read project, ${GH_COMMAND}, vp run dev`,
      details: `Read project\n${GH_COMMAND}\nvp run dev`,
    });
  });

  it("passes the stop control through untouched", () => {
    const stop = { stopping: true, onStop: vi.fn() };
    expect(status([{ taskId: "a", kind: "monitor" }], stop).stop).toBe(stop);
  });

  it("has an icon for every kind", () => {
    expect(BACKGROUND_WORK_SYMBOLS).toEqual({
      subagent: "person.2",
      workflow: "point.3.connected.trianglepath.dotted",
      command: "terminal",
      monitor: "waveform.path.ecg",
      background_task: "hourglass",
    });
  });
});
