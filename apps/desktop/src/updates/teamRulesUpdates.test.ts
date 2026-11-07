// @effect-diagnostics nodeBuiltinImport:off - writes candidate rules files to a temporary folder.
import * as NodeFS from "node:fs";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";

import { afterEach, describe, expect, it } from "vite-plus/test";

import { readTeamRulesUpdatePolicy } from "./teamRulesUpdates.ts";

const folders: string[] = [];
const file = (text: string) => {
  const folder = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "team-rules-updates-"));
  folders.push(folder);
  const path = NodePath.join(folder, "team-rules.json");
  NodeFS.writeFileSync(path, text);
  return path;
};

afterEach(() => {
  for (const folder of folders.splice(0)) NodeFS.rmSync(folder, { recursive: true });
});

describe("readTeamRulesUpdatePolicy", () => {
  it("decides nothing with no file", () => {
    expect(readTeamRulesUpdatePolicy("/nonexistent/team-rules.json")).toEqual({
      automatic: undefined,
      feed: undefined,
      owner: undefined,
    });
  });

  it("reads the rule and who set it", () => {
    const path = file(
      JSON.stringify({
        version: 1,
        owner: "Acme",
        updates: { automatic: false, feed: "https://updates.acme.example" },
      }),
    );
    expect(readTeamRulesUpdatePolicy(path)).toEqual({
      automatic: false,
      feed: "https://updates.acme.example",
      owner: "Acme",
    });
  });

  it("stops automatic updates while the file is broken", () => {
    expect(readTeamRulesUpdatePolicy(file("{")).automatic).toBe(false);
  });
});
