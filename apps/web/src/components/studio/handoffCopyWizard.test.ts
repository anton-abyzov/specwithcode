import type { FolderCopyStatus } from "@specweave-studio/contracts";
import { describe, expect, it } from "vite-plus/test";
import type { CopyStage } from "./handoffCopySteps";
import {
  COPY_STEP_IDS,
  copyStepList,
  isCopyStepId,
  laterStep,
  progressStep,
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

  it("marks the live step stopped after a refused start, and only that step", () => {
    expect(stepTone("where", { ...base, stage: "setup", errored: true })).toBe("failed");
    expect(stepTone("copy", { ...base, stage: "setup", errored: true })).toBeNull();
    expect(stepTone("review", { ...base, stage: "preview", errored: true })).toBe("failed");
    expect(stepTone("where", { ...base, stage: "setup", errored: false })).toBeNull();
  });

  it("leaves a copy going fine unmarked", () => {
    expect(stepTone("copy", { ...base, stage: "copying" })).toBeNull();
    expect(stepTone("review", { ...base, stage: "preview" })).toBeNull();
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
      "The files finished copying while the window was closed. The coordinator has not moved yet.",
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
