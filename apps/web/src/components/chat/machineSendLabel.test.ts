import { describe, expect, it } from "vite-plus/test";

import { foldedMachineSend, machineSendLabel } from "./machineSendLabel";

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

describe("foldedMachineSend", () => {
  const target = { name: "Build B", color: "blue" };
  const folded = (changes: Partial<Parameters<typeof foldedMachineSend>[0]>) =>
    foldedMachineSend({
      label: "Send message",
      plainSend: true,
      target,
      startsThreads: null,
      tx: english,
      ...changes,
    });

  it("wears the machine's color and says where a plain send goes", () => {
    expect(folded({})).toEqual({
      label: "Send to this thread on Build B",
      className: "machine-send",
      attributes: { "data-machine-color": "blue", "data-send-target": "" },
    });
    expect(folded({ startsThreads: 1 }).label).toBe("Start a thread on Build B");
    expect(folded({ startsThreads: 2 }).label).toBe("Start one thread per model on Build B");
  });

  it("stays as it is on this machine", () => {
    expect(folded({ target: null })).toEqual({
      label: "Send message",
      className: null,
      attributes: {},
    });
  });

  it.each(["Resume thread", "Send with credits", "Send message"])(
    "keeps %s and its color when the button is not a plain send",
    (label) => {
      expect(folded({ label, plainSend: false })).toEqual({
        label,
        className: null,
        attributes: {},
      });
    },
  );
});
