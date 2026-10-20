import { createRoot } from "react-dom/client";
import { DownloadIcon } from "lucide-react";
import { scopeProjectRef } from "@specweave-studio/client-runtime/environment";
import type { EnvironmentProject } from "@specweave-studio/client-runtime/state/shell";
import {
  EnvironmentId,
  ProjectId,
  projectCloneProgressSummary,
  type FolderCopyRow,
  type FolderCopySourceSummary,
} from "@specweave-studio/contracts";
import { DraftId, useComposerDraftStore } from "../../src/composerDraftStore";
import { AddToMachineDialog } from "../../src/components/chat/AddToMachineDialog";
import { ComposerBannerStack } from "../../src/components/chat/ComposerBannerStack";
import { DraftMachinePicker } from "../../src/components/chat/DraftMachinePicker";
import { Button } from "../../src/components/ui/button";
import { DEFAULT_COPY_SELECTION } from "../../src/studio/folderCopy";
import { handlers } from "./mocks";
import "./fixture.css";

const params = new URLSearchParams(location.search);
const view = params.get("view") ?? "menu";
document.documentElement.classList.toggle("dark", params.get("theme") === "dark");
const draftId = DraftId.make("run-on-fixture");
useComposerDraftStore
  .getState()
  .setLogicalProjectDraftThreadId(
    "easychamp",
    scopeProjectRef(EnvironmentId.make("m4"), ProjectId.make("easychamp-m4")),
    draftId,
    {},
  );
useComposerDraftStore.getState().setPrompt(draftId, "Fix the bracket seeding");

const source = {
  id: "easychamp-m4",
  environmentId: "m4",
  title: "EasyChamp",
  workspaceRoot: "/Users/anton/Projects/easychamp",
  repositoryIdentity: {
    canonicalKey: "github.com/anton-abyzov/easychamp",
    rootPath: "/Users/anton/Projects/easychamp",
    locator: {
      source: "git-remote",
      remoteName: "origin",
      remoteUrl: "git@github.com:anton-abyzov/easychamp.git",
    },
  },
  workspaceSettings: null,
} as unknown as EnvironmentProject;
const total = (files: number, bytes: number) => ({ files, bytes });
const summary: FolderCopySourceSummary = {
  totals: {
    repository: total(4_210, 182_000_000),
    tracked: total(1_904, 41_000_000),
    untracked: total(12, 88_000),
    ignoredData: total(36, 240_000_000),
    rebuildable: total(61_000, 1_400_000_000),
    secret: total(2, 1_900),
  },
  repositories: [],
  secretFiles: [
    { path: ".env", size: 1_412 },
    { path: "apps/api/.env.local", size: 488 },
  ],
  linksOutside: 0,
  warnings: [],
};
const operationId = "7307ab55-fc59-4e07-abeb-de54be69215f";
handlers.copyOffer = () => ({
  operationId,
  sourceEnvironmentId: "m4",
  sourceProjectId: "easychamp-m4",
  sourceUrl: "https://m4.tailnet.example",
  sourceMachine: "MacBook M4MAX",
  token: "fixture",
  title: "EasyChamp",
  mode: "copy-only",
  status: { state: "scanned", summary, error: null },
});
handlers.inspectDestination = ({ input }: { input: { path: string } }) =>
  view === "consolidate"
    ? {
        path: input.path,
        state: "repository",
        originKey: "github.com/anton-abyzov/easychamp",
        sameRepository: true,
        checkedOut: true,
      }
    : {
        path: input.path,
        state: "missing",
        originKey: null,
        sameRepository: false,
        checkedOut: false,
      };
handlers.checkRemoteAccess = () => ({ status: "ok", detail: null });
handlers.copyStart = () => ({});
const row = (overrides: Partial<FolderCopyRow>): FolderCopyRow => ({
  id: "repo:.",
  kind: "repository",
  path: ".",
  status: "same",
  detail: "",
  filesToMove: 0,
  bytesToMove: 0,
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
handlers.copyStatus = () => ({
  operationId,
  sourceEnvironmentId: "m4",
  sourceProjectId: "easychamp-m4",
  sourceMachine: "MacBook M4MAX",
  mode: "copy-only",
  targetFolder: "/Users/anton/Code/champ-old",
  title: "EasyChamp",
  selection: [...DEFAULT_COPY_SELECTION],
  mirror: false,
  state: "previewed",
  failedStep: null,
  error: null,
  progress: null,
  disk: null,
  rows: [
    row({
      status: "diverged",
      detail: "Both machines have commits the other lacks. Nothing is lost either way.",
      filesToMove: 14,
      bytesToMove: 2_400_000,
      bytesPresent: 180_000_000,
      choices: ["keep-mine", "take-theirs", "leave-both"],
      needsDecision: true,
      conflicts: [
        {
          id: "repo:.:data/seeds/brackets.json",
          path: "data/seeds/brackets.json",
          reason: "differs",
          choices: ["keep-mine", "take-theirs", "keep-both"],
          decision: null,
        },
      ],
    }),
    row({
      id: "files",
      kind: "files",
      path: ".",
      status: "new",
      detail: "Files outside any repository.",
      filesToMove: 22,
      bytesToMove: 238_000_000,
    }),
  ],
  totals: {
    filesToMove: 36,
    bytesToMove: 240_400_000,
    bytesPresent: 180_000_000,
    decisionsNeeded: 2,
  },
  checks: [],
  warnings: [],
  unstable: [],
  committed: false,
  projectId: null,
  createdAt: "2026-10-20T19:00:00.000Z",
  updatedAt: "2026-10-20T19:00:00.000Z",
});

// The strip is ChatView's clone banner item, built the same way from a running clone.
const cloning = { stage: "receiving", percent: 45, detail: "82.4 MiB | 6.1 MiB/s" } as const;
const strip = (
  <ComposerBannerStack
    items={[
      {
        id: "project-clone:easychamp-studio",
        variant: "info",
        compact: true,
        priority: "activity",
        icon: <DownloadIcon />,
        title: "Cloning anton-abyzov/easychamp",
        description: projectCloneProgressSummary(cloning as never),
        actions: (
          <Button size="xs" variant="ghost" onClick={() => ((window as any).cancelled = true)}>
            Cancel
          </Button>
        ),
      },
    ]}
  />
);

createRoot(document.getElementById("root")!).render(
  <main className="min-h-screen bg-background p-8 text-foreground">
    <h1 className="mb-4 font-medium">EasyChamp</h1>
    {view === "strip" && <div className="mx-auto max-w-3xl">{strip}</div>}
    <div className="flex items-center gap-2 rounded-lg border p-2">
      <DraftMachinePicker
        draftId={draftId}
        disabled={false}
        sendInFlightRef={{ current: false }}
        onPendingChange={() => {}}
      />
    </div>
    {(view === "dialog" || view === "consolidate") && (
      <AddToMachineDialog
        open
        onOpenChange={() => {}}
        source={source}
        destinationEnvironmentId={EnvironmentId.make(view === "consolidate" ? "mini-2" : "studio")}
        onAdded={(target) => ((window as any).added = target)}
      />
    )}
  </main>,
);
