import type { OrchestrationV2PendingBackgroundTask } from "@specweave-studio/contracts";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vite-plus/test";

import {
  ModelPickerBackgroundWorkNote,
  pickerBackgroundWorkLabel,
} from "./ModelPickerBackgroundWorkNote";

const subagent = {
  taskId: "task-1",
  kind: "subagent",
  description: "Build redesigned Machines join card",
} as OrchestrationV2PendingBackgroundTask;
const watch = {
  taskId: "pull-request-watch:o/r#1",
  kind: "monitor",
  description: "Watching pull request #1",
} as OrchestrationV2PendingBackgroundTask;

describe("pickerBackgroundWorkLabel", () => {
  it("names the work a settled Claude thread still hosts", () => {
    expect(
      pickerBackgroundWorkLabel({ driver: "claudeAgent", working: false, tasks: [subagent] }),
    ).toBe("Waiting on subagent Build redesigned Machines join card");
  });

  it("is silent without hosted work, during a turn and for other providers", () => {
    const label = (overrides: Partial<Parameters<typeof pickerBackgroundWorkLabel>[0]>) =>
      pickerBackgroundWorkLabel({
        driver: "claudeAgent",
        working: false,
        tasks: [subagent],
        ...overrides,
      });
    expect(label({ tasks: [] })).toBeNull();
    // A pull request watch is the app's own; it holds no provider process.
    expect(label({ tasks: [watch] })).toBeNull();
    expect(label({ working: true })).toBeNull();
    expect(label({ driver: "codex" })).toBeNull();
    expect(label({ driver: null })).toBeNull();
  });
});

describe("ModelPickerBackgroundWorkNote", () => {
  it("says a pick waits for the named work", () => {
    const markup = renderToStaticMarkup(
      <ModelPickerBackgroundWorkNote work="Waiting on subagent Build redesigned Machines join card" />,
    );
    expect(markup).toContain("data-model-picker-background-work-note");
    expect(markup).toContain("Waiting on subagent Build redesigned Machines join card.");
    expect(markup).toContain("A model or effort you pick now applies when it finishes.");
  });
});
