import * as Schema from "effect/Schema";
import { describe, expect, it } from "vite-plus/test";

import { FilesystemBrowseError, folderNameProblem } from "./filesystem.ts";

describe("folderNameProblem", () => {
  it("accepts one ordinary folder name", () => {
    for (const name of ["clients", " spaced name ", ".config", "a.b", "über"]) {
      expect(folderNameProblem(name)).toBeNull();
    }
  });

  it("refuses names that are empty, a path, or too long", () => {
    for (const name of ["", "   ", ".", "..", "a/b", "a\\b", "../x", "a\u0000b", "x".repeat(256)]) {
      expect(folderNameProblem(name)).not.toBeNull();
    }
    expect(folderNameProblem("x".repeat(255))).toBeNull();
    // Counted in bytes, the way file systems do.
    expect(folderNameProblem("ü".repeat(128))).not.toBeNull();
  });

  it("adds what Windows refuses only for a Windows host", () => {
    for (const name of ["a:b", "what?", "a*b", "con", "NUL", "com1.txt", "trailing."]) {
      expect(folderNameProblem(name, true)).not.toBeNull();
      expect(folderNameProblem(name)).toBeNull();
    }
    expect(folderNameProblem("console", true)).toBeNull();
  });
});

describe("FilesystemBrowseError", () => {
  it("derives a stable message from browse context while retaining the cause", () => {
    const cause = new Error("sensitive filesystem detail");
    const error = new FilesystemBrowseError({
      cwd: "/workspace",
      partialPath: "./src/mai",
      failure: "read_directory_failed",
      parentPath: "/workspace/src",
      cause,
    });

    expect(error.message).toBe("Failed to browse filesystem path './src/mai' from '/workspace'.");
    expect(error.message).not.toContain(cause.message);
    expect(error.cause).toBe(cause);
  });

  it("keeps the server's own words for what went wrong", () => {
    const error = new FilesystemBrowseError({
      partialPath: "/missing/",
      failure: "read_directory_failed",
      parentPath: "/missing",
      message: "The folder '/missing' does not exist on this machine.",
    });
    expect(error.message).toBe("The folder '/missing' does not exist on this machine.");
  });

  it("decodes legacy message-only errors during rolling upgrades", () => {
    const decodeError = Schema.decodeUnknownSync(FilesystemBrowseError);
    const error = decodeError({
      _tag: "FilesystemBrowseError",
      message: "Legacy filesystem browse failure.",
    });

    expect(error.message).toBe("Legacy filesystem browse failure.");
    expect(error.partialPath).toBeUndefined();
    expect(error.failure).toBeUndefined();
  });
});
