// @effect-diagnostics nodeBuiltinImport:off -- A test that reads source files.
import { readdirSync, readFileSync } from "node:fs";
import { join, relative } from "node:path";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vite-plus/test";

/**
 * Role phrases Phase 1 of increment 1390 retired. The desktop menu and tray never
 * carried them; this keeps them from arriving. Exact substrings, no patterns.
 */
const RETIRED: ReadonlyArray<string> = [
  "Take over automatically",
  "Take over coordinator here",
  "Start a coordinator here",
  "This copy takes work from there",
];

const root = fileURLToPath(new URL(".", import.meta.url));
const self = fileURLToPath(import.meta.url);

function sourceFiles(dir: string): Array<string> {
  const files: Array<string> = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) {
      if (entry.name !== "node_modules") files.push(...sourceFiles(path));
    } else if (
      entry.isFile() &&
      entry.name.endsWith(".ts") &&
      !entry.name.endsWith(".test.ts") &&
      !entry.name.endsWith(".testkit.ts") &&
      path !== self
    ) {
      files.push(path);
    }
  }
  return files;
}

describe("retired desktop phrases", () => {
  it("lists only full phrases", () => {
    for (const phrase of RETIRED) expect(phrase.length, phrase).toBeGreaterThanOrEqual(20);
  });

  it("keeps every retired phrase out of apps/desktop/src", () => {
    const hits: Array<string> = [];
    for (const file of sourceFiles(root)) {
      const text = readFileSync(file, "utf8");
      for (const phrase of RETIRED) {
        if (text.includes(phrase)) hits.push(`${relative(root, file)}: ${phrase}`);
      }
    }
    expect(hits).toEqual([]);
  });
});
