// @effect-diagnostics nodeBuiltinImport:off -- A test that reads source files.
import { readdirSync, readFileSync } from "node:fs";
import { join, relative } from "node:path";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vite-plus/test";

/**
 * Server strings Phase 1 of increment 1390 retired: the role words (a machine's
 * "copy", "Hands over", "the source" for a named machine). Each entry is the old
 * text exactly as the source had it, interpolation included, matched as a plain
 * substring so the old sentence can never come back.
 */
const RETIRED: ReadonlyArray<string> = [
  // away/AwayPlanner.ts
  "Not linked with a copy on ${facts.target.label}, so it stays here.",
  "Finishes the handover to ${facts.target.label}, which it has not confirmed yet.",
  "Hands over once ${facts.target.label} lets this machine's work into it.",
  "Hands over to ${facts.target.label}. This machine's copy steps back.",
  "Link this project with its copy on ${target.label} in the project's Machines settings.",
  "${project.title} has no linked copy on ${target.label}.",
  "Link ${project.title} with a copy on ${target.label} in the project's Machines settings.",
  // fleet/folderTransfer/reconcile.ts
  "Behind the source, with uncommitted changes here.",
  "Behind the source; moves forward to its commit.",
  "Ahead of the source; kept. Source branches arrive as",
  // mcp/toolkits/project/addToMachine.ts
  "This project already has ${listedThere} as its copy on ${machine.label}.",
  "if that copy is gone or was unlinked",
  "${machine.label} has this project as ${copy.id} at ${copy.workspaceRoot}",
  "studio_machine_list shows it as this project's copy on ${machine.label}.",
  "linking makes this project's coordinator the one for both copies.",
  // mcp/toolkits/project/remoteLaunch.ts
  "This project already names a copy on ${machine.label}, and it cannot be used now",
  "or the copy was moved or unlinked there. Do not add another copy.",
  "Do not call studio_project_add_to_machine for it: that finds this same copy.",
  "is not a copy of this project's repository that can be linked.",
  "studio_machine_list shows this project's copy there, if it has one.",
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

describe("retired server phrases", () => {
  it("lists only full phrases", () => {
    for (const phrase of RETIRED) expect(phrase.length, phrase).toBeGreaterThanOrEqual(20);
  });

  it("keeps every retired phrase out of apps/server/src", () => {
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
