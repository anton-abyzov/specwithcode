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
