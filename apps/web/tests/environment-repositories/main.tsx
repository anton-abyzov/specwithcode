// Synthetic data only: no server, account, provider or store.
import { useState } from "react";
import { createRoot } from "react-dom/client";
import type {
  EnvironmentId,
  ProjectEnvironmentReadResult,
  ProjectFoundRepository,
} from "@specweave-studio/contracts";

import {
  AGENT_DECIDES,
  threadRepositoriesLabel,
  threadRepositoryEvents,
  type ComposerRepositoryPick,
} from "../../src/components/BranchToolbar.logic";
import {
  ThreadRepositoriesChip,
  ThreadRepositoriesList,
  ThreadRepositoryEventRows,
} from "../../src/components/chat/ThreadRepositories";
import { ComposerRepositoriesControl } from "../../src/components/chat/WorkspaceModeControl";
import { ProjectEnvironment } from "../../src/components/studio/ProjectEnvironment";
import { applyThemePalette } from "../../src/themePalette";
import "./fixture.css";

const params = new URLSearchParams(location.search);
const dark = params.get("theme") === "dark";
document.documentElement.classList.toggle("dark", dark);
applyThemePalette("studio-chat", dark ? "dark" : "light");

const root = "/Users/sam/Projects/acme-umbrella";
const repository = (
  name: string,
  overrides: Partial<ProjectFoundRepository> = {},
): ProjectFoundRepository => ({
  relativePath: `repositories/acme/${name}`,
  path: `${root}/repositories/acme/${name}`,
  name,
  origin: `acme/${name}`,
  branch: "main",
  defaultBranch: "main",
  inSpecweave: false,
  state: "available",
  noRemote: false,
  threadWorktrees: 0,
  ...overrides,
});
const found = [
  repository("app-dev", { origin: "acme/app", branch: null, threadWorktrees: 2 }),
  repository("app", { branch: "fix/aide-opens-own-machine" }),
  repository("cli", { inSpecweave: true, branch: "home-animated-story", threadWorktrees: 1 }),
  repository("skills", { inSpecweave: true }),
  repository("skills-platform", { inSpecweave: true, branch: "fix/theme-hover-submit-clarity" }),
  repository("status", { branch: "codex/1196-status-evidence" }),
  repository("greeter", { origin: null, noRemote: true }),
];
const saved = [
  { id: "old-dev", url: "https://github.com/acme/app-dev.git", localPath: found[0]!.path },
  { id: "old-app", url: "https://github.com/acme/app.git", localPath: null },
];
const thread = {
  folder: "/Users/sam/.app/worktrees/acme-umbrella/fix-environment-list",
  branch: "fix/environment-list",
  limit: 8,
  repositories: [
    {
      relativePath: "repositories/acme/app-dev",
      name: "app-dev",
      path: "/Users/sam/.app/worktrees/acme-umbrella/fix-environment-list/repositories/acme/app-dev",
      repository: found[0]!.path,
      baseRef: "origin/main",
      addedBy: "agent" as const,
      addedAt: "2026-11-12T10:00:00.000Z",
      dependencies: "installed" as const,
      changed: true,
    },
    {
      relativePath: "repositories/acme/cli",
      name: "cli",
      path: "/Users/sam/.app/worktrees/acme-umbrella/fix-environment-list/repositories/acme/cli",
      repository: found[2]!.path,
      baseRef: "home-animated-story",
      addedBy: "user" as const,
      addedAt: "2026-11-12T10:20:00.000Z",
      dependencies: "not_installed" as const,
      changed: false,
    },
  ],
};
const base = {
  revision: 3,
  workspaceRoot: root,
  additionalFolders: [found[0]!.path],
  repositories: saved.map((entry) => ({ ...entry, status: "ready" as const })),
  rootIsRepository: true,
  foundMore: 0,
  skippedLinks: [{ path: "repositories/acme/app-studio", target: "repositories/acme/app-dev" }],
  redundantEntries: [
    { repositoryId: "old-dev", reason: "found_clone" as const },
    { repositoryId: "old-app", reason: "no_folder" as const },
  ],
};
const cases: Record<string, ProjectEnvironmentReadResult> = {
  umbrella: { ...base, found, thread },
  clone: {
    ...base,
    additionalFolders: [],
    repositories: [],
    redundantEntries: [],
    skippedLinks: [],
    found: [
      found[2]!,
      repository("skills-platform", { inSpecweave: true, state: "absent", branch: null }),
      repository("archive", {
        state: "missing",
        branch: null,
        repositoryId: "archive",
        relativePath: "elsewhere/archive",
      }),
    ],
  },
  single: {
    ...base,
    additionalFolders: [],
    repositories: [],
    redundantEntries: [],
    skippedLinks: [],
    found: [],
  },
  older: {
    revision: 3,
    workspaceRoot: root,
    additionalFolders: [],
    repositories: base.repositories,
  },
};
const selected = params.get("case") ?? "umbrella";
const fixture = {
  read: cases[selected]!,
  refs: ["main", "release/1.0", "home-animated-story"],
  calls: [],
};
(window as unknown as { __environmentFixture: typeof fixture }).__environmentFixture = fixture;

const environmentId = "this-mac" as EnvironmentId;
const project = {
  id: "project",
  environmentId,
  title: "Acme",
  workspaceRoot: root,
  defaultThreadEnvMode: params.get("worktrees") === "off" ? "local" : "worktree",
} as never;

function Composer() {
  const [pick, setPick] = useState<ComposerRepositoryPick>(AGENT_DECIDES);
  return (
    <div
      className="flex items-center gap-2 rounded-lg border p-2 text-xs"
      data-pick={JSON.stringify(pick)}
    >
      <span className="text-muted-foreground">Use worktree</span>
      <ComposerRepositoriesControl
        environmentId={environmentId}
        found={found}
        pick={pick}
        onChange={setPick}
      />
    </div>
  );
}

function App() {
  const [environment, setEnvironment] = useState({
    additionalFolders: [...cases[selected]!.additionalFolders],
    repositories: selected === "umbrella" || selected === "older" ? saved : [],
  });
  const [general, setGeneral] = useState(false);
  const read = cases[selected]!;
  return (
    <main className="mx-auto flex max-w-3xl flex-col gap-8 p-4" data-case={selected}>
      <section data-section="environment" data-opened-general={general ? "" : undefined}>
        <ProjectEnvironment
          project={project}
          projectKey="acme"
          kind="code"
          value={environment}
          revision={3}
          dirty={false}
          disabled={false}
          admissionBlocked={false}
          navigationBlocked={false}
          onChange={setEnvironment}
          onPrepared={() => {}}
          onDraftChange={() => {}}
          onBusyChange={() => {}}
          onOpenGeneral={() => setGeneral(true)}
        />
      </section>
      {read.thread !== undefined && (
        <section data-section="thread" className="flex flex-col gap-3">
          <h2 className="text-sm font-medium">Thread</h2>
          <div className="flex items-center gap-2" data-thread-header="">
            <ThreadRepositoriesChip
              shell={{
                environmentId,
                projectId: "project" as never,
                id: "thread" as never,
                worktreePath: read.thread.folder,
              }}
            />
            <span className="text-xs text-muted-foreground" data-thread-label="">
              {threadRepositoriesLabel(read.thread.branch, read.thread.repositories.length)}
            </span>
          </div>
          <div className="max-w-sm rounded-lg border p-3" data-thread-popover="">
            <ThreadRepositoriesList
              thread={read.thread}
              found={read.found}
              pullRequests={[
                { repository: "acme/app", number: 190, url: "https://example.invalid/190" },
              ]}
              adding={null}
              error={null}
              onAdd={() => {}}
            />
          </div>
          <div data-thread-timeline="">
            <ThreadRepositoryEventRows events={threadRepositoryEvents(read.thread)} />
          </div>
          <div data-thread-empty="">
            <ThreadRepositoryEventRows
              events={threadRepositoryEvents({ ...read.thread, repositories: [] })}
            />
          </div>
        </section>
      )}
      {selected === "umbrella" && (
        <section data-section="composer" className="flex flex-col gap-3">
          <h2 className="text-sm font-medium">Composer</h2>
          <Composer />
        </section>
      )}
    </main>
  );
}

createRoot(document.getElementById("root")!).render(<App />);
