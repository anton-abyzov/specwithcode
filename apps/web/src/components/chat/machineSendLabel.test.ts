import { describe, expect, it } from "vite-plus/test";

import { machineSendLabel } from "./machineSendLabel";

const english = (phrase: string) => phrase;

describe("machineSendLabel", () => {
  it("says what a send to another machine does", () => {
    expect(machineSendLabel(english, "Build B", null)).toBe("Send to this thread on Build B");
    expect(machineSendLabel(english, "Build B", 1)).toBe("Start a thread on Build B");
    expect(machineSendLabel(english, "Build B", 2)).toBe(
      "Start one thread per model on Build B",
    );
    expect(machineSendLabel(english, "Build B", 5)).toBe(
      "Start one thread per model on Build B",
    );
  });

  it("puts a machine's name in as it is", () => {
    expect(machineSendLabel(english, "$& {machine}", 1)).toBe("Start a thread on $& {machine}");
  });
});
