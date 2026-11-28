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

  it.each(["Subagent finished", 'Delegated task "X"', 'Odd " label'])(
    "leaves %s whole",
    (label) => {
      expect(splitWakeLabel(label)).toEqual({ head: label, tail: "" });
    },
  );
});
