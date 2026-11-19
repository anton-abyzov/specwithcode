import { Atom } from "effect/reactivity";
const totals = Object.fromEntries(
  ["repository", "tracked", "untracked", "ignoredData", "rebuildable", "secret"].map((k) => [
    k,
    { files: 2, bytes: 512 },
  ]),
);
// `?secrets=1`: the folder holds secret files, which travel by default.
const SECRET_FILES = new URLSearchParams(location.search).has("secrets")
  ? [
      { path: ".env", size: 412 },
      { path: ".env.local", size: 188 },
      { path: "repositories/anton-abyzov/specweave/.env", size: 96 },
      { path: "repositories/anton-abyzov/vskill-platform/.dev.vars", size: 233 },
      { path: "repositories/anton-abyzov/vskill/.npmrc", size: 64 },
      { path: "keys/deploy_ed25519", size: 411 },
    ]
  : [];
const summary = {
  totals,
  repositories: [],
  secretFiles: SECRET_FILES,
  linksOutside: 0,
  warnings: [
    "Work is still running here. Files that change during the copy won't be included, and the project moves once that work stops.",
  ],
};
export const machineHandoff = new Proxy({}, { get: (_, name) => name });
export const projectLink = new Proxy({}, { get: (_, name) => name });
// The credentials list (increment 1337): fictional rows from the source, status from the destination.
export const projectCredentials = new Proxy(
  {},
  { get: (_, name) => `credentials:${String(name)}` },
);
const skips = Atom.make<ReadonlyArray<string> | null>(null).pipe(Atom.keepAlive);
export const credentialSkipsAtom = () => skips;
const CREDENTIAL_ROWS = [
  { id: "github", sources: ["."], keptIn: [".config/gh/hosts.yml"] },
  { id: "azure", sources: ["infra/main.tf"], keptIn: [".azure/msal_token_cache.json"] },
  {
    id: "google-cloud",
    sources: ["scripts/deploy.sh"],
    keptIn: [".config/gcloud/credentials.db"],
  },
  {
    id: "kubernetes",
    sources: ["scripts/deploy.sh", "k8s/kustomization.yaml"],
    keptIn: [".kube/config"],
  },
  { id: "hetzner-cloud", sources: ["infra/hetzner.tf"], keptIn: [".config/hcloud/cli.toml"] },
  {
    id: "cloudflare",
    sources: ["platform/wrangler.jsonc"],
    keptIn: [".wrangler/config/default.toml", "Library/Preferences/.wrangler/config/default.toml"],
    packages: ["platform"],
  },
  { id: "npm", sources: [".github/workflows/release.yml"], keptIn: [".npmrc"] },
  {
    id: "ssh",
    sources: [".", "ops/deploy.sh"],
    keptIn: [".ssh/id_ed25519", ".ssh/config"],
    sshTargets: [
      { kind: "git", user: "git", host: "github.com", variable: null, source: "." },
      {
        kind: "server",
        user: "root",
        host: "203.0.113.10",
        variable: "WORKER_IP",
        source: "ops/deploy.sh",
      },
      {
        kind: "variable",
        user: "deploy",
        host: null,
        variable: "STAGING_HOST",
        source: "ops/stage.sh",
      },
    ],
    sshTargetsMore: false,
  },
].map((row) => ({
  ...row,
  kind: row.id === "ssh" ? "file" : "login",
  listed: row.id === "npm",
  skip: false,
  note: row.id === "npm" ? "publish token" : null,
}));
const CREDENTIAL_PROBES = [
  { id: "github", status: "ready", signIn: "gh auth login && gh auth setup-git", check: null },
  { id: "azure", status: "not_signed_in", signIn: "az login", check: null },
  {
    id: "kubernetes",
    status: "not_signed_in",
    signIn: "az aks get-credentials --resource-group <group> --name <cluster>",
    check: "kubectl get nodes",
  },
  // An answer from before the tool check: no `tool`, the row reads as it did.
  {
    id: "hetzner-cloud",
    status: "tool_missing",
    signIn: "hcloud context create <name>",
    check: null,
  },
  // Missing, and the project lists it: its own install comes first, in its folder.
  {
    id: "cloudflare",
    status: "tool_missing",
    signIn: "wrangler login",
    check: "wrangler whoami",
    ran: "none",
    tool: {
      name: "wrangler",
      state: "missing",
      folder: "/Users/you/Projects/site/platform",
      install: "cd /Users/you/Projects/site/platform && npm install",
      newShell: false,
      signIn: "cd /Users/you/Projects/site/platform && npx wrangler login",
      check: "cd /Users/you/Projects/site/platform && npx wrangler whoami",
      appPath: null,
    },
  },
  // Missing, with an installer of its own and a new Terminal window after it.
  {
    id: "google-cloud",
    status: "tool_missing",
    signIn: "gcloud auth login --no-launch-browser",
    check: "gcloud auth list",
    ran: "none",
    tool: {
      name: "gcloud",
      state: "missing",
      folder: null,
      install: "curl https://sdk.cloud.google.com | bash",
      newShell: true,
      signIn: "gcloud auth login --no-launch-browser",
      check: "gcloud auth list",
      appPath: null,
    },
  },
  // There, but only in the app's own folder: the commands add that folder to PATH first.
  {
    id: "npm",
    status: "not_signed_in",
    signIn: "npm login",
    check: "npm whoami",
    ran: "tool",
    tool: {
      name: "npm",
      state: "app",
      folder: null,
      install: null,
      newShell: false,
      signIn: 'export PATH=/Users/you/.specwithcode/commands:"$PATH" && npm login',
      check: 'export PATH=/Users/you/.specwithcode/commands:"$PATH" && npm whoami',
      appPath: "/Users/you/.specwithcode/commands/npm",
    },
  },
  {
    id: "ssh",
    status: "unknown",
    signIn: "ssh-keygen -t ed25519",
    check: null,
  },
];
export const linkCopyAsWorkers = async () => ({ status: "linked" });
export const filesystemEnvironment = { browse: (value: unknown) => value };
export const useFilesystemReadAccess = () => ({ canReadFiles: true });
export const useEnvironmentQuery = () => ({
  data: { parentPath: "/home/anton", entries: [] },
  isPending: false,
});
const fixtureParams = new URLSearchParams(location.search);
let incompleteUndo = fixtureParams.get("undo") === "incomplete";
const undoCommitted = fixtureParams.get("committed") === "true";
let applied = incompleteUndo;
let attempted = false;
let published = false;
let op = incompleteUndo ? "00000000-0000-4000-8000-000000000009" : "";
let mode = incompleteUndo && !undoCommitted ? "copy-and-move" : "copy-only";
let targetFolder = incompleteUndo ? "/home/anton/Projects/project" : "";
const umbrella = "/Users/you/Projects/github/specweave-umb";
const child = "repositories/anton-abyzov/specweave";
let copyRoot = umbrella;
let projectRelativePath = child;
const FINISHED_AT = new Date(Date.now() - 2 * 60 * 60 * 1000).toISOString();
const status = (state: string) => ({
  operationId: op,
  sourceEnvironmentId: "m4",
  sourceProjectId: "source",
  sourceMachine: "MacBook M4",
  mode,
  targetFolder,
  copyRoot,
  ...(fixture.captured ? { capturedAt: 1793061500000 } : {}),
  projectRelativePath,
  projectFolder:
    projectRelativePath === "." ? targetFolder : `${targetFolder}/${projectRelativePath}`,
  title: "SpecWeave",
  selection: [],
  mirror: false,
  state: incompleteUndo ? "failed" : state,
  undoIncomplete: incompleteUndo,
  failedStep: incompleteUndo ? "applied" : state === "failed" ? "transfer" : null,
  error: incompleteUndo
    ? {
        code: "copy_failed",
        message:
          "Undo did not finish: report: EACCES: cannot list this folder. Retry Undo after restoring access.",
      }
    : state === "failed"
      ? { message: "The copy connection was interrupted." }
      : null,
  progress: null,
  disk: null,
  // One repository the destination does not have yet, so a one-click copy approves itself.
  rows: [
    {
      id: `repo:${child}`,
      kind: "repository",
      path: child,
      status: fixture.destinationHasFiles ? "conflict" : "new",
      detail: fixture.destinationHasFiles
        ? "Reviewed changes to existing files."
        : "Not on this machine yet.",
      filesToMove: 8,
      bytesToMove: 2048,
      bytesPresent: fixture.destinationHasFiles ? 1024 : 0,
      choices: fixture.destinationHasFiles ? ["keep-mine", "take-theirs"] : [],
      decision: fixture.destinationHasFiles ? "take-theirs" : null,
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
  committed: incompleteUndo ? undoCommitted : state === "applied",
  projectId: state === "applied" ? "copied" : null,
  // Two hours before the page loaded, so the Done title reads "(added 2h ago)".
  ...(state === "applied" ? { finishedAt: FINISHED_AT } : {}),
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
  scanCurrent: true,
  destinationHasFiles: false,
  captured: false,
  failCopy: false,
  sourceChanges: null as null | {
    digest: string;
    total: number;
    truncated: boolean;
    acceptable: boolean;
    rows: Array<{ path: string; kind: string; size?: number }>;
  },
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
        error: Object.assign(new Error(failure.message), {
          code: failure.code,
          detail: failure.message,
        }),
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
      // Files changed on the source after copying: refused until this exact list is accepted.
      const changes = fixture.sourceChanges;
      if (input.publish && changes && input.acceptedSourceChanges !== changes.digest)
        return {
          _tag: "Failure",
          error: Object.assign(
            new Error("Files changed on the source after the copy. Review them before moving."),
            { code: "source_changed", changes },
          ),
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
        status: { state: "scanned", summary, error: null, scanCompletedAt: 1793061000000 },
      };
    } else if (name === "copySecrets") {
      value = {
        state: "scanned",
        summary,
        error: null,
        secrets: {
          files: (input.paths as string[]).map((path) => ({ path, size: 100 })),
          approvedAt: 1,
          destinationLabel: input.destinationLabel,
        },
      };
    } else if (name === "copySourceStatus") {
      // A reopened copy reads the measured summary back from the source.
      value = {
        state: "scanned",
        summary,
        error: null,
        progress: null,
        scanCompletedAt: 1793061000000,
        ...(fixture.captured ? { capturedAt: 1793061500000 } : {}),
        ...(input.refresh
          ? { freshness: { checkedAt: 1793062000000, current: fixture.scanCurrent, summary } }
          : {}),
      };
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
    else if (name === "copyUndo") {
      if (!input.preview) incompleteUndo = false;
      value = {
        status: status(input.preview ? "failed" : "undone"),
        items: [],
        edited: 0,
        undone: !input.preview,
        kept: [],
        problems: [],
      };
    } else if (name === "copyDrift") {
      // After a move without the reviewed paths, the source still holds them.
      const rows = published && fixture.sourceChanges ? fixture.sourceChanges.rows : [];
      value = {
        drift: {
          digest: "b".repeat(64),
          total: rows.length,
          rows,
          truncated: false,
          acceptable: true,
        },
        ...(rows.length > 0
          ? {
              leftOnSource: {
                digest: "b".repeat(64),
                total: rows.length,
                recordedAt: 1793063000000,
              },
            }
          : {}),
      };
    } else if (name === "copyRelease") value = { released: true };
    else if (name === "copySourceCancel") value = { state: "cancelled" };
    else if (name === "copyCancel") value = status("cancelled");
    else if (name === "credentials:scan")
      value = { rows: CREDENTIAL_ROWS, manifestProblem: null, truncated: false };
    else if (name === "credentials:probe")
      value = { results: CREDENTIAL_PROBES.filter((entry) => input.ids.includes(entry.id)) };
    else if (name === "credentials:save") value = { path: ".specweave/project/credentials.json" };
    else value = {};
    return { _tag: "Success", value };
  };
export const squashAtomCommandFailure = (value: any) => value.error;
// The machine menu reads copy roles, whose module also reads interrupted commands.
export const isAtomCommandInterrupted = () => false;
// Shared UI (toasts) reaches modules that build their commands at import: inert here.
export const createEnvironmentRpcCommand = () => ({});
export const createEnvironmentRpcQueryAtomFamily = () => () => ({});
export const runAtomCommand = async () => ({ _tag: "Success", value: undefined });
export const MachineReadinessChecklist = () => (
  <p className="text-xs text-muted-foreground">
    Synthetic readiness fixture; no provider session started.
  </p>
);
export const ProjectLinkDialog = () => null;
// "Install there" opens a terminal on the other machine; the fixture shows the button only.
export const CopyCredentialInstall = () => (
  <button
    type="button"
    className="rounded-md border px-2 py-1 text-xs"
    data-slot="copy-credential-install"
  >
    Install there
  </button>
);
// The wait for an install left running reads the same terminal state: nothing to show here.
export const CopyCredentialInstallWatch = () => null;
