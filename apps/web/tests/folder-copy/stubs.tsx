const totals = Object.fromEntries(
  ["repository", "tracked", "untracked", "ignoredData", "rebuildable", "secret"].map((k) => [
    k,
    { files: 2, bytes: 512 },
  ]),
);
const summary = {
  totals,
  repositories: [],
  secretFiles: [],
  linksOutside: 0,
  warnings: [
    "Work is still running in this folder. You can copy now, but files may change during the copy and later edits are not included. Transferring coordinator context waits until this work stops.",
  ],
};
export const machineHandoff = new Proxy({}, { get: (_, name) => name });
export const projectLink = new Proxy({}, { get: (_, name) => name });
export const linkCopyAsWorkers = async () => ({ status: "linked" });
export const filesystemEnvironment = { browse: (value: unknown) => value };
export const useFilesystemReadAccess = () => ({ canReadFiles: true });
export const useEnvironmentQuery = () => ({
  data: { parentPath: "/home/anton", entries: [] },
  isPending: false,
});
let applied = false;
let attempted = false;
let published = false;
let op = "";
let mode = "copy-only";
let targetFolder = "";
const umbrella = "/Users/you/Projects/github/specweave-umb";
const child = "repositories/anton-abyzov/specweave";
let copyRoot = umbrella;
let projectRelativePath = child;
const status = (state: string) => ({
  operationId: op,
  sourceEnvironmentId: "m4",
  sourceProjectId: "source",
  sourceMachine: "MacBook M4",
  mode,
  targetFolder,
  copyRoot,
  projectRelativePath,
  projectFolder:
    projectRelativePath === "." ? targetFolder : `${targetFolder}/${projectRelativePath}`,
  title: "SpecWeave",
  selection: [],
  mirror: false,
  state,
  failedStep: state === "failed" ? "transfer" : null,
  error: state === "failed" ? { message: "The copy connection was interrupted." } : null,
  progress: null,
  disk: null,
  // One repository the destination does not have yet, so a one-click copy approves itself.
  rows: [
    {
      id: `repo:${child}`,
      kind: "repository",
      path: child,
      status: "new",
      detail: "Not on this machine yet.",
      filesToMove: 8,
      bytesToMove: 2048,
      bytesPresent: 0,
      choices: [],
      decision: null,
      needsDecision: false,
      conflicts: [],
      moreConflicts: 0,
      cloneAvailable: false,
      clone: false,
    },
  ],
  totals: { filesToMove: 8, bytesToMove: 2048, bytesPresent: 0, decisionsNeeded: 0 },
  checks: [],
  warnings: summary.warnings,
  unstable: [],
  committed: state === "applied",
  projectId: state === "applied" ? "copied" : null,
  createdAt: "2026-10-21T00:00:00Z",
  updatedAt: "2026-10-21T00:00:00Z",
});
type Gate = { readonly promise: Promise<void>; readonly release: () => void };
const gates = new Map<string, Gate>();
const failures = new Map<string, { code: string; message: string }>();
export const fixture = {
  calls: [] as string[],
  copyRequests: [] as Array<{
    copyRoot: string;
    projectRelativePath: string;
    targetFolder: string;
  }>,
  transferReady: false,
  failCopy: false,
  pauseNext(name: string) {
    let release!: () => void;
    const promise = new Promise<void>((resolve) => {
      release = resolve;
    });
    gates.set(name, { promise, release });
  },
  release(name: string) {
    const gate = gates.get(name);
    if (!gate) throw new Error(`No pending synthetic command: ${name}`);
    gates.delete(name);
    gate.release();
  },
  failNext(name: string, code: string, message: string) {
    failures.set(name, { code, message });
  },
};
declare global {
  interface Window {
    __folderCopyFixture: typeof fixture;
  }
}
window.__folderCopyFixture = fixture;
export const useAtomCommand =
  (name: string) =>
  async ({ input }: any) => {
    fixture.calls.push(name);
    await gates.get(name)?.promise;
    const failure = failures.get(name);
    if (failure) {
      failures.delete(name);
      return {
        _tag: "Failure",
        error: Object.assign(new Error(failure.message), { code: failure.code }),
      };
    }
    let value;
    if (name === "copyScopes") {
      value = {
        projectRoot: `${umbrella}/${child}`,
        recommendedCopyRoot: umbrella,
        scopes: [
          {
            copyRoot: `${umbrella}/${child}`,
            projectRelativePath: ".",
            kind: "project",
            label: "This project folder",
            repositories: [],
            truncated: false,
          },
          {
            copyRoot: umbrella,
            projectRelativePath: child,
            kind: "workspace",
            label: "specweave-umb",
            repositories: [
              child,
              "repositories/anton-abyzov/specwithcode",
              "repositories/anton-abyzov/vskill",
              "custom/tools",
            ],
            truncated: false,
          },
        ],
      };
    } else if (name === "copyCapabilities") {
      value = { scopeVersion: 1 };
    } else if (name === "prepare") {
      if (!fixture.transferReady)
        return {
          _tag: "Failure",
          error: Object.assign(new Error("Work is running"), { code: "busy" }),
        };
      published ||= input.publish === true;
      value = {
        publication: published ? "published" : "unpublished",
        bundle: {
          digest: "d".repeat(64),
          manifest: { operationId: input.operationId, repositories: [] },
          destination: input.destination,
          sourceEnvironmentId: "m4",
          sourceProjectId: "source",
          sourceThreadId: "coordinator",
        },
      };
    } else if (name === "receive") {
      value = {
        phase: input.mode === "preview" ? "ready" : "started",
        executionMode: "project-folder",
        projectId: input.projectId,
        coordinatorThreadId: `project-coordinator:${input.projectId}`,
      };
    } else if (name === "copyOffer") {
      copyRoot = input.copyRoot ?? `${umbrella}/${child}`;
      projectRelativePath = copyRoot === umbrella ? child : ".";
      op = input.operationId;
      mode = input.mode;
      applied = false;
      attempted = false;
      published = false;
      value = {
        operationId: op,
        sourceEnvironmentId: "m4",
        sourceProjectId: "source",
        sourceUrl: "https://fixture.example.ts.net",
        sourceMachine: "MacBook M4",
        token: "synthetic",
        title: "SpecWeave",
        mode,
        copyRoot,
        projectRelativePath,
        status: { state: "scanned", summary, error: null },
      };
    } else if (name === "copySourceStatus") {
      // A reopened copy reads the measured summary back from the source.
      value = { state: "scanned", summary, error: null, progress: null };
    } else if (name === "copyStart") {
      targetFolder = input.targetFolder;
      fixture.copyRequests.push({
        copyRoot: input.copyRoot,
        projectRelativePath: input.projectRelativePath,
        targetFolder,
      });
      value = status("previewed");
    } else if (name === "copyApprove" || name === "copyRetry") {
      if (name === "copyRetry") fixture.failCopy = false;
      attempted = true;
      applied = !fixture.failCopy;
      value = status(applied ? "applied" : "failed");
    } else if (name === "copyStatus")
      value = status(applied ? "applied" : attempted ? "failed" : "previewed");
    else if (name === "copyRelease") value = { released: true };
    else if (name === "copyCancel" || name === "copySourceCancel") value = status("cancelled");
    else value = {};
    return { _tag: "Success", value };
  };
export const squashAtomCommandFailure = (value: any) => value.error;
export const MachineReadinessChecklist = () => (
  <p className="text-xs text-muted-foreground">
    Synthetic readiness fixture; no provider session started.
  </p>
);
export const ProjectLinkDialog = () => null;
