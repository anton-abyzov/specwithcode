import { EnvironmentId, ProjectId, ThreadId } from "@specweave-studio/contracts";
import { describe, expect, it } from "vite-plus/test";

import { mayStartScratchHelper, projectHasCopyOn } from "./scratchHelper.ts";

const win = { id: "win", environmentId: EnvironmentId.make("env-win") };
const project = (settings: Record<string, unknown>) =>
  ({ id: ProjectId.make("p"), title: "specweave", workspaceSettings: settings }) as never;

describe("scratch helpers on another machine", () => {
  it("allows a helper only where the project has no copy", () => {
    const none = project({});
    expect(projectHasCopyOn(none, win)).toBe(false);
    expect(mayStartScratchHelper(none, win)).toBe(true);
    const linked = project({
      logicalProject: {
        id: "logical",
        members: [
          {
            environmentId: win.environmentId,
            projectId: ProjectId.make("win-copy"),
            coordinatorThreadId: ThreadId.make("c"),
          },
        ],
      },
    });
    expect(mayStartScratchHelper(linked, win)).toBe(false);
    const saved = project({
      workerMachines: [
        { machineId: "win", environmentId: win.environmentId, projectId: ProjectId.make("w") },
      ],
    });
    expect(mayStartScratchHelper(saved, win)).toBe(false);
    // A saved machine with no project there is not a copy.
    expect(
      mayStartScratchHelper(
        project({ workerMachines: [{ machineId: "win", environmentId: win.environmentId }] }),
        win,
      ),
    ).toBe(true);
    // No project read: the old rule stands.
    expect(mayStartScratchHelper(undefined, win)).toBe(false);
  });
});
