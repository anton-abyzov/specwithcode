import { scopeThreadRef } from "@specweave-studio/client-runtime/environment";
import { EnvironmentId, ThreadId } from "@specweave-studio/contracts";
import { beforeEach, describe, expect, it, vi } from "vite-plus/test";

import {
  firstChangedNewSideLine,
  openDiffFilePrimaryAction,
  resolveDiffPathForWorkspace,
} from "./diffFileActions";
import { getRenderablePatch } from "./lib/diffRendering";
import { selectThreadRightPanelState, useRightPanelStore } from "./rightPanelStore";

const THREAD_REF = scopeThreadRef(
  EnvironmentId.make("environment-local"),
  ThreadId.make("thread-1"),
);

describe("openDiffFilePrimaryAction", () => {
  beforeEach(() => {
    useRightPanelStore.setState({ byThreadKey: {}, threadPanelVisibilityByThreadKey: {} });
  });

  it("opens diff files in the thread file viewer", () => {
    const openInEditor = vi.fn();

    openDiffFilePrimaryAction({
      threadRef: THREAD_REF,
      filePath: "apps/web/src/components/DiffPanel.tsx",
      activeCwd: "/repo/project",
      openInEditor,
    });

    expect(
      selectThreadRightPanelState(useRightPanelStore.getState().byThreadKey, THREAD_REF),
    ).toMatchObject({
      isOpen: true,
      activeSurfaceId: "file:apps/web/src/components/DiffPanel.tsx",
    });
    expect(openInEditor).not.toHaveBeenCalled();
  });

  it("falls back to the editor without thread context", () => {
    const openInEditor = vi.fn();

    openDiffFilePrimaryAction({
      threadRef: null,
      filePath: "apps/web/src/components/DiffPanel.tsx",
      activeCwd: "/repo/project",
      openInEditor,
    });

    expect(openInEditor).toHaveBeenCalledWith(
      "/repo/project/apps/web/src/components/DiffPanel.tsx",
    );
  });

  it("opens repository-relative diff files from a nested project", () => {
    const openInEditor = vi.fn();

    openDiffFilePrimaryAction({
      threadRef: THREAD_REF,
      filePath: "frontend/Dockerfile",
      activeCwd: "/repo/frontend",
      repositoryRoot: "/repo",
      openInEditor,
    });

    expect(
      selectThreadRightPanelState(useRightPanelStore.getState().byThreadKey, THREAD_REF),
    ).toMatchObject({
      isOpen: true,
      activeSurfaceId: "file:Dockerfile",
    });
    expect(openInEditor).not.toHaveBeenCalled();
  });

  it("preserves repository-relative paths in a separate worktree", () => {
    expect(
      resolveDiffPathForWorkspace({
        filePath: "frontend/Dockerfile",
        workspaceRoot: "/worktrees/feature",
        repositoryRoot: "/repo",
      }),
    ).toBe("frontend/Dockerfile");
  });

  it("handles Windows roots and mixed diff separators", () => {
    expect(
      resolveDiffPathForWorkspace({
        filePath: "Frontend/src\\index.ts",
        workspaceRoot: "C:\\repo\\frontend",
        repositoryRoot: "C:\\repo",
      }),
    ).toBe("src/index.ts");
  });

  it.each([
    { workspaceRoot: "/frontend", repositoryRoot: "/" },
    { workspaceRoot: "C:\\frontend", repositoryRoot: "C:\\" },
  ])("handles filesystem roots: $repositoryRoot", ({ workspaceRoot, repositoryRoot }) => {
    expect(
      resolveDiffPathForWorkspace({
        filePath: "frontend/index.ts",
        workspaceRoot,
        repositoryRoot,
      }),
    ).toBe("index.ts");
  });

  it.each(["backend/server.ts", "frontend2/app.ts", "frontend/../secret.ts", "C:secret.ts"])(
    "does not open an out-of-project diff path: %s",
    (filePath) => {
      const openInEditor = vi.fn();

      openDiffFilePrimaryAction({
        threadRef: THREAD_REF,
        filePath,
        activeCwd: "/repo/frontend",
        repositoryRoot: "/repo",
        openInEditor,
      });

      expect(
        selectThreadRightPanelState(useRightPanelStore.getState().byThreadKey, THREAD_REF),
      ).toMatchObject({ isOpen: false });
      expect(openInEditor).not.toHaveBeenCalled();
    },
  );
});

function activeFileSurface() {
  const state = selectThreadRightPanelState(useRightPanelStore.getState().byThreadKey, THREAD_REF);
  return state.surfaces.find((surface) => surface.id === state.activeSurfaceId) ?? null;
}

function patchFile(patch: string) {
  const renderable = getRenderablePatch(patch, "diff-file-actions-test");
  if (renderable?.kind !== "files") throw new Error("fixture patch did not parse");
  return renderable.files[0]!;
}

describe("opening a turn diff's file (D-19)", () => {
  beforeEach(() => {
    useRightPanelStore.setState({ byThreadKey: {}, threadPanelVisibilityByThreadKey: {} });
  });

  it("resolves a repository-relative patch path against the stamped subfolder", () => {
    const opened = openDiffFilePrimaryAction({
      threadRef: THREAD_REF,
      filePath: "apps/web/src/App.tsx",
      activeCwd: "/repo/apps/web",
      checkpoint: { cwd: "/repo/apps/web", repoRoot: "/repo" },
      line: 12,
      openInEditor: vi.fn(),
    });

    expect(opened).toEqual({ workspaceFilePath: "src/App.tsx", otherCheckpointFolder: null });
    expect(activeFileSurface()).toMatchObject({ relativePath: "src/App.tsx", revealLine: 12 });
  });

  it("opens today's copy and names the stamped folder when the worktree changed", () => {
    const opened = openDiffFilePrimaryAction({
      threadRef: THREAD_REF,
      filePath: "packages/core/index.ts",
      activeCwd: "/worktrees/feature-b/packages/core",
      // The project repository root says nothing about the folder this turn ran in.
      repositoryRoot: "/repo",
      checkpoint: { cwd: "/worktrees/feature-a/packages/core", repoRoot: "/worktrees/feature-a" },
      openInEditor: vi.fn(),
    });

    expect(opened).toEqual({
      workspaceFilePath: "index.ts",
      otherCheckpointFolder: "/worktrees/feature-a/packages/core",
    });
    expect(activeFileSurface()).toMatchObject({ relativePath: "index.ts", revealLine: null });
  });

  it("does not open a stamped turn's file that lies outside the checkpoint folder", () => {
    const opened = openDiffFilePrimaryAction({
      threadRef: THREAD_REF,
      filePath: "apps/server/src/main.ts",
      activeCwd: "/repo/apps/web",
      checkpoint: { cwd: "/repo/apps/web", repoRoot: "/repo" },
      openInEditor: vi.fn(),
    });

    expect(opened).toBeNull();
    expect(activeFileSurface()).toBeNull();
  });

  it("keeps today's resolution for checkpoints without a stamp", () => {
    const opened = openDiffFilePrimaryAction({
      threadRef: THREAD_REF,
      filePath: "frontend/Dockerfile",
      activeCwd: "/repo/frontend",
      repositoryRoot: "/repo",
      checkpoint: {},
      openInEditor: vi.fn(),
    });

    expect(opened).toEqual({ workspaceFilePath: "Dockerfile", otherCheckpointFolder: null });
  });
});

describe("firstChangedNewSideLine", () => {
  it("finds the first added line after the hunk's context", () => {
    const file = patchFile(
      [
        "diff --git a/src/app.ts b/src/app.ts",
        "--- a/src/app.ts",
        "+++ b/src/app.ts",
        "@@ -10,4 +10,5 @@",
        " const a = 1;",
        " const b = 2;",
        "+const c = 3;",
        " const d = 4;",
        " const e = 5;",
      ].join("\n"),
    );
    expect(firstChangedNewSideLine(file)).toBe(12);
  });

  it("points at where a deleted block was when nothing was added", () => {
    const file = patchFile(
      [
        "diff --git a/src/app.ts b/src/app.ts",
        "--- a/src/app.ts",
        "+++ b/src/app.ts",
        "@@ -20,3 +20,2 @@",
        " keep();",
        "-drop();",
        " keep();",
      ].join("\n"),
    );
    expect(firstChangedNewSideLine(file)).toBe(21);
  });

  it("opens a new file at its first line and gives a deleted file no line", () => {
    const created = patchFile(
      [
        "diff --git a/notes.md b/notes.md",
        "new file mode 100644",
        "--- /dev/null",
        "+++ b/notes.md",
        "@@ -0,0 +1,2 @@",
        "+# Notes",
        "+text",
      ].join("\n"),
    );
    const deleted = patchFile(
      [
        "diff --git a/old.md b/old.md",
        "deleted file mode 100644",
        "--- a/old.md",
        "+++ /dev/null",
        "@@ -1,2 +0,0 @@",
        "-# Old",
        "-text",
      ].join("\n"),
    );
    expect(firstChangedNewSideLine(created)).toBe(1);
    expect(firstChangedNewSideLine(deleted)).toBeNull();
  });
});
