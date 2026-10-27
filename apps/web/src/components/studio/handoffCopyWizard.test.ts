import type { FolderCopySourceSummary, FolderCopyStatus } from "@specweave-studio/contracts";
import { describe, expect, it } from "vite-plus/test";
import type { CopyStage } from "./handoffCopySteps";
import {
  COPY_STEP_IDS,
  canRevisit,
  copyStepList,
  editActionFor,
  isCopyStepId,
  laterStep,
  progressStep,
  restoredView,
  resumeNote,
  stepTone,
  type CopyStepId,
} from "./handoffCopyWizard";

const copy = (overrides: Partial<FolderCopyStatus> = {}) =>
  ({
    state: "previewed",
    rows: [],
    progress: null,
    error: null,
    checks: [],
    unstable: [],
    ...overrides,
  }) as FolderCopyStatus;

const summary = {} as FolderCopySourceSummary;

describe("copyStepList", () => {
  it("is the same for one-click and choosing copies, with Transfer only for a move", () => {
    expect(copyStepList("copy-only")).toEqual(["where", "what", "review", "copy", "done"]);
    expect(copyStepList("copy-and-move")).toEqual([
      "where",
      "what",
      "review",
      "copy",
      "transfer",
      "done",
    ]);
  });

  it("recognises only its own step ids", () => {
    for (const id of COPY_STEP_IDS) expect(isCopyStepId(id)).toBe(true);
    expect(isCopyStepId("measure")).toBe(false);
    expect(isCopyStepId(undefined)).toBe(false);
  });

  it("picks the later of two steps", () => {
    expect(laterStep("what", "copy")).toBe("copy");
    expect(laterStep("done", "review")).toBe("done");
  });
});

describe("progressStep", () => {
  const cases: ReadonlyArray<[CopyStage, CopyStepId]> = [
    ["setup", "where"],
    ["scanning", "what"],
    ["select", "what"],
    ["planning", "review"],
    ["preview", "review"],
    ["copying", "copy"],
    ["failed", "copy"],
    ["moving", "transfer"],
    ["done", "done"],
    ["undone", "done"],
  ];

  it.each(cases)("maps %s to %s", (stage, step) => {
    expect(progressStep({ stage, mode: "copy-only", contextTransferred: false })).toBe(step);
  });

  it("keeps a finished move on Transfer until context transferred", () => {
    const move = { stage: "done", mode: "copy-and-move" } as const;
    expect(progressStep({ ...move, contextTransferred: false })).toBe("transfer");
    expect(progressStep({ ...move, contextTransferred: true })).toBe("done");
    expect(progressStep({ ...move, stage: "undone", contextTransferred: false })).toBe("done");
  });
});

describe("stepTone", () => {
  const base = { mode: "copy-and-move", contextTransferred: false, held: false } as const;

  it("marks a held move on Copy", () => {
    expect(stepTone("copy", { ...base, stage: "failed", held: true })).toBe("held");
    expect(stepTone("transfer", { ...base, stage: "failed", held: true })).toBeNull();
  });

  it("marks a failure before and after Apply", () => {
    expect(stepTone("copy", { ...base, stage: "failed" })).toBe("failed");
    expect(stepTone("copy", { ...base, mode: "copy-only", stage: "failed" })).toBe("failed");
  });

  it("asks for attention while a finished move waits to transfer", () => {
    expect(stepTone("transfer", { ...base, stage: "done" })).toBe("attention");
    expect(stepTone("done", { ...base, stage: "done", contextTransferred: true })).toBeNull();
    expect(stepTone("transfer", { ...base, stage: "moving" })).toBeNull();
  });

  it("leaves a copy going fine unmarked", () => {
    expect(stepTone("copy", { ...base, stage: "copying" })).toBeNull();
    expect(stepTone("review", { ...base, stage: "preview" })).toBeNull();
  });
});

describe("canRevisit", () => {
  const none = { summary: null, copy: null, contextTransferred: false };

  it("always allows Where", () => {
    expect(canRevisit("where", none)).toBe(true);
  });

  it("needs a measured summary for What", () => {
    expect(canRevisit("what", none)).toBe(false);
    expect(canRevisit("what", { ...none, summary })).toBe(true);
  });

  it("needs a compared plan for Review", () => {
    expect(canRevisit("review", { ...none, copy: copy({ state: "planned" }) })).toBe(false);
    expect(canRevisit("review", { ...none, copy: copy({ state: "scanning" }) })).toBe(false);
    expect(canRevisit("review", { ...none, copy: copy({ state: "previewed" }) })).toBe(true);
    expect(
      canRevisit("review", {
        ...none,
        copy: copy({ state: "failed", rows: [{} as FolderCopyStatus["rows"][number]] }),
      }),
    ).toBe(true);
    expect(canRevisit("review", { ...none, copy: copy({ state: "failed" }) })).toBe(false);
  });

  it("needs a copy for Copy and a transferred context for Transfer", () => {
    expect(canRevisit("copy", none)).toBe(false);
    expect(canRevisit("copy", { ...none, copy: copy({ state: "applied" }) })).toBe(true);
    expect(canRevisit("transfer", none)).toBe(false);
    expect(canRevisit("transfer", { ...none, contextTransferred: true })).toBe(true);
    expect(canRevisit("done", { summary, copy: copy(), contextTransferred: true })).toBe(false);
  });
});

describe("editActionFor", () => {
  const base = { copy: null, failedBeforeApply: false, transferRecovery: false };

  it("offers Save folder on Where only while choosing", () => {
    expect(editActionFor("where", { ...base, stage: "select" })).toBe("save-folder");
    for (const stage of ["scanning", "planning", "preview"] as const)
      expect(editActionFor("where", { ...base, stage })).toBe("change-where");
  });

  it("offers Change where and Change what only before Apply", () => {
    expect(editActionFor("what", { ...base, stage: "preview" })).toBe("rechoose");
    expect(editActionFor("what", { ...base, stage: "planning" })).toBe("rechoose");
    expect(editActionFor("what", { ...base, stage: "select" })).toBeNull();
    expect(editActionFor("what", { ...base, stage: "scanning" })).toBeNull();
    const transferring = {
      ...base,
      stage: "copying",
      copy: copy({ state: "transferring" }),
    } as const;
    expect(editActionFor("where", transferring)).toBe("change-where");
    expect(editActionFor("what", transferring)).toBe("rechoose");
    const failedEarly = { ...base, stage: "failed", failedBeforeApply: true } as const;
    expect(editActionFor("where", failedEarly)).toBe("change-where");
    expect(editActionFor("what", failedEarly)).toBe("rechoose");
    expect(editActionFor("review", { ...base, stage: "copying" })).toBeNull();
  });

  it("offers nothing while the destination applies or has applied", () => {
    for (const state of ["applying", "applied"] as const) {
      const input = { ...base, stage: "copying", copy: copy({ state }) } as const;
      expect(editActionFor("where", input)).toBeNull();
      expect(editActionFor("what", input)).toBeNull();
    }
    expect(editActionFor("where", { ...base, stage: "moving" })).toBeNull();
    expect(editActionFor("where", { ...base, stage: "setup" })).toBeNull();
  });

  it("starts a new copy with these settings after Apply, unless a transfer needs recovering", () => {
    for (const stage of ["done", "undone"] as const) {
      expect(editActionFor("where", { ...base, stage })).toBe("start-new-with-settings");
      expect(editActionFor("what", { ...base, stage })).toBeNull();
      expect(editActionFor("review", { ...base, stage })).toBeNull();
    }
    expect(editActionFor("where", { ...base, stage: "done", transferRecovery: true })).toBeNull();
  });

  it("offers nothing on a copy that failed or is held after Apply: Retry or Undo come first", () => {
    for (const failedStep of ["applying", "applied"] as const) {
      const input = {
        ...base,
        stage: "failed",
        copy: copy({ state: "failed", failedStep }),
      } as const;
      for (const id of ["where", "what", "review", "copy"] as const)
        expect(editActionFor(id, input)).toBeNull();
    }
  });
});

describe("restoredView", () => {
  const all = () => true;

  it("brings back the reviewed step while the copy is where it was (5a)", () => {
    expect(
      restoredView({
        viewed: "what",
        seen: "review",
        live: "review",
        stage: "preview",
        revisitable: all,
      }),
    ).toEqual({ view: "what", note: false });
  });

  it("does not bring back a step that has nothing to show", () => {
    expect(
      restoredView({
        viewed: "what",
        seen: "review",
        live: "review",
        stage: "preview",
        revisitable: (id) => id !== "what",
      }),
    ).toEqual({ view: null, note: false });
  });

  it("shows the live step with a note when the copy moved on (5b)", () => {
    expect(
      restoredView({
        viewed: "what",
        seen: "review",
        live: "done",
        stage: "done",
        revisitable: all,
      }),
    ).toEqual({ view: null, note: true });
  });

  it("always shows a failure, a held move or an Undo live (5c)", () => {
    for (const stage of ["failed", "undone"] as const)
      expect(
        restoredView({
          viewed: "where",
          seen: stage === "failed" ? "copy" : "done",
          live: stage === "failed" ? "copy" : "done",
          stage,
          revisitable: all,
        }),
      ).toEqual({ view: null, note: false });
  });

  it("shows the live step when the live step was on screen", () => {
    expect(
      restoredView({
        viewed: "review",
        seen: "review",
        live: "review",
        stage: "preview",
        revisitable: all,
      }),
    ).toEqual({ view: null, note: false });
  });

  it("behaves as before for a pointer without remembered steps", () => {
    expect(
      restoredView({
        viewed: undefined,
        seen: undefined,
        live: "done",
        stage: "done",
        revisitable: all,
      }),
    ).toEqual({ view: null, note: false });
  });
});

describe("resumeNote", () => {
  const base = { copy: null, held: false, sourceLabel: "M4" };

  it("says nothing when the copy did not move on, or nothing was remembered", () => {
    expect(resumeNote({ ...base, seen: "review", live: "review", stage: "preview" })).toBeNull();
    expect(resumeNote({ ...base, seen: undefined, live: "done", stage: "done" })).toBeNull();
  });

  it("names what finished while the window was closed", () => {
    expect(resumeNote({ ...base, seen: "what", live: "what", stage: "select" })).toBeNull();
    expect(resumeNote({ ...base, seen: "where", live: "what", stage: "select" })).toBe(
      "Measuring finished while the window was closed. Choose what to copy.",
    );
    expect(resumeNote({ ...base, seen: "what", live: "review", stage: "planning" })).toBe(
      "Measuring finished while the window was closed. Comparing has started.",
    );
    expect(resumeNote({ ...base, seen: "what", live: "review", stage: "preview" })).toBe(
      "Comparing finished while the window was closed. Check what would change.",
    );
    expect(resumeNote({ ...base, seen: "copy", live: "done", stage: "done" })).toBe(
      "This copy finished while the window was closed.",
    );
    expect(resumeNote({ ...base, seen: "copy", live: "transfer", stage: "done" })).toBe(
      "The files finished copying while the window was closed. Coordinator context has not transferred yet.",
    );
    expect(resumeNote({ ...base, seen: "copy", live: "done", stage: "undone" })).toBe(
      "This copy was undone while the window was closed.",
    );
  });

  it("says an automatic copy started copying, with how far it got", () => {
    const progress = {
      phase: "files",
      filesDone: 1,
      filesTotal: 2,
      bytesDone: 42,
      bytesTotal: 100,
      bytesLocal: 0,
    } as const;
    expect(
      resumeNote({
        ...base,
        seen: "what",
        live: "copy",
        stage: "copying",
        copy: copy({ state: "transferring", progress }),
      }),
    ).toBe("Comparing finished and nothing would be replaced, so copying started. 42% copied.");
    expect(resumeNote({ ...base, seen: "review", live: "copy", stage: "copying" })).toBe(
      "Copying started while the window was closed.",
    );
  });

  it("names a stopped copy and a held move", () => {
    expect(
      resumeNote({
        ...base,
        seen: "review",
        live: "copy",
        stage: "failed",
        copy: copy({ state: "failed", error: { code: "io", message: "Disk is full." } }),
      }),
    ).toBe("This copy stopped: Disk is full.");
    expect(resumeNote({ ...base, seen: "review", live: "copy", stage: "failed" })).toBe(
      "This copy stopped.",
    );
    expect(
      resumeNote({
        ...base,
        seen: "review",
        live: "copy",
        stage: "failed",
        held: true,
        copy: copy({ state: "failed", unstable: ["a.txt"] }),
      }),
    ).toBe("This move is held: some files changed on M4 while copying.");
  });
});
