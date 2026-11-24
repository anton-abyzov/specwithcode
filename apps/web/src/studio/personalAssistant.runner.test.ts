import { describe, expect, it } from "vite-plus/test";

import { personalRoutineRunnerChangeNeeded, personalRoutineRunnerOf } from "./personalAssistant";

// Fictional machines and ids.
const copy = (environmentId: string, routineOwner?: boolean) => ({
  environmentId,
  workspaceSettings: {
    coordinatorBinding: routineOwner === undefined ? {} : { routineOwner },
  },
});

describe("personalRoutineRunnerOf", () => {
  it("is the copy whose flag is on, or unset", () => {
    expect(personalRoutineRunnerOf([copy("a", false), copy("b", true)])?.environmentId).toBe("b");
    expect(personalRoutineRunnerOf([copy("a", false), copy("b")])?.environmentId).toBe("b");
  });

  it("is null after a failed change left every copy off, not the first copy", () => {
    expect(personalRoutineRunnerOf([copy("a", false), copy("b", false)])).toBeNull();
  });
});

describe("personalRoutineRunnerChangeNeeded", () => {
  it("re-arms the first copy when no machine runs the routines", () => {
    expect(personalRoutineRunnerChangeNeeded(null, "a")).toBe(true);
  });

  it("does nothing for the machine that already runs them, or an empty choice", () => {
    expect(personalRoutineRunnerChangeNeeded({ environmentId: "a" }, "a")).toBe(false);
    expect(personalRoutineRunnerChangeNeeded({ environmentId: "a" }, "")).toBe(false);
    expect(personalRoutineRunnerChangeNeeded({ environmentId: "a" }, null)).toBe(false);
    expect(personalRoutineRunnerChangeNeeded({ environmentId: "a" }, "b")).toBe(true);
  });
});
