import type { ServiceUpdateBlocker } from "@specweave-studio/contracts";
import { describe, expect, it } from "vite-plus/test";

import {
  describeAppRestartWarning,
  describeServiceUpdateStop,
} from "./SidebarRestartToUpdate.logic";

// 2026-10-29: an update restarted a machine that was copying a folder to or from another one, and
// the copy failed. A folder copy is in no blocker row, so the service counts it as `folderCopies`.

const run = {
  kind: "run",
  count: 1,
  threadId: "Fix login",
  threadTitle: "Fix login",
  projectId: null,
  projectTitle: null,
} as unknown as ServiceUpdateBlocker;

describe("folder copies before an update", () => {
  it("says a forced update's restart can cut a copy off; it stops none", () => {
    expect(describeServiceUpdateStop({ blockers: [], openTerminals: 0, folderCopies: 1 })).toBe(
      "Stop running work and update now?\n1 folder copy to or from another machine is in progress and may need Retry after the update.",
    );
  });

  // The bundled service serves or pulls the copy in-process: the app restart cuts it off,
  // and "Restart when idle" (isServiceWorkRunning) must keep waiting while it runs.
  it("asks before an app restart while only a folder copy runs, and names it beside running work", () => {
    expect(describeAppRestartWarning({ blockers: [], folderCopies: 0 })).toBeNull();
    expect(
      describeAppRestartWarning({ blockers: [], folderCopies: 1 }, { version: "1.0.126" }),
    ).toBe(
      [
        "Restart to install SpecWithCode 1.0.126?",
        "1 folder copy to or from another machine is in progress. Restarting cuts it off, and it may need Retry.",
        "Restart when idle lets it finish first: SpecWithCode restarts once nothing runs, or after the wait set in Settings, and the stopped work continues after the restart.",
      ].join("\n"),
    );
    expect(
      describeAppRestartWarning(
        { blockers: [run], folderCopies: 2 },
        { version: "1.0.126", listed: true },
      ),
    ).toBe(
      [
        "Restart to install SpecWithCode 1.0.126?",
        "1 running in 1 thread. Restarting interrupts this work.",
        "2 folder copies to or from another machine are in progress. Restarting cuts them off, and they may need Retry.",
      ].join("\n"),
    );
  });
});
