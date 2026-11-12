import * as Schema from "effect/Schema";
import { describe, expect, it } from "vite-plus/test";

import { OrchestrationDispatchCommandError } from "./orchestrationDispatch.ts";
import {
  FilesystemBrowseError,
  FilesystemBrowseInput,
  FilesystemBrowseResult,
  folderNameProblem,
} from "./filesystem.ts";

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

describe("browse results for New project", () => {
  const decodeResult = Schema.decodeUnknownSync(FilesystemBrowseResult);

  it("carries the server's outcome for the browsed folder and marks folder links", () => {
    const result = decodeResult({
      parentPath: "/home/me/Projects",
      entries: [
        { name: "shared", fullPath: "/home/me/Projects/shared", kind: "folder", link: true },
      ],
      outcome: { kind: "uses", path: "/home/me/Projects/app", because: "specweave" },
    });
    expect(result.outcome).toEqual({
      kind: "uses",
      path: "/home/me/Projects/app",
      because: "specweave",
    });
    expect(result.entries[0]?.link).toBe(true);
  });

  it("decodes an older server's result with no outcome, links or permission flag", () => {
    const result = decodeResult({ parentPath: "/home/me", entries: [] });
    expect(result.outcome).toBeUndefined();
    expect(result.unreadable).toBeUndefined();
  });

  it("types an unreadable folder instead of an empty listing", () => {
    expect(decodeResult({ parentPath: "/root", entries: [], unreadable: true }).unreadable).toBe(
      true,
    );
  });

  it("accepts a project name on browse, and an input without one", () => {
    const decodeInput = Schema.decodeUnknownSync(FilesystemBrowseInput);
    expect(decodeInput({ partialPath: "~/", projectName: "My app" }).projectName).toBe("My app");
    expect(decodeInput({ partialPath: "~/" }).projectName).toBeUndefined();
  });

  it("says a missing folder is missing without reading its message", () => {
    const error = Schema.decodeUnknownSync(FilesystemBrowseError)({
      _tag: "FilesystemBrowseError",
      failure: "read_directory_failed",
      missing: true,
      message: "The folder '/gone' does not exist on this machine.",
    });
    expect(error.missing).toBe(true);
  });
});

describe("New project create failures", () => {
  const decode = Schema.decodeUnknownSync(OrchestrationDispatchCommandError);

  it("decodes each typed reason with its folder and detail", () => {
    for (const reason of [
      "parent_missing",
      "permission_denied",
      "git_missing",
      "git_init_failed",
      "name_exhausted",
      "refused",
    ] as const) {
      const error = decode({
        _tag: "OrchestrationDispatchCommandError",
        message: "Could not create the project.",
        projectCreateFailure: { reason, folder: "/home/me/Projects", detail: "fatal: nope" },
      });
      expect(error.projectCreateFailure?.reason).toBe(reason);
      expect(error.projectCreateFailure?.folder).toBe("/home/me/Projects");
    }
  });

  it("decodes an older server's message-only failure", () => {
    const error = decode({
      _tag: "OrchestrationDispatchCommandError",
      message: "Failed to create the project folder.",
    });
    expect(error.projectCreateFailure).toBeUndefined();
    expect(error.message).toBe("Failed to create the project folder.");
  });
});
