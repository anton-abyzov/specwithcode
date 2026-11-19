import { describe, expect, it } from "vite-plus/test";

import { actionMachineFor, onMachineText, threadActionMachineId } from "./actionMachine";

describe("threadActionMachineId (1427 AC-07)", () => {
  it("is where the thread was handed off to, else where it lives", () => {
    expect(threadActionMachineId({ environmentId: "m4", executionMachineId: "m5" })).toBe("m5");
    expect(threadActionMachineId({ environmentId: "m4" })).toBe("m4");
  });
});

describe("actionMachineFor", () => {
  const m5 = { environmentId: "m5", name: "M5", color: "teal" } as const;
  it("names a machine that is not the window's own", () => {
    expect(actionMachineFor(m5, "m4")).toEqual({ name: "M5", color: "teal" });
  });
  it("names nothing on the window's own machine or when either is unknown", () => {
    expect(actionMachineFor(m5, "m5")).toBeNull();
    expect(actionMachineFor(m5, null)).toBeNull();
    expect(actionMachineFor(null, "m4")).toBeNull();
  });
});

describe("onMachineText", () => {
  it("ends an alert with the machine it acts on", () => {
    expect(onMachineText("Sign in to continue", "M5")).toBe("Sign in to continue on M5");
    expect(onMachineText("Sign in to continue", null)).toBe("Sign in to continue");
  });
});
