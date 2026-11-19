import { describe, expect, it } from "vite-plus/test";

import { machineSendLabel } from "./machineSendLabel";

const english = (phrase: string) => phrase;

describe("machineSendLabel", () => {
  it("says what a send to another machine does", () => {
    expect(machineSendLabel(english, "Build B", null)).toBe("Send to this thread on Build B");
    expect(machineSendLabel(english, "Build B", 1)).toBe("Start a thread on Build B");
    expect(machineSendLabel(english, "Build B", 3)).toBe("Start 3 threads on Build B");
  });

  it("puts a machine's name in as it is", () => {
    expect(machineSendLabel(english, "$& {count} {machine}", 2)).toBe(
      "Start 2 threads on $& {count} {machine}",
    );
  });

  it("fills a translation whatever order its places come in", () => {
    const reordered = (phrase: string) =>
      phrase === "Start {count} threads on {machine}" ? "{machine}: {count}" : phrase;
    expect(machineSendLabel(reordered, "Build B", 2)).toBe("Build B: 2");
  });
});
