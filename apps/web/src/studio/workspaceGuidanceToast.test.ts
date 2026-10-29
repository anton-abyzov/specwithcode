import { beforeEach, describe, expect, it, vi } from "vite-plus/test";

const toast = vi.hoisted(() => ({ add: vi.fn() }));
vi.mock("../components/ui/toast", () => ({ toastManager: toast }));
vi.mock("../state/use-atom-command", () => ({ useAtomCommand: () => vi.fn() }));
vi.mock("../state/projects", () => ({ projectEnvironment: { folderCheck: {} } }));
vi.mock("../state/environments", () => ({ useEnvironment: () => null }));

import { resetProjectFolderChecksForTests } from "./useProjectFolderHealth";
import { announceWorkspaceGuidance } from "./workspaceGuidanceToast";

const project = { environmentId: "host", id: "project", workspaceRoot: "/w/easychamp" } as never;
const checked = (layout: Record<string, unknown> | undefined) =>
  vi.fn(async () => ({ _tag: "Success", value: { layout } })) as never;
const base = { repositories: [], repositoryCount: 0, truncated: false, separateClones: false };

beforeEach(() => {
  toast.add.mockReset();
  resetProjectFolderChecksForTests();
});

describe("workspace guidance after adding a project", () => {
  it("advises the current checkout for an umbrella of clones", async () => {
    await announceWorkspaceGuidance(
      checked({
        ...base,
        kind: "umbrella",
        rootIsRepository: true,
        repositories: ["repositories/acme/api", "repositories/acme/web"],
        repositoryCount: 2,
        separateClones: true,
      }),
      project,
    );
    expect(toast.add).toHaveBeenCalledOnce();
    expect(toast.add.mock.lastCall?.[0]).toMatchObject({
      type: "info",
      title: "Multi-repository folder: current checkout recommended",
      description: expect.stringContaining("Keep Project settings > Use worktrees off."),
    });
  });

  it("advises worktrees for one Git repository", async () => {
    await announceWorkspaceGuidance(
      checked({ ...base, kind: "single", rootIsRepository: true }),
      project,
    );
    expect(toast.add.mock.lastCall?.[0]).toMatchObject({
      title: "One Git repository: worktrees recommended",
    });
  });

  it("says nothing for a plain folder or a failed check", async () => {
    await announceWorkspaceGuidance(
      checked({ ...base, kind: "plain", rootIsRepository: false }),
      project,
    );
    resetProjectFolderChecksForTests();
    await announceWorkspaceGuidance(vi.fn(async () => ({ _tag: "Failure" })) as never, project);
    expect(toast.add).not.toHaveBeenCalled();
  });
});
