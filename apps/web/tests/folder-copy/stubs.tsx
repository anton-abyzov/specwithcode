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
let op = "";
let mode = "copy-only";
let targetFolder = "";
const status = (state: string) => ({
  operationId: op,
  sourceEnvironmentId: "m4",
  sourceProjectId: "source",
  sourceMachine: "MacBook M4",
  mode,
  targetFolder,
  title: "SpecWeave",
  selection: [],
  mirror: false,
  state,
  failedStep: null,
  error: null,
  progress: null,
  disk: null,
  rows: [],
  totals: { filesToMove: 8, bytesToMove: 2048, bytesPresent: 0, decisionsNeeded: 0 },
  checks: [],
  warnings: summary.warnings,
  unstable: [],
  committed: state === "applied",
  projectId: state === "applied" ? "copied" : null,
  createdAt: "2026-10-21T00:00:00Z",
  updatedAt: "2026-10-21T00:00:00Z",
});
export const useAtomCommand =
  (name: string) =>
  async ({ input }: any) => {
    if (name === "prepare")
      return {
        _tag: "Failure",
        error: Object.assign(new Error("Work is running"), { code: "busy" }),
      };
    let value;
    if (name === "copyOffer") {
      op = input.operationId;
      mode = input.mode;
      applied = false;
      value = {
        operationId: op,
        sourceEnvironmentId: "m4",
        sourceProjectId: "source",
        sourceUrl: "https://fixture.example.ts.net",
        sourceMachine: "MacBook M4",
        token: "synthetic",
        title: "SpecWeave",
        mode,
        status: { state: "scanned", summary, error: null },
      };
    } else if (name === "copyStart") {
      targetFolder = input.targetFolder;
      value = status("previewed");
    } else if (name === "copyApprove") {
      applied = true;
      value = status("applied");
    } else if (name === "copyStatus") value = status(applied ? "applied" : "previewed");
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
