import { act, useCallback, useState } from "react";
import { vi, type Mock } from "vite-plus/test";
import { HandoffFolderCopy } from "./HandoffFolderCopy";
import { MachineHandoffDialog } from "./MachineHandoffDialog";
import { DEFAULT_COPY_SELECTION } from "../../studio/folderCopy";

// Shared by the folder copy UI tests. Mocks are hoisted per file, so each test file keeps
// its own vi.mock block and hoisted state; the fixtures and helpers live here.

export const total = (files: number, bytes: number) => ({ files, bytes });
export const summary = {
  totals: {
    repository: total(1, 10),
    tracked: total(1, 10),
    untracked: total(1, 10),
    ignoredData: total(1, 10),
    rebuildable: total(1, 10),
    secret: total(1, 10),
  },
  repositories: [],
  secretFiles: [{ path: ".env", size: 10 }],
  linksOutside: 0,
  warnings: [],
};
export const project = {
  id: "source",
  environmentId: "m4",
  title: "Project",
  workspaceRoot: "/Users/me/Projects/project",
};
export const copyStatus = (state: string, overrides: Record<string, unknown> = {}) => ({
  operationId: "00000000-0000-4000-8000-000000000001",
  sourceEnvironmentId: "m4",
  sourceProjectId: "source",
  sourceMachine: "M4",
  mode: "copy-only",
  targetFolder: "/Users/me/Projects/project",
  title: "Project",
  selection: DEFAULT_COPY_SELECTION,
  mirror: false,
  state,
  failedStep: null,
  error: null,
  progress: null,
  disk: null,
  rows: [],
  totals: { filesToMove: 5, bytesToMove: 50, bytesPresent: 0, decisionsNeeded: 0 },
  checks: [],
  warnings: [],
  unstable: [],
  committed: state === "applied",
  projectId: state === "applied" ? "copied" : null,
  createdAt: "2026-10-19T20:00:00.000Z",
  updatedAt: "2026-10-19T20:00:00.000Z",
  ...overrides,
});
export const newRow = (path: string, overrides: Record<string, unknown> = {}) => ({
  id: `repo:${path}`,
  kind: "repository",
  path,
  status: "new",
  detail: "Not on this machine yet.",
  filesToMove: 1,
  bytesToMove: 10,
  bytesPresent: 0,
  choices: [],
  decision: null,
  needsDecision: false,
  conflicts: [],
  moreConflicts: 0,
  cloneAvailable: false,
  clone: false,
  ...overrides,
});
export const noSecrets = { ...summary, secretFiles: [] };

export const onOpenProject: Mock = vi.fn();
export const onBusyChange: Mock = vi.fn();
export const onDialogClose: Mock = vi.fn();
export const stepState = () =>
  [...document.querySelectorAll('[data-slot="copy-step"]')].map(
    (step) =>
      `${step.querySelector('[data-slot="copy-step-label"]')?.textContent}:${step.getAttribute("data-state")}`,
  );
/**
 * The button in `scope` whose whole text is `label`, or an item of an open ⋯ menu (menus
 * render in a portal); throws with the scope's text if none.
 */
export const findButton = (scope: ParentNode, label: string) => {
  const element = [
    ...scope.querySelectorAll<HTMLButtonElement>("button"),
    ...document.querySelectorAll<HTMLButtonElement>('[role="menuitem"]'),
  ].find((node) => node.textContent?.trim() === label);
  if (!element) throw new Error(`Missing button ${label}: ${scope.textContent}`);
  return element;
};

/** The stub commands every folder copy test starts from; `nextStatus` answers copyStatus. */
export const copyHandlers = ({
  calls,
  nextStatus,
}: {
  readonly calls: () => ReadonlyArray<[string, unknown]>;
  readonly nextStatus: () => Record<string, unknown>;
}): Record<string, (input: unknown) => unknown> => ({
  copyScopes: () => ({
    projectRoot: project.workspaceRoot,
    recommendedCopyRoot: project.workspaceRoot,
    scopes: [
      {
        copyRoot: project.workspaceRoot,
        projectRelativePath: ".",
        kind: "project",
        label: "This project folder",
        repositories: [],
        truncated: false,
      },
    ],
  }),
  copyCapabilities: () => ({ scopeVersion: 1 }),
  copyOffer: ({ input }: any) => ({
    operationId: input.operationId,
    sourceEnvironmentId: "m4",
    sourceProjectId: "source",
    sourceUrl: "https://m4.example.ts.net",
    sourceMachine: "M4",
    token: "grant",
    title: "Project",
    mode: input.mode,
    status: { state: "scanned", summary, error: null },
  }),
  copyStart: () => copyStatus("scanning"),
  copyStatus: () => nextStatus(),
  copyApprove: () => copyStatus("approved"),
  copyDecide: () => copyStatus("previewed"),
  copyCancel: () => copyStatus("cancelled"),
  copySourceCancel: () => ({ state: "cancelled" }),
  copyRelease: () => ({ released: true }),
  prepare: ({ input }: any) => ({
    // The source keeps the published bundle; later prepares return it as published.
    publication:
      input.publish || calls().filter(([name]) => name === "prepare").length > 2
        ? "published"
        : "unpublished",
    bundle: {
      digest: "d".repeat(64),
      manifest: { operationId: input.operationId, repositories: [] },
      destination: input.destination,
      sourceEnvironmentId: "m4",
      sourceProjectId: "source",
      sourceThreadId: "coordinator",
    },
  }),
  receive: ({ input }: any) => ({
    phase: input.mode === "preview" ? "ready" : "started",
    executionMode: "project-folder",
    projectId: input.projectId,
    coordinatorThreadId: `project-coordinator:${input.projectId}`,
  }),
});

export interface FixtureOptions {
  coordinatorId?: string | null;
  canMove?: boolean;
  savedFolder?: string;
  m1Available?: boolean;
  savedProject?: (environmentId: string, folder: string) => Record<string, unknown> | null;
  dialog?: boolean;
  workspaceRoot?: string;
  /** As the dialog passes them when opened for Move project or Move coordinator to X. */
  defaultMode?: "copy-only" | "copy-and-move";
  preferredMachine?: string;
  machineRequested?: boolean;
}
export function CopyFixture(overrides: FixtureOptions) {
  const [busy, setBusy] = useState(false);
  const [locked, setLocked] = useState(false);
  const [doneOn, setDoneOn] = useState<string | null>(null);
  const updateBusy = useCallback((value: boolean) => {
    onBusyChange(value);
    setBusy(value);
  }, []);
  const flow = (
    <HandoffFolderCopy
      project={
        { ...project, workspaceRoot: overrides.workspaceRoot ?? project.workspaceRoot } as never
      }
      coordinatorId={(overrides.coordinatorId ?? "coordinator") as never}
      sourceLabel="M4"
      method="copy"
      machines={[
        { id: "m3" as never, label: "M3", unavailable: null },
        {
          id: "m1" as never,
          label: "M1",
          unavailable: overrides.m1Available ? null : "Connect first",
        },
      ]}
      savedFolder={() => overrides.savedFolder ?? null}
      savedProject={overrides.savedProject as never}
      canMove={overrides.canMove ?? true}
      {...(overrides.defaultMode ? { defaultMode: overrides.defaultMode } : {})}
      {...(overrides.preferredMachine
        ? { preferredMachine: overrides.preferredMachine as never }
        : {})}
      {...(overrides.machineRequested ? { machineRequested: true } : {})}
      onBusyChange={overrides.dialog ? updateBusy : onBusyChange}
      onCloseLockChange={setLocked}
      onOpenProject={onOpenProject}
      {...(overrides.dialog
        ? {
            onChoicesChange: ({ machine, done }: { machine: string | null; done: boolean }) =>
              setDoneOn(done ? (machine === "m1" ? "M1" : "M3") : null),
          }
        : {})}
    />
  );
  return overrides.dialog ? (
    <MachineHandoffDialog
      open
      onOpenChange={onDialogClose}
      sourceLabel="M4"
      projectTitle="Project"
      destinations={[]}
      selected=""
      onSelect={() => {}}
      method="copy"
      onMethodChange={() => {}}
      copyBusy={busy}
      copyLocked={locked}
      copyDoneOn={doneOn}
      copyFlow={flow}
      preview={null}
      phase="choose"
      consent={false}
      onConsent={() => {}}
      error={null}
      onReview={() => {}}
      onContinue={() => {}}
      onOpenDestination={() => {}}
    />
  ) : (
    flow
  );
}

/** Opens the Done screen's ⋯ menu, whose items `findButton` then finds too. */
export const openMore = async () => {
  const trigger = document.querySelector<HTMLButtonElement>('button[aria-label="More actions"]');
  if (!trigger) throw new Error(`Missing More actions: ${document.body.textContent}`);
  await act(async () => trigger.click());
};

/** The ⋯ menu's items while it is open. */
export const moreItems = () =>
  [...document.querySelectorAll<HTMLElement>('[role="menuitem"]')].map((item) =>
    item.textContent?.trim(),
  );

/** A button's or a menu item's disabled state. */
export const isDisabled = (element: HTMLElement) =>
  (element as HTMLButtonElement).disabled === true ||
  element.getAttribute("aria-disabled") === "true" ||
  element.hasAttribute("data-disabled");
