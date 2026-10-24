import { describe, expect, it } from "vite-plus/test";
import { EnvironmentId, ThreadId, type MachineHandoffBundle } from "@specweave-studio/contracts";
import { copiedContextPaths } from "./folderCopyContextPaths.ts";

// The destination is the local machine, so its path flavor follows the injected platform.
const destinations = [
  {
    platform: "linux",
    projectRoot: "/home/dev/workspace/custom/app",
    copyRoot: "/home/dev/workspace",
    workerPath: "/home/dev/workspace/work/api",
  },
  {
    platform: "win32",
    projectRoot: "E:\\dev\\workspace\\custom\\app",
    copyRoot: "E:\\dev\\workspace",
    workerPath: "E:\\dev\\workspace\\work\\api",
  },
] as const;

describe.each(destinations)("to a $platform destination", (destination) => {
  it.each([
    {
      root: "/Users/dev/workspace",
      worker: "/Users/dev/workspace/work/api",
      outside: "/Users/dev/other/api",
    },
    {
      root: "C:\\work\\workspace",
      worker: "C:\\work\\workspace\\work\\api",
      outside: "D:\\other\\api",
    },
  ])(
    "maps only copied local checkouts without rewriting historical messages (%j)",
    ({ root, worker, outside }) => {
      const source = EnvironmentId.make("source");
      const threads = [
        { threadId: ThreadId.make("coordinator"), worktreePath: null },
        { threadId: ThreadId.make("worker"), worktreePath: worker },
        { threadId: ThreadId.make("outside"), worktreePath: outside },
        {
          threadId: ThreadId.make("other-machine"),
          worktreePath: worker,
          environmentId: EnvironmentId.make("other"),
        },
        { threadId: ThreadId.make("unlisted-link"), worktreePath: `${root}/link` },
      ].map((thread) => ({
        ...thread,
        kind: "worker",
        messages: [{ text: "Historical source path stays here" }],
      }));
      const bundle = {
        sourceEnvironmentId: source,
        manifest: {
          copyScope: { copyRoot: root, projectRelativePath: "custom/app" },
          repositories: [{ relativePath: "work/api" }],
        },
        context: { threads },
      } as unknown as MachineHandoffBundle;
      const before = JSON.stringify(bundle);
      const mapped = copiedContextPaths(bundle, destination.projectRoot, destination.platform)!;
      expect(mapped.destinationCopyRoot).toBe(destination.copyRoot);
      expect(mapped.threads.map((thread) => thread.destinationWorktreePath)).toEqual([
        destination.projectRoot,
        destination.workerPath,
        null,
        null,
        null,
      ]);
      expect(JSON.stringify(bundle)).toBe(before);
    },
  );
});
