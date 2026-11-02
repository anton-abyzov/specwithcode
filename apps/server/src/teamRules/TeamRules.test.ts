// @effect-diagnostics nodeBuiltinImport:off - exercises the reader against real files.
import * as NodeFS from "node:fs";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vite-plus/test";

import { machineTeamRulesPath, makeTeamRulesReader, readTeamRulesFile } from "./TeamRules.ts";

let folder: string;
let path: string;
beforeEach(() => {
  folder = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "studio-team-rules-"));
  path = NodePath.join(folder, "team-rules.json");
});
afterEach(() => NodeFS.rmSync(folder, { recursive: true, force: true }));

describe("machineTeamRulesPath", () => {
  it("is fixed per platform and ignores the environment", () => {
    process.env.STUDIO_HOME = "/tmp/elsewhere";
    process.env.HOME = "/tmp/elsewhere";
    process.env.ProgramData = "D:\\elsewhere";
    expect(machineTeamRulesPath("darwin")).toBe(
      "/Library/Application Support/SpecWithCode/team-rules.json",
    );
    expect(machineTeamRulesPath("win32")).toBe("C:\\ProgramData\\SpecWithCode\\team-rules.json");
    expect(machineTeamRulesPath("linux")).toBe("/etc/specwithcode/team-rules.json");
  });
});

describe("readTeamRulesFile", () => {
  it("reads no file as no rules", () => {
    expect(readTeamRulesFile(path).status).toBe("none");
  });

  it("holds on a broken file, a folder and an oversized file", () => {
    NodeFS.writeFileSync(path, "{");
    expect(readTeamRulesFile(path).status).toBe("hold");
    NodeFS.rmSync(path);
    NodeFS.mkdirSync(path);
    expect(readTeamRulesFile(path).status).toBe("hold");
    NodeFS.rmdirSync(path);
    NodeFS.writeFileSync(path, " ".repeat(300 * 1024));
    expect(readTeamRulesFile(path).status).toBe("hold");
  });

  it("warns when the user could change the file", () => {
    NodeFS.writeFileSync(path, '{"version":1,"owner":"Acme"}');
    const state = readTeamRulesFile(path);
    if (state.status !== "active") throw new Error("expected active rules");
    expect(state.fingerprint).toMatch(/^[0-9a-f]{12}$/);
    if (process.platform !== "win32" && process.getuid?.() !== 0) {
      expect(state.warnings.join()).toContain("someone other than root");
    }
  });
});

describe("makeTeamRulesReader", () => {
  it("follows a tightening, a typo, the repair and the removal without a restart", () => {
    const read = makeTeamRulesReader(path);
    expect(read().status).toBe("none");

    NodeFS.writeFileSync(path, '{"version":1,"owner":"Acme","agents":{"ceiling":"auto"}}');
    const first = read();
    expect(first.status).toBe("active");
    expect(read()).toBe(first);

    NodeFS.writeFileSync(path, '{"version":1,"owner":"Acme","agents":{"ceiling":"yolo"}}');
    const held = read();
    expect(held.status).toBe("hold");
    expect(held.status === "hold" && held.owner).toBe("Acme");

    NodeFS.writeFileSync(
      path,
      '{"version":1,"owner":"Acme","agents":{"ceiling":"approval-required"}}',
    );
    const repaired = read();
    expect(repaired.status === "active" && repaired.rules.agents?.ceiling).toBe(
      "approval-required",
    );

    NodeFS.rmSync(path);
    expect(read().status).toBe("none");
  });
});
