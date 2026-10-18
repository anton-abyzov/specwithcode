// @effect-diagnostics nodeBuiltinImport:off
import * as NodeChildProcess from "node:child_process";
import * as NodeURL from "node:url";
import { describe, expect, it } from "@effect/vitest";

import { isSqliteExperimentalWarning } from "./quietWarnings.ts";

describe("quietSqliteExperimentalWarning", () => {
  it("matches only Node's SQLite experimental notice", () => {
    const notice = "SQLite is an experimental feature and might change at any time";
    expect(isSqliteExperimentalWarning(notice, "ExperimentalWarning")).toBe(true);
    expect(isSqliteExperimentalWarning(notice, { type: "ExperimentalWarning" })).toBe(true);
    const error = Object.assign(new Error(notice), { name: "ExperimentalWarning" });
    expect(isSqliteExperimentalWarning(error, undefined)).toBe(true);
    expect(isSqliteExperimentalWarning(notice, "DeprecationWarning")).toBe(false);
    expect(
      isSqliteExperimentalWarning("WASI is an experimental feature", "ExperimentalWarning"),
    ).toBe(false);
    expect(isSqliteExperimentalWarning("something went wrong", undefined)).toBe(false);
  });

  // The photo from a MacBook Air: bare `specwithcode` printed the notice before anything else.
  it("keeps the notice off stderr when node:sqlite loads, and lets other warnings through", () => {
    const module = NodeURL.fileURLToPath(new URL("./quietWarnings.ts", import.meta.url));
    const script = [
      `const { quietSqliteExperimentalWarning } = await import(${JSON.stringify(module)});`,
      "quietSqliteExperimentalWarning();",
      'await import("node:sqlite");',
      'process.emitWarning("still visible", "UnrelatedWarning");',
    ].join("\n");
    const result = NodeChildProcess.spawnSync(
      process.execPath,
      ["--experimental-strip-types", "--input-type=module", "--eval", script],
      { encoding: "utf8" },
    );
    expect(result.status, result.stderr).toBe(0);
    expect(result.stderr).not.toContain("SQLite is an experimental feature");
    expect(result.stderr).toContain("UnrelatedWarning: still visible");
  });
});
