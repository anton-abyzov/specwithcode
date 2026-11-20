// @effect-diagnostics-next-line nodeBuiltinImport:off -- a test that reads source files.
import * as NodeFS from "node:fs";
// @effect-diagnostics-next-line nodeBuiltinImport:off -- a test that reads source files.
import * as NodePath from "node:path";
import * as NodeURL from "node:url";
import { describe, expect, it } from "vite-plus/test";

/**
 * The project's reply style (Concise or Detailed) is resolved once per turn in
 * RuntimePolicy and must reach the provider through every adapter. Each adapter
 * has its own test of the text it sends; this one fails when an adapter is
 * added, or changed, without passing the style on at all.
 */
const ADAPTERS = NodePath.join(
  NodePath.dirname(NodeURL.fileURLToPath(import.meta.url)),
  "Adapters",
);

/** Adapters that build their own instructions from the turn's runtime policy. */
const DIRECT = [
  "AcpAdapterV2.ts",
  "ClaudeAdapterV2.ts",
  "CodexAdapterV2.ts",
  "CursorAdapterV2.ts",
  "OpenCode2AdapterV2.ts",
  "OpenCodeAdapterV2.ts",
  "PiAdapterV2.ts",
];

/** Adapters that run on the ACP adapter and take its instructions. */
const THROUGH_ACP = ["AcpRegistryAdapterV2.ts", "AntigravityAdapterV2.ts", "GrokAdapterV2.ts"];

const read = (file: string) => NodeFS.readFileSync(NodePath.join(ADAPTERS, file), "utf8");

describe("reply style delivery", () => {
  it("knows every provider adapter", () => {
    const adapters = NodeFS.readdirSync(ADAPTERS)
      .filter((file) => /AdapterV2\.ts$/.test(file))
      .toSorted();
    expect(adapters).toEqual([...DIRECT, ...THROUGH_ACP].toSorted());
  });

  it.each(DIRECT)("%s passes the turn's reply style into its instructions", (file) => {
    expect(read(file)).toMatch(/runtimePolicy\s*\.responseStyle/);
  });

  it.each(THROUGH_ACP)("%s runs on the ACP adapter", (file) => {
    const source = read(file);
    expect(source).toMatch(/makeAcpAdapterV2\(/);
    // It adds no instructions of its own that could leave the style out.
    expect(source).not.toMatch(/buildRuntimeInstructions\(/);
  });
});
