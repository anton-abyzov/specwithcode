import { describe, expect, it } from "vite-plus/test";

import { isPlaceholderStepText, summarizePlanSteps } from "./planProgress.ts";

describe("isPlaceholderStepText", () => {
  it("matches only titles a spec template left unfilled", () => {
    expect(isPlaceholderStepText("[First task]")).toBe(true);
    expect(isPlaceholderStepText(" T-02 [Second task] ")).toBe(true);
    expect(isPlaceholderStepText("T-03: [Task title]")).toBe(true);
    expect(isPlaceholderStepText("Fix [First task] rendering")).toBe(false);
    expect(isPlaceholderStepText("[WIP] Write the reader")).toBe(false);
    expect(isPlaceholderStepText("Write the reader")).toBe(false);
  });
});

describe("summarizePlanSteps", () => {
  it("counts placeholder steps but never names them", () => {
    expect(
      summarizePlanSteps([
        { text: "Read", state: "done" },
        { text: "[Second task]", state: "open" },
        { text: "Write", state: "open" },
      ]),
    ).toEqual({ completed: 1, total: 3, current: null, next: "Write" });
  });
});
