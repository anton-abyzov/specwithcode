import { describe, expect, it } from "vite-plus/test";
import { handoffErrorMarksStep, plainHandoffError } from "./handoffErrors";

const places = { source: "M4", destination: "ministorm" };

describe("plainHandoffError", () => {
  it("names the machine and where a linked working folder leads, without jargon", () => {
    expect(
      plainHandoffError(
        "The copy failed on this machine: Private folder resolves elsewhere: /Users/me/.specwithcode/staging -> /Volumes/X/staging",
        "move",
        places,
      ),
    ).toBe(
      "SpecWithCode's working folder on ministorm (/Users/me/.specwithcode/staging) leads to /Volumes/X/staging through a shortcut, so the move can't start. Use a normal folder that isn't a shortcut or inside one, then try again.",
    );
    // An older server names only the folder; nothing says which machine raised it.
    expect(plainHandoffError("Private folder resolves elsewhere: /a/b", "copy")).toBe(
      "SpecWithCode's working folder (/a/b) is behind a shortcut, so the copy can't start. Use a normal folder that isn't a shortcut or inside one, then try again.",
    );
    const text = plainHandoffError("Private folder resolves elsewhere.", "copy");
    expect(text).not.toMatch(/staging|another drive|Replace it/);
  });

  it("says what a file error means and what to try", () => {
    expect(plainHandoffError("EACCES: permission denied, mkdir '/Volumes/X/app'")).toBe(
      "SpecWithCode can't write to /Volumes/X/app. Check its permissions, then try again.",
    );
    expect(
      plainHandoffError("The copy failed. ENOSPC: no space left on device, write", "copy"),
    ).toBe("The disk is full, so the copy stopped. Free some space, then try again.");
    expect(plainHandoffError("ENOENT: no such file or directory, open '/x/y'", "move")).toBe(
      "/x/y doesn't exist. Choose another folder, then move again.",
    );
  });

  it("adds a next step naming the machines to an error with no mapping", () => {
    expect(plainHandoffError("The copy failed: socket hang up", "move", places)).toBe(
      "The move stopped: socket hang up. Try again. If it happens again, check that M4 and ministorm are both online.",
    );
    expect(plainHandoffError("The source folder cannot be read.", "move", places)).toBe(
      "The source folder cannot be read. Check that M4 can open the project's folder, then try again.",
    );
    expect(plainHandoffError("The copy failed. The destination went offline.", "copy")).toBe(
      "The copy stopped. The destination went offline. Try again. If it happens again, check that this machine and the other machine are both online.",
    );
  });

  it("says the connection dropped while moving, in a move's own words", () => {
    expect(plainHandoffError("The copy connection was interrupted.", "move", places)).toBe(
      "The connection dropped while moving files. Try again. If it happens again, check that M4 and ministorm are both online.",
    );
    expect(plainHandoffError("The copy connection was interrupted.", "copy")).toMatch(
      /^The connection dropped while copying files\./,
    );
  });

  it("never calls an unrecognised error (such as a failed status check) stopped", () => {
    const text = plainHandoffError("fetch failed", "copy", places);
    expect(text).not.toContain("stopped");
    expect(text).toBe(
      "Something went wrong: fetch failed. Try again. If it happens again, check that M4 and ministorm are both online.",
    );
  });

  it("keeps a sentence that already says what to do", () => {
    expect(plainHandoffError("Choose an empty folder on ministorm.")).toBe(
      "Choose an empty folder on ministorm.",
    );
    expect(plainHandoffError("Source changed. Review the new commits.", "move", places)).toBe(
      "Source changed. Review the new commits.",
    );
  });
});

describe("handoffErrorMarksStep", () => {
  it("marks the step for a recognised refusal, or any error while starting or choosing", () => {
    expect(handoffErrorMarksStep("The copy failed: socket hang up", "copying")).toBe(true);
    expect(handoffErrorMarksStep("EACCES: permission denied, mkdir '/x'", "copying")).toBe(true);
    expect(handoffErrorMarksStep("Choose an empty folder on ministorm.", "setup")).toBe(true);
  });

  it("leaves the step alone for a status check that failed while the machines work", () => {
    expect(handoffErrorMarksStep("fetch failed", "copying")).toBe(false);
  });

  it("never marks Where red for a problem with the source folder", () => {
    expect(handoffErrorMarksStep("The source folder cannot be read.", "setup")).toBe(false);
  });
});
