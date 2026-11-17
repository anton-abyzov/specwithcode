/* Synthetic data only: the project "Atlas" on fictional machines. This app runs on m4.
   `?case=` copies | empty | linked:
   - copies: Atlas is also on m1 and m3 (m3 matches more repositories) and on linux-mini,
     which is not connected; six other projects sit on those machines.
   - empty: no machine has a copy of Atlas; only the other projects exist.
   - linked: Atlas on m4 is already linked with m5, where Main is; m1 holds one more copy. */
import type { EnvironmentProject } from "@specweave-studio/client-runtime/state/shell";

const view = new URLSearchParams(location.search).get("case") ?? "copies";
const REMOTE = "github.com/acme/atlas";

const project = (
  environmentId: string,
  id: string,
  title: string,
  workspaceRoot: string,
  remote: string | null,
  workspaceSettings: Record<string, unknown> = { kind: "code" },
) =>
  ({
    id,
    environmentId,
    title,
    workspaceRoot,
    updatedAt: "2026-11-17T12:00:00.000Z",
    repositoryIdentity: remote
      ? {
          canonicalKey: remote,
          rootPath: workspaceRoot,
          locator: { source: "git-remote", remoteName: "origin", remoteUrl: remote },
        }
      : null,
    workspaceSettings,
  }) as unknown as EnvironmentProject;

const member = (environmentId: string, projectId: string) => ({
  environmentId,
  projectId,
  coordinatorThreadId: `project-coordinator:${projectId}`,
});
const logicalProject = {
  id: "logical:atlas",
  title: "Atlas",
  coordinatorId: "coordinator:logical:atlas",
  members: [member("m4", "atlas"), member("m5", "atlas")],
};

export const here =
  view === "linked"
    ? project("m4", "atlas", "Atlas", "/Users/dana/Projects/atlas", REMOTE, {
        kind: "code",
        logicalProject,
        coordinatorBinding: { epoch: 2, state: "transferred", successor: member("m5", "atlas") },
      })
    : project("m4", "atlas", "Atlas", "/Users/dana/Projects/atlas", REMOTE);

const copies = [
  project("m1", "atlas-fleet", "Atlas", "/Users/dana/Projects/atlas-fleet", REMOTE),
  project("m3", "atlas", "Atlas", "/Users/dana/Projects/atlas", REMOTE),
  project("linux-mini", "atlas", "Atlas", "/home/dana/Projects/atlas", REMOTE),
];
const others = [
  project("linux-mini", "ai-notes", "ai-notes", "/home/dana/Projects/ai-notes", "github.com/acme/ai-notes"),
  project("m5", "first-steps", "first-steps", "/Users/dana/Projects/first-steps", null),
  project("linux-mini", "voxel-run", "voxel-run", "/home/dana/Projects/voxel-run", "github.com/acme/voxel-run"),
  project("m3", "ledger", "ledger", "/Users/dana/Documents/ledger", "github.com/acme/ledger"),
  project("m1", "sketchbook", "sketchbook", "/Users/dana/Projects/sketchbook", "github.com/acme/sketchbook"),
  project("m1", "weave", "weave", "/Users/dana/work/weave", "github.com/acme/weave"),
];
const projects: EnvironmentProject[] =
  view === "empty"
    ? [here, ...others]
    : view === "linked"
      ? [
          here,
          project("m5", "atlas", "Atlas", "/Users/dana/Projects/atlas", REMOTE, {
            kind: "code",
            logicalProject,
            coordinatorBinding: { epoch: 2, state: "active" },
          }),
          copies[0]!,
          ...others,
        ]
      : [here, ...copies, ...others];

const repositories = (shared: number, extra: number, tag: string) => [
  { path: "", originKey: REMOTE, worktrees: 0 },
  ...Array.from({ length: shared }, (_, index) => ({
    path: `repositories/service-${index}`,
    originKey: `github.com/acme/service-${index}`,
    worktrees: 0,
  })),
  ...Array.from({ length: extra }, (_, index) => ({
    path: `repositories/${tag}-${index}`,
    originKey: `github.com/acme/${tag}-${index}`,
    worktrees: 0,
  })),
];
const fingerprintOf = (shared: number, extra: number, tag: string) => ({
  root: "repository" as const,
  repositories: repositories(shared, extra, tag),
  skippedLinks: 0,
  truncated: false,
});
// m4 holds 35 nested repositories. m1 shares 31 of them, m3 shares 33.
const FINGERPRINTS: Record<string, ReturnType<typeof fingerprintOf>> = {
  "m4:atlas": fingerprintOf(35, 0, "here"),
  "m1:atlas-fleet": fingerprintOf(31, 4, "fleet"),
  "m3:atlas": fingerprintOf(33, 2, "lab"),
};

const OFFLINE = new Set(["linux-mini"]);

export function useProjects() {
  return projects;
}

export function useScratchProject() {
  return { scratchWorkspaceRootFor: () => null };
}

export function useRetiredMachineRecords(): ReadonlyMap<string, string> {
  return new Map();
}

const machines = {
  label: (environmentId: string) => environmentId,
  state: (environmentId: string) =>
    OFFLINE.has(environmentId) ? ("offline" as const) : ("ready" as const),
  problem: (environmentId: string) =>
    OFFLINE.has(environmentId) ? `Connect ${environmentId} first.` : null,
  connected: (environmentId: string) => !OFFLINE.has(environmentId),
  takeoverReady: () => true,
  startReady: () => true,
};
export function useLinkMachines() {
  return machines;
}

/** Every command reads a folder: the dialog's first step calls nothing else. */
export function useAtomCommand() {
  return async (request: { environmentId: string; input: { projectId: string } }) => {
    const fingerprint = FINGERPRINTS[`${request.environmentId}:${request.input.projectId}`];
    return fingerprint
      ? { _tag: "Success" as const, value: { workspaceRoot: "/", fingerprint } }
      : { _tag: "Failure" as const, error: new Error("This folder could not be read.") };
  };
}
