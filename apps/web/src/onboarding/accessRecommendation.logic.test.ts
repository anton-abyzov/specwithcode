import { describe, expect, it } from "vite-plus/test";

import {
  machinesToSwitch,
  shouldRecommendFullAccess,
  type FullAccessRecommendationInput,
} from "./accessRecommendation.logic";

const fresh: FullAccessRecommendationInput = {
  answer: null,
  settingsKnown: true,
  machineRole: null,
  mode: "approval-required",
  projectSetsMode: false,
  fullAccessAllowed: true,
  fullAccessOffered: true,
  chatStarted: false,
};

describe("shouldRecommendFullAccess", () => {
  it("recommends it once to a new chat that would start Supervised", () => {
    expect(shouldRecommendFullAccess(fresh)).toBe(true);
    expect(shouldRecommendFullAccess({ ...fresh, machineRole: "main" })).toBe(true);
    // Any mode below Full access still stops to ask.
    expect(shouldRecommendFullAccess({ ...fresh, mode: "auto" })).toBe(true);
    expect(shouldRecommendFullAccess({ ...fresh, mode: "auto-accept-edits" })).toBe(true);
  });

  it.each([
    ["it was accepted", { answer: "accepted" }],
    ["it was declined", { answer: "declined" }],
    ["settings have not loaded", { settingsKnown: false }],
    ["the saved first-run role is joined", { machineRole: "joined" }],
    ["new chats already start on Full access", { mode: "full-access" }],
    ["the project has its own permissions setting", { projectSetsMode: true }],
    ["team rules cap access below Full access", { fullAccessAllowed: false }],
    ["the provider does not offer Full access", { fullAccessOffered: false }],
    ["the chat has started", { chatStarted: true }],
  ] as const)("does not recommend it when %s", (_reason, change) => {
    expect(shouldRecommendFullAccess({ ...fresh, ...change })).toBe(false);
  });
});

describe("machinesToSwitch", () => {
  it("lists the machines below Full access with the mode each had", () => {
    expect(
      machinesToSwitch([
        { id: "a", mode: "approval-required" },
        { id: "b", mode: "full-access" },
        { id: "c", mode: "auto" },
        // Not loaded yet: the product default.
        { id: "d", mode: null },
      ]),
    ).toEqual(
      new Map([
        ["a", "approval-required"],
        ["c", "auto"],
        ["d", "approval-required"],
      ]),
    );
  });
});
