import { describe, expect, it } from "vite-plus/test";

import {
  actionMachineAt,
  actionMachineFor,
  onMachineText,
  threadActionMachineId,
} from "./actionMachine";

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

// A control names the machine its callback acts on (1427 AC-07, review of 6f87dcfc).
describe("actionMachineAt", () => {
  const nicknames: Record<string, string> = { a: "M4" };
  const labels: Record<string, string> = { a: "studio-host", b: "build-box" };
  const identityOf = (id: string, fallback?: string | null) => ({
    environmentId: id,
    name: nicknames[id] ?? fallback ?? id,
    color: "teal" as const,
  });
  const labelOf = (id: string) => labels[id];

  it("names the dispatched machine when window, serving and execution machines all differ", () => {
    // Window on W views A's copy of a thread handed off to B: answers still go to A.
    const thread = { environmentId: "a", executionMachineId: "b" };
    expect(
      actionMachineAt({
        dispatchEnvironmentId: thread.environmentId,
        windowEnvironmentId: "w",
        identityOf,
        labelOf,
      }),
    ).toEqual({ name: "M4", color: "teal" });
  });

  it("falls back to the selected machine's own label, never another's", () => {
    expect(
      actionMachineAt({ dispatchEnvironmentId: "b", windowEnvironmentId: "a", identityOf, labelOf }),
    ).toEqual({ name: "build-box", color: "teal" });
  });

  it("names nothing when the dispatched machine is the window's own", () => {
    expect(
      actionMachineAt({ dispatchEnvironmentId: "a", windowEnvironmentId: "a", identityOf, labelOf }),
    ).toBeNull();
  });
});
