import { describe, expect, it } from "vite-plus/test";
import { splitWakeLabel } from "./wakeLabel.ts";

describe("splitWakeLabel", () => {
  it("keeps the outcome words apart from the quoted title", () => {
    expect(splitWakeLabel('Delegated task "Review the long plan" finished')).toEqual({
      head: 'Delegated task "Review the long plan"',
      tail: " finished",
    });
  });

  it("splits at the last quote when the title holds quotes", () => {
    expect(splitWakeLabel('Background command "echo "hi"" completed')).toEqual({
      head: 'Background command "echo "hi""',
      tail: " completed",
    });
  });

  it("keeps the exit code with the outcome", () => {
    expect(splitWakeLabel('Background command "npm test" finished (exit 130)')).toEqual({
      head: 'Background command "npm test"',
      tail: " finished (exit 130)",
    });
  });

  it.each([
    "Subagent finished",
    'Delegated task "X"',
    'Odd " label',
    '2 delegated tasks finished: Review "the plan", Beta task with a long name',
    '2 of 5 delegated tasks finished: Review "the plan" carefully and then the rest of it',
  ])("leaves %s whole", (label) => {
    expect(splitWakeLabel(label)).toEqual({ head: label, tail: "" });
  });
});
