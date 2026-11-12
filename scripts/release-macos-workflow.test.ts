// @effect-diagnostics nodeBuiltinImport:off - Reads the workflow file as text.
import * as NodeFS from "node:fs";
import { describe, expect, it } from "vite-plus/test";
import { parse } from "yaml";

const workflow = NodeFS.readFileSync(
  new URL("../.github/workflows/release-macos.yml", import.meta.url),
  "utf8",
);

describe("release-macos.yml runner", () => {
  it("defaults to the self-hosted M1 release runner", () => {
    const parsed = parse(workflow, { uniqueKeys: true }) as {
      jobs?: Record<string, { "runs-on"?: unknown }>;
    };
    expect(parsed.jobs?.release?.["runs-on"]).toBe(
      "${{ vars.RELEASE_MACOS_RUNNER || 'swc-release' }}",
    );
  });
});

describe("release-macos.yml queueing", () => {
  const parsed = parse(workflow, { uniqueKeys: true }) as {
    concurrency?: unknown;
    jobs?: Record<string, { needs?: unknown; concurrency?: unknown; "runs-on"?: unknown }>;
  };

  it("holds the M1 for one release at a time on the release job", () => {
    expect(parsed.jobs?.release?.concurrency).toEqual({
      group: "release-macos",
      "cancel-in-progress": false,
    });
  });

  it("refuses duplicates on a hosted runner before queueing for the M1", () => {
    expect(parsed.concurrency).toBeUndefined();
    expect(parsed.jobs?.preflight?.["runs-on"]).toBe("ubuntu-24.04");
    expect(parsed.jobs?.preflight?.concurrency).toBeUndefined();
    expect(parsed.jobs?.release?.needs).toEqual(["preflight"]);
  });
});
