/* Synthetic data only: the project "Atlas" on fictional machines m4, m5, m1, m3 and linux-mini.
   Nothing here talks to a server or touches a folder: the dialog gets a scripted API that
   answers from the facts below, and every sentence comes from the real plan and wording code.
   `?case=`
     dialog   the Sync dialog on m4's page, `&state=`
                plan            every repository row of the plan, extras on both machines
                small           one repository to move forward, nothing else
                idle            both machines level, nothing to do
                picker          several machines: one open, one offline, one from before Sync,
                                one this window can only read
                checking        the fetch has not answered
                scan-limited    m5's folder is past the scan limits
                inventory-failed  m5 could not list its extras
                run-refused     Git refuses one step on m5 and m5's run fails on another
                extras-failed   m4 could not send its extras
                long            the November 18 state of a busy machine: 179 uncommitted
                                files and 11 branches that exist only on m4
                offline | read-only | needs-update | not-found | not-git | failed | unreadable
                                why m5 could not take part in the check
              `&hold=run` keeps the run from answering, for the running screen
     menu     the machine menu on m4's page with each sync fact, "Sync…" and
              "Add to another machine…"; `&blocked=1` greys "Sync…" with its reason;
              `&window=read-only` is a window that can only read: the real menu hook, fed
              each machine's status, shows the facts and greys "Sync…"
   `?theme=dark`, `?lang=` the interface language. */
import { useState } from "react";
import { createRoot } from "react-dom/client";
import {
  createMemoryHistory,
  createRootRoute,
  createRouter,
  RouterProvider,
} from "@tanstack/react-router";
import type {
  ProjectSyncExtraResult,
  ProjectSyncFetchResult,
  ProjectSyncInventoryResult,
  ProjectSyncRepositoryFacts,
  ProjectSyncStepResult,
} from "@specweave-studio/contracts";
import { projectSyncUpstreamGoneDetail } from "@specweave-studio/contracts";
import type { EnvironmentProject } from "@specweave-studio/client-runtime/state/shell";
import {
  OrchestratorSwitcher,
  type MachineRowReach,
} from "../../src/components/studio/OrchestratorSwitcher";
import { ProjectSyncDialog, type SyncTarget } from "../../src/components/studio/ProjectSyncDialog";
import {
  syncBlockedOn,
  syncRowFact,
  useProjectSyncMenu,
} from "../../src/components/studio/useProjectSyncMenu";
import { TooltipProvider } from "../../src/components/ui/tooltip";
import { ToastProvider, AnchoredToastProvider } from "../../src/components/ui/toast";
import { isLocale, setLocalePreference } from "../../src/i18n";
import { orchestratorCopies } from "../../src/studio/projectCoordinatorMachine";
import {
  refreshSyncStatus,
  type ProjectSyncApi,
  type SyncMachine,
  type SyncOutcome,
  type SyncStatusRead,
} from "../../src/studio/projectSync";
import { applyThemePalette } from "../../src/themePalette";
import "./fixture.css";

const params = new URLSearchParams(location.search);
const dark = params.get("theme") === "dark";
document.documentElement.classList.toggle("dark", dark);
applyThemePalette("studio-chat", dark ? "dark" : "light");
const lang = params.get("lang");
if (lang && isLocale(lang)) setLocalePreference(lang);

const view = params.get("case") ?? "dialog";
const state = params.get("state") ?? "plan";
const PROJECT = "Atlas";
const NOW = 1_800_000_000_000;

declare global {
  interface Window {
    /** Everything the page was asked to do, in order: calls, with what they carried. */
    __events?: string[];
  }
}
const record = (event: string) => (window.__events ??= []).push(event);

const machine = (id: string): SyncMachine => ({
  environmentId: id as never,
  projectId: "p" as never,
  label: id,
});
const M4 = machine("m4");
const M5 = machine("m5");

// ---------------------------------------------------------------------------
// What each machine's fetch answers
// ---------------------------------------------------------------------------

const sha = (letter: string) => letter.repeat(40);
const facts = (
  path: string,
  extra: Partial<ProjectSyncRepositoryFacts> = {},
): ProjectSyncRepositoryFacts => ({
  path,
  branch: "main",
  head: sha("a"),
  upstream: "origin/main",
  ahead: 0,
  behind: 0,
  uncommitted: 0,
  inUseBy: null,
  remote: `https://git.example.com/acme/${path === "." ? "atlas" : path.replace("/", "-")}.git`,
  fetch: "ok",
  fetchError: null,
  ...extra,
});
const NO_REMOTE = { upstream: null, remote: null, fetch: "no-remote" } as const;

/** One repository per row of the plan table: [path, on m4, on m5]; null is "not there". */
const PLAN_ROWS: ReadonlyArray<
  readonly [
    string,
    Partial<ProjectSyncRepositoryFacts> | null,
    Partial<ProjectSyncRepositoryFacts> | null,
  ]
> = [
  // Level on both, with uncommitted files and a thread at work on m5: never a bare "Up to date".
  [".", {}, { uncommitted: 2, inUseBy: "Docs lint" }],
  ["apps/web", { behind: 99 }, {}],
  ["packages/ui", { ahead: 3 }, { behind: 1 }],
  ["apps/status", { ahead: 2, behind: 5 }, {}],
  ["apps/platform", {}, { behind: 4, uncommitted: 3 }],
  ["apps/api", {}, { behind: 7, inUseBy: "Fix the login redirect" }],
  ["tools/cli", {}, { branch: "feature/flags", upstream: "origin/feature/flags", head: sha("c") }],
  ["docs", {}, { branch: null, upstream: null, head: sha("d") }],
  [
    "vendor/mirror",
    { branch: "local-patches", upstream: null, ahead: 0 },
    { branch: "local-patches", upstream: null },
  ],
  ["notes", NO_REMOTE, NO_REMOTE],
  ["apps/site", {}, null],
  ["scratch", NO_REMOTE, null],
  [
    "apps/worker",
    {},
    {
      fetch: "failed",
      fetchError: "fatal: unable to access the remote: could not resolve host",
    },
  ],
  ["infra", { fetch: "unusual-config", fetchError: "remote.origin.fetch" }, {}],
];
const side = (index: 1 | 2): ProjectSyncFetchResult => ({
  scanLimited: false,
  repositories: PLAN_ROWS.flatMap((row) => {
    const extra = row[index];
    return extra ? [facts(row[0], extra)] : [];
  }),
});
const LEVEL: ProjectSyncFetchResult = {
  scanLimited: false,
  repositories: [facts("."), facts("apps/web")],
};
const FETCHED: Record<string, Record<string, ProjectSyncFetchResult>> = {
  plan: { m4: side(1), m5: side(2) },
  small: {
    m4: LEVEL,
    m5: { scanLimited: false, repositories: [facts("."), facts("apps/web", { behind: 12 })] },
  },
  idle: { m4: LEVEL, m5: LEVEL },
  // Upstreams Sync does not move to: one that is no branch of origin, one gone from origin,
  // and a machine on an older version that names neither.
  upstream: {
    m4: {
      scanLimited: false,
      repositories: [
        facts("."),
        facts("apps/web", {
          branch: "feature/menu",
          upstream: null,
          otherUpstream: "second/feature/menu",
        }),
        facts("apps/api", {
          branch: "release",
          upstream: "origin/release",
          behind: 3,
          upstreamGone: true,
        }),
        facts("docs", { branch: "drafts", upstream: null }),
        facts("apps/status", { behind: 2 }),
        facts("apps/worker", { behind: 4 }),
        // Behind in the plan; at the run its state cannot be read, so no count is invented.
        facts("tools/cli", { behind: 1 }),
      ],
    },
    m5: {
      scanLimited: false,
      repositories: [
        facts("."),
        facts("apps/web", { branch: "feature/menu", upstream: "origin/feature/menu" }),
        facts("apps/api", { branch: "release", upstream: "origin/release" }),
        facts("docs", { branch: "drafts", upstream: "origin/drafts" }),
        facts("apps/status"),
        facts("apps/worker"),
        facts("tools/cli"),
        facts("apps/site"),
      ],
    },
  },
  long: { m4: LEVEL, m5: LEVEL },
  "scan-limited": {
    m4: LEVEL,
    m5: { scanLimited: true, repositories: [facts(".", { behind: 2 })] },
  },
};

// ---------------------------------------------------------------------------
// What is only on one machine
// ---------------------------------------------------------------------------

const EMPTY: ProjectSyncInventoryResult = { repositories: [], scanLimited: false };
const ONLY_ON_M4: ProjectSyncInventoryResult = {
  scanLimited: false,
  repositories: [
    {
      path: ".",
      notPushed: [{ branch: "fix/menu", head: sha("b"), commits: 10 }],
      onlyHere: [{ branch: "spike/cache", head: sha("e"), commits: 2 }],
      branchesNotListed: 0,
      changedFiles: 3,
      untrackedFiles: 4,
      stashes: 1,
      leftOut: [
        // A secret by its name, a file with a token inside, and one past what a snapshot reads.
        { path: ".env.local", reason: "name", kind: null, modifiedAtMs: NOW },
        { path: "notes/keys.txt", reason: "content", kind: "GitHub token", modifiedAtMs: NOW },
        { path: "media/walkthrough.mov", reason: "not-checked", kind: null, modifiedAtMs: NOW },
      ],
      leftOutNotListed: 2,
    },
    {
      path: "packages/ui",
      notPushed: [{ branch: "main", head: sha("f"), commits: 3 }],
      onlyHere: [],
      branchesNotListed: 0,
      changedFiles: 0,
      untrackedFiles: 0,
      stashes: 0,
      leftOut: [],
      leftOutNotListed: 0,
    },
  ],
};
/** A machine in the middle of work: 179 uncommitted files and 11 branches only there. */
const LONG_ON_M4: ProjectSyncInventoryResult = {
  scanLimited: false,
  repositories: [
    {
      path: ".",
      notPushed: [{ branch: "fix/menu", head: sha("b"), commits: 10 }],
      onlyHere: [
        "spike/cache",
        "spike/sidebar-order",
        "try/menu-facts",
        "try/sync-dialog-table",
        "wip/release-notes",
        "wip/onboarding-copy",
        "review/access-lines",
        "review/provider-accounts-second-pass",
        "backup/before-rebase",
        "experiment/long-branch-name-for-a-layout-check",
        "tmp/one-more",
      ].map((branch, at) => ({ branch, head: sha("e"), commits: at + 1 })),
      branchesNotListed: 0,
      changedFiles: 131,
      untrackedFiles: 48,
      stashes: 3,
      leftOut: [
        { path: ".env.local", reason: "name", kind: null, modifiedAtMs: NOW },
        { path: "notes/keys.txt", reason: "content", kind: "GitHub token", modifiedAtMs: NOW },
        { path: "media/walkthrough.mov", reason: "not-checked", kind: null, modifiedAtMs: NOW },
      ],
      leftOutNotListed: 0,
    },
  ],
};
const ONLY_ON_M5: ProjectSyncInventoryResult = {
  scanLimited: false,
  repositories: [
    {
      path: "apps/platform",
      notPushed: [],
      onlyHere: [],
      branchesNotListed: 0,
      changedFiles: 3,
      untrackedFiles: 0,
      stashes: 0,
      leftOut: [],
      leftOutNotListed: 0,
    },
  ],
};

// ---------------------------------------------------------------------------
// Failures, as the calls give them
// ---------------------------------------------------------------------------

const CAUSES: Record<string, unknown> = {
  offline: { _tag: "EnvironmentRpcUnavailableError", message: "The machine is not connected." },
  "read-only": { _tag: "EnvironmentAuthorizationError", message: "Missing scope." },
  "needs-update": "Unknown request tag: projectSync.fetch",
  "not-found": { _tag: "ProjectSyncError", code: "not_found", reason: "No such project." },
  "not-git": { _tag: "ProjectSyncError", code: "invalid", reason: "Not a Git repository." },
  failed: {
    _tag: "ProjectSyncError",
    code: "failed",
    reason: "The project folder is on a drive that is not connected",
  },
  // An answer with a value this version does not know fails to decode as a whole.
  unreadable: { _tag: "SchemaError", message: 'Expected "behind" | "missing", got "held"' },
};

const never = <A,>() => new Promise<SyncOutcome<A>>(() => {});
const answer = <A,>(value: A): SyncOutcome<A> => ({ ok: true, value });
const hold = params.get("hold");

const stepResult = (
  path: string,
  extra: Partial<ProjectSyncStepResult>,
): ProjectSyncStepResult => ({
  path,
  action: "fast-forward",
  reason: "behind",
  branch: "main",
  otherBranch: "main",
  ahead: 0,
  behind: 0,
  uncommitted: 0,
  inUseBy: null,
  remote: null,
  detail: null,
  moved: 0,
  downgraded: false,
  ...extra,
});
/** How far each repository of the plan is behind, so a result says what moved. */
const BEHIND: Record<string, number> = {
  "m4:apps/web": 99,
  "m5:packages/ui": 1,
  "m5:apps/web": 12,
  "m5:.": 2,
};

const api: ProjectSyncApi = {
  status: async () => ({ ok: false, cause: CAUSES.failed }),
  fetch: async (on) => {
    record(`fetch:${on.label}`);
    if (state === "checking") return never();
    if (on.label === "m5" && state in CAUSES) return { ok: false, cause: CAUSES[state] };
    const from = FETCHED[state] ?? FETCHED.plan!;
    return answer(from[on.label]!);
  },
  inventory: async (on) => {
    record(`inventory:${on.label}`);
    if (state === "inventory-failed" && on.label === "m5")
      return { ok: false, cause: CAUSES.offline };
    if (state === "long") return answer(on.label === "m4" ? LONG_ON_M4 : EMPTY);
    if (FETCHED[state] && state !== "plan") return answer(EMPTY);
    return answer(on.label === "m4" ? ONLY_ON_M4 : ONLY_ON_M5);
  },
  run: async (on, plan) => {
    record(`run:${on.label}:${JSON.stringify(plan)}`);
    if (hold === "run") return never();
    if (state === "run-refused" && on.label === "m4") return { ok: false, cause: CAUSES.offline };
    // The branch went from origin after the fetch, origin could not be asked, and a clone
    // that was stopped left a folder Sync could not remove.
    if (state === "upstream")
      return answer({
        repositories: [
          ...plan.fastForward.map((item) =>
            item.path === "tools/cli"
              ? stepResult(item.path, {
                  action: "fetch",
                  reason: "uncommitted",
                  behind: 1,
                  uncommitted: 0,
                  detail: "Its state could not be read, so it was not moved.",
                  downgraded: true,
                })
              : item.path === "apps/status"
                ? stepResult(item.path, {
                    action: "none",
                    reason: "no-upstream",
                    behind: 2,
                    detail: projectSyncUpstreamGoneDetail("origin/main"),
                    downgraded: true,
                  })
                : stepResult(item.path, {
                    action: "none",
                    reason: "refused",
                    behind: 4,
                    detail: "origin could not be asked whether the branch is still there.",
                    downgraded: true,
                  }),
          ),
          ...plan.clone.flatMap((item) => [
            stepResult(".apps-site.clone-7f3a", {
              action: "none",
              reason: "refused",
              branch: null,
              otherBranch: null,
              detail:
                "A clone that was stopped left this folder behind, and it could not be removed.",
            }),
            stepResult(item.path, { action: "clone", reason: "missing", remote: item.remote }),
          ]),
        ],
      });
    return answer({
      repositories: [
        ...plan.fastForward.map((item) =>
          state === "run-refused"
            ? stepResult(item.path, {
                action: "none",
                reason: "refused",
                behind: 1,
                detail: "error: Your local changes to the following files would be overwritten",
              })
            : stepResult(item.path, { moved: BEHIND[`${on.label}:${item.path}`] ?? 1 }),
        ),
        ...plan.clone.map((item) =>
          state === "run-refused"
            ? stepResult(item.path, {
                action: "none",
                reason: "refused",
                branch: null,
                remote: item.remote,
                detail: "fatal: destination path already exists and is not an empty directory",
              })
            : stepResult(item.path, { action: "clone", reason: "missing", remote: item.remote }),
        ),
      ],
    });
  },
  sendExtras: async (source, target, sent) => {
    record(`extras:${source.label}>${target.label}:${JSON.stringify(sent.items)}`);
    if (state === "extras-failed") return { ok: false, cause: CAUSES.offline };
    const prefix = `swc/from-${source.label}`;
    return answer({
      items: sent.items.map((item): ProjectSyncExtraResult => {
        const base = {
          kind: item.kind,
          path: item.path,
          branch: item.kind === "branch" ? item.branch : null,
          stays: null,
          detail: null,
          includedCommits: 0,
          includedBranch: null,
          leftOut: [],
          leftOutNotListed: 0,
        };
        if (item.kind === "uncommitted") {
          // The top repository holds a file past the limit of one snapshot: it stays.
          if (item.path === ".")
            return {
              ...base,
              status: "stays",
              arrivedAs: null,
              landed: null,
              stays: "file-too-large",
              detail: "media/walkthrough.mov is 48 MB, over 10 MB.",
              bytes: 0,
            };
          return {
            ...base,
            status: "sent",
            arrivedAs: `${prefix}/uncommitted-20270115-141502-a3f9c1`,
            landed: "created",
            bytes: 48_213,
            includedCommits: 0,
          };
        }
        // A name the other machine already uses for other work arrives beside it.
        const beside = item.branch === "spike/cache";
        return {
          ...base,
          status: "sent",
          arrivedAs: beside ? `${prefix}/${item.branch}-a3f9c1` : `${prefix}/${item.branch}`,
          landed: beside ? "beside" : "created",
          bytes: beside ? 18_402 : 2_411_724,
        };
      }),
    });
  },
};

// ---------------------------------------------------------------------------
// The dialog
// ---------------------------------------------------------------------------

const open = (on: SyncMachine): SyncTarget => ({ machine: on, blocked: null });
const TARGETS: SyncTarget[] =
  state === "picker"
    ? [
        open(M5),
        {
          machine: machine("linux-mini"),
          blocked: syncBlockedOn({
            machine: "linux-mini",
            reach: "offline",
            read: undefined,
            version: null,
            access: "granted",
          }),
        },
        {
          machine: machine("m1"),
          blocked: syncBlockedOn({
            machine: "m1",
            reach: "open",
            read: { kind: "needs-update", at: NOW },
            version: "1.4.2",
            access: "granted",
          }),
        },
        {
          machine: machine("m3"),
          blocked: syncBlockedOn({
            machine: "m3",
            reach: "open",
            read: undefined,
            version: null,
            access: "denied",
          }),
        },
      ]
    : [open(M5)];

function DialogPage() {
  const [shown, setShown] = useState(true);
  return (
    <div className="fixture-page" data-dialog-page={shown ? "open" : "closed"}>
      {shown ? (
        <ProjectSyncDialog
          projectTitle={PROJECT}
          shown={M4}
          targets={TARGETS}
          onClose={() => {
            record("closed");
            setShown(false);
          }}
          onCompare={(target) => record(`compare:${target.label}`)}
          api={api}
        />
      ) : null}
    </div>
  );
}

// ---------------------------------------------------------------------------
// The machine menu: each sync fact, "Sync…" and "Add to another machine…"
// ---------------------------------------------------------------------------

const memberRef = (id: string) => ({
  environmentId: id,
  projectId: "p",
  coordinatorThreadId: "project-coordinator:p",
});
const ROSTER = ["m4", "m5", "m1", "linux-mini", "m3", "m2"];
const linked = (id: string, binding: object) =>
  ({
    environmentId: id,
    id: "p",
    title: PROJECT,
    workspaceRoot: "/w/atlas",
    workspaceSettings: {
      kind: "code",
      logicalProject: {
        id: "logical:atlas",
        title: PROJECT,
        coordinatorId: "coordinator:logical:atlas",
        members: ROSTER.map(memberRef),
      },
      coordinatorBinding: binding,
    },
  }) as unknown as EnvironmentProject;
const records = ROSTER.map((id) =>
  id === "m4"
    ? linked(id, { epoch: 0, state: "active" })
    : linked(id, { epoch: 0, state: "transferred", successor: memberRef("m4") }),
);
const copies = orchestratorCopies(
  records,
  (member) => member.environmentId,
  () => false,
);

const status = (heads: Record<string, string>, dirty: readonly string[] = []): SyncStatusRead => ({
  kind: "status",
  at: NOW - 25 * 60_000,
  status: {
    scanLimited: false,
    repositories: Object.entries(heads).map(([path, head]) => ({
      path,
      branch: "main",
      head: sha(head),
      clean: !dirty.includes(path),
    })),
  },
});
const HEADS = { ".": "a", "apps/web": "a", "apps/api": "a", "packages/ui": "a", docs: "a" };
/** What the window last read of each machine; m2 never answered. */
const READS: Record<string, SyncStatusRead | undefined> = {
  m4: status(HEADS),
  // Same commits, clean trees.
  m5: status(HEADS),
  // One repository at another commit, one with uncommitted files.
  m1: status({ ...HEADS, "apps/web": "b" }, ["docs"]),
  // Offline: the last status read in this session, with its time.
  "linux-mini": status({ ...HEADS, "apps/api": "c" }),
  // Its app is from before Sync.
  m3: { kind: "needs-update", at: NOW },
};
const offline = (key: string) => key === "linux-mini:p";
const reachOf = (key: string): MachineRowReach =>
  offline(key) ? { reach: "offline", lastSeen: "25m ago" } : { reach: "open" };
const VERSIONS: Record<string, string> = { m3: "1.4.2" };

function MenuPage() {
  const blocked = params.get("blocked") === "1";
  return (
    <div className="fixture-page">
      <OrchestratorSwitcher
        identity={{ color: "teal" } as never}
        label="m4"
        projectTitle={PROJECT}
        connected
        statusDetail=""
        current="m4:p"
        copies={copies}
        unknown={[]}
        savedMachineMissing={false}
        reachOf={reachOf}
        onView={(key) => record(`view:${key}`)}
        mainOffers={[]}
        onMakeMain={() => {}}
        onFix={() => {}}
        onAllowWorkers={() => {}}
        onMigrate={() => record("migrate")}
        onSync={() => record("sync")}
        syncBlocked={
          blocked
            ? syncBlockedOn({
                machine: "m4",
                reach: "open",
                read: undefined,
                version: null,
                access: "denied",
              })
            : null
        }
        onAdd={() => record("add")}
        syncOf={(key) => {
          const id = key.split(":")[0]!;
          return syncRowFact({
            shown: READS.m4,
            other: READS[id],
            shownName: "m4",
            offline: offline(key),
            version: VERSIONS[id] ?? null,
            // Read a moment ago: only the offline machine's fact carries its time.
            now: NOW - 25 * 60_000 + 1_000,
          });
        }}
        onOpenChange={(next) => record(`menu:${next ? "open" : "closed"}`)}
        onLeave={() => record("leave")}
        links={[]}
        onLink={null}
      />
    </div>
  );
}

/**
 * A window that can only read: the real hook decides what the menu shows. Each machine's
 * status was read through the hook's own store a moment ago, linux-mini's 25 minutes ago.
 */
const SEEDS: Record<string, SyncStatusRead | undefined> = { ...READS, m2: status(HEADS) };
const seedReads = () =>
  Promise.all(
    ROSTER.map((id) =>
      refreshSyncStatus(
        [machine(id)],
        {
          status: async () => {
            const read = SEEDS[id];
            return read?.kind === "status"
              ? answer(read.status)
              : { ok: false, cause: "Unknown request tag: projectSync.status" };
          },
        },
        () => Date.now() - (id === "linux-mini" ? 25 * 60_000 : 0),
      ),
    ),
  );

function ReadOnlyMenuPage() {
  const files = useProjectSyncMenu({
    project: records[0]!,
    label: "m4",
    current: "m4:p",
    copies,
    unknown: [],
    environments: ROSTER.map((id) => ({ environmentId: id as never })),
    projects: records,
    reachOf: (key) => reachOf(key).reach,
    versionOf: (environmentId) => VERSIONS[environmentId] ?? null,
    // The window may not operate the project, and the project is not personal.
    ask: null,
    readOnly: true,
  });
  return (
    <div className="fixture-page">
      <OrchestratorSwitcher
        identity={{ color: "teal" } as never}
        label="m4"
        projectTitle={PROJECT}
        connected
        statusDetail=""
        current="m4:p"
        copies={copies}
        unknown={[]}
        savedMachineMissing={false}
        reachOf={reachOf}
        onView={(key) => record(`view:${key}`)}
        mainOffers={[]}
        onMakeMain={() => {}}
        onFix={() => {}}
        onAllowWorkers={() => {}}
        onMigrate={() => record("migrate")}
        onSync={files.onSync ? () => (record("sync"), files.onSync?.()) : null}
        syncBlocked={files.syncBlocked}
        onAdd={files.onAdd}
        syncOf={files.syncOf}
        onOpenChange={(next) => record(`menu:${next ? "open" : "closed"}`)}
        onLeave={null}
        links={[]}
        onLink={null}
      />
      <span data-sync-dialog-open={files.dialog ? "yes" : "no"} />
    </div>
  );
}

const readOnlyWindow = view === "menu" && params.get("window") === "read-only";
if (readOnlyWindow) await seedReads();

const router = createRouter({
  history: createMemoryHistory(),
  routeTree: createRootRoute({
    component: () => (
      <ToastProvider>
        <AnchoredToastProvider>
          <TooltipProvider>
            {readOnlyWindow ? (
              <ReadOnlyMenuPage />
            ) : view === "menu" ? (
              <MenuPage />
            ) : (
              <DialogPage />
            )}
          </TooltipProvider>
        </AnchoredToastProvider>
      </ToastProvider>
    ),
  }),
});
createRoot(document.getElementById("root")!).render(<RouterProvider router={router} />);
