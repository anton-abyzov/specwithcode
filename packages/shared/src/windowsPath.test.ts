import { describe, expect, it } from "vite-plus/test";

import { setWindowsPath } from "./shell.ts";

describe("setWindowsPath", () => {
  it("replaces every PATH spelling while preserving unrelated variables", () => {
    const env = { Path: "old", PATH: "older", path: "oldest", pAtH: "mixed", HOME: "kept" };
    setWindowsPath(env, "C:\\Tools;C:\\Windows\\System32");
    expect(env).toEqual({ PATH: "C:\\Tools;C:\\Windows\\System32", HOME: "kept" });
  });

  it("preserves an explicit empty PATH", () => {
    const env = { Path: "C:\\Inherited" };
    setWindowsPath(env, "");
    expect(env).toEqual({ PATH: "" });
  });
});
