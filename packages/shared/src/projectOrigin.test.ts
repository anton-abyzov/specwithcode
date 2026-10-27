import { describe, expect, it } from "vite-plus/test";

import { isAppScratchFolder, isAutomatedWorkspaceRoot, projectOrigin } from "./projectOrigin.ts";

describe("isAutomatedWorkspaceRoot", () => {
  it.each([
    // Folders the checks that reached the live sidebar actually used.
    "/Users/x/.specwithcode/m4/scratch/run-shell-blocks-installed/workspace",
    "/Users/x/Projects/scratch/swc-copy-source-2026-10-20/specweave-copy-fixture",
    "/Users/x/.local/share/specweave-studio/verification/drafts-installed/run-1/project",
    "/Users/x/.specwithcode/install/verification/0885-t05-remote/49b8",
    "/Users/x/.local/share/specweave/fleet/handoff-proof-20261013/easychamp-handoff119/sw-easychamp",
    "/Users/x/Projects/research/studio-copilot/provider-proof-140/grok-fixture",
    "/private/tmp/claude-501/scratchpad/project",
    "/tmp/proof",
    "C:\\Users\\x\\AppData\\Local\\Temp\\check",
  ])("treats %s as a check's folder", (root) => {
    expect(isAutomatedWorkspaceRoot(root)).toBe(true);
  });

  it.each([
    "/Users/x/Projects/sw-easychamp",
    "/Users/x/Projects/github/specweave-umb/repositories/anton-abyzov/specweave",
    "/Users/x/Projects/_events/emergeAmericas_hackathon",
    "/Users/x/Projects/sketchmate_dont_confuse",
    // The personal assistant and named projects the app keeps in its own folder.
    "/Users/x/.specwithcode/m4/projects/aide",
    "/Users/x/.specwithcode/m4/projects/my-new-app",
    // New project names its folder after the title; the projects folder wins over the words.
    "/Users/x/.specwithcode/m4/projects/scratch-notes",
    "/Users/x/.specwithcode/m4/projects/email-verification",
    // A dev server's home inside a worktree.
    "/Users/x/.specwithcode/m4/worktrees/x/.specwithcode/projects/aide",
    "/home/x/.local/share/specweave-studio/projects/notes",
    // Words only count as whole words.
    "/Users/x/Projects/scratchy-cat",
    "/Users/x/Projects/acceptances-ledger",
  ])("keeps %s as the person's own", (root) => {
    expect(isAutomatedWorkspaceRoot(root)).toBe(false);
  });
});

describe("projectOrigin", () => {
  it("prefers the saved origin, then a temporary session, then the folder", () => {
    expect(projectOrigin({ workspaceRoot: "/tmp/x", workspaceSettings: { origin: "user" } })).toBe(
      "user",
    );
    expect(
      projectOrigin({ workspaceRoot: "/Users/x/app", workspaceSettings: { origin: "automated" } }),
    ).toBe("automated");
    expect(
      projectOrigin({
        workspaceRoot: "/Users/x/app",
        workspaceSettings: { temporarySessionId: "s" },
      }),
    ).toBe("automated");
    expect(projectOrigin({ workspaceRoot: "/Users/x/app", workspaceSettings: null })).toBe("user");
    expect(projectOrigin({ workspaceRoot: "/Users/x/Projects/scratch/a" })).toBe("automated");
    // The personal assistant is the person's wherever it lives.
    expect(
      projectOrigin({ workspaceRoot: "/tmp/aide", workspaceSettings: { kind: "personal" } }),
    ).toBe("user");
    // A value a newer version adds reads as unset.
    expect(
      projectOrigin({ workspaceRoot: "/Users/x/app", workspaceSettings: { origin: "shared" } }),
    ).toBe("user");
  });
});

describe("isAppScratchFolder", () => {
  it.each([
    ["/Users/x/.specwithcode/m4/scratch", true],
    ["/Users/x/.specwithcode/scratch/", true],
    ["/home/x/.local/share/specweave-studio/scratch", true],
    ["C:\\Users\\x\\.specweave-studio\\m1\\scratch", true],
    ["/Users/x/.specwithcode/m4/scratch/run-1", false],
    ["/Users/x/Projects/scratch", false],
    ["/Users/x/.specwithcode/m4/projects/scratch", false],
  ])("%s is the app's scratch folder: %s", (root, expected) => {
    expect(isAppScratchFolder(root)).toBe(expected);
  });
});
