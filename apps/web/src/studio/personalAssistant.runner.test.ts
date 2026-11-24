import { describe, expect, it } from "vite-plus/test";

import {
  personalAssistantLinkOffer,
  personalRoutineRunnerChangeNeeded,
  personalRoutineRunnerOf,
} from "./personalAssistant";

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

describe("personalAssistantLinkOffer with a stale extra row (AC-13)", () => {
  const link = {
    id: "logical:x",
    members: [{ environmentId: "m4" }, { environmentId: "m5" }],
  };
  const seat = (id: string, environmentId: string, createdAt: string, linked: boolean) => ({
    id,
    environmentId,
    createdAt,
    workspaceSettings: { kind: "personal", ...(linked ? { logicalProject: link } : {}) },
  });

  it("goes away once each machine's own assistant is linked", () => {
    expect(
      personalAssistantLinkOffer([
        seat("percy-m4", "m4", "2026-01-01T00:00:00.000Z", true),
        seat("percy-m4-extra", "m4", "2026-02-01T00:00:00.000Z", false),
        seat("percy-m5", "m5", "2026-01-01T00:00:00.000Z", true),
      ]),
    ).toBe(false);
  });

  it("stays while the machine's own (earliest) assistant is unlinked", () => {
    expect(
      personalAssistantLinkOffer([
        seat("percy-m4", "m4", "2026-01-01T00:00:00.000Z", false),
        seat("percy-m4-later", "m4", "2026-02-01T00:00:00.000Z", true),
        seat("percy-m5", "m5", "2026-01-01T00:00:00.000Z", true),
      ]),
    ).toBe(true);
  });
});
