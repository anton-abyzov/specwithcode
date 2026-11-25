import { createRoot } from "react-dom/client";
import type { EnvironmentThreadShell } from "@specweave-studio/client-runtime/state/shell";
import { SidebarProvider } from "../../src/components/ui/sidebar";
import StudioSidebar from "../../src/components/studio/shell/StudioSidebar";
import { UnreachableHostsContext } from "../../src/studio/unreachableHosts";
import { fixture, publish } from "./mocks";
import "./fixture.css";

const params = new URLSearchParams(location.search);
document.documentElement.classList.toggle("dark", params.get("theme") !== "light");
const minutesAgo = (m: number) => new Date(Date.now() - m * 60_000).toISOString();
function shell(id: string, title: string, overrides: Partial<EnvironmentThreadShell>) {
  return {
    id,
    environmentId: "host",
    projectId: "scratch",
    title,
    runtime: null,
    latestRun: null,
    latestUserMessageAt: null,
    hasPendingApprovals: false,
    hasPendingUserInput: false,
    hasActionableProposedPlan: false,
    pendingBackgroundTasks: [],
    settledOverride: null,
    lineage: { relationshipToParent: null },
    pullRequests: [],
    archivedAt: null,
    deletedAt: null,
    createdAt: minutesAgo(60),
    updatedAt: minutesAgo(60),
    modelSelection: { instanceId: "claudeAgent", model: "claude-opus-5-5" },
    ...overrides,
  } as EnvironmentThreadShell;
}
// The screenshot's lanes: delegated workers started this morning, all streaming.
publish({
  shells: [
    shell("lane-0949", "0949+0950 Folder copy handoff and…", { createdAt: minutesAgo(9) }),
    shell("lane-0948", "0948 Link projects across machines", { createdAt: minutesAgo(10) }),
    shell("lane-0951", "0951 Per-project machine grants", { createdAt: minutesAgo(11) }),
    shell("prep", "Prepare-update session: lapse, don't re…", { createdAt: minutesAgo(120) }),
    shell("retry", "Release retry must not hide unhandled …", { createdAt: minutesAgo(180) }),
    shell("time", "Current Time", { createdAt: minutesAgo(240) }),
    shell("worker", "Delegated: audit disk", {
      createdAt: minutesAgo(250),
      createdBy: "agent",
    } as Partial<EnvironmentThreadShell>),
    shell("count", "Count Projects on This Machine", { createdAt: minutesAgo(60 * 26) }),
    shell("name", "Identify the User's Name", { createdAt: minutesAgo(60 * 24 * 3) }),
  ],
  params: { environmentId: "host", threadId: "lane-0951" },
});

// `?scenario=projects`: the projects list from the October 22 report, where two
// check projects sat among the person's own; the checks carry no origin flag, so
// their folders decide, as on a machine that has not run the backfill yet.
if (params.get("scenario") === "projects") {
  const code = (
    key: string,
    name: string,
    root: string,
    settings: Record<string, unknown> = {},
  ) => ({
    projectKey: `host:${root}`,
    displayName: name,
    workspaceRoot: root,
    memberProjects: [
      {
        environmentId: "host",
        id: key,
        title: name,
        workspaceRoot: root,
        workspaceSettings: { kind: "code", archived: false, revision: 1, ...settings },
      },
    ],
  });
  publish({
    groups: [
      code("easychamp", "EasyChamp", "/Users/me/Projects/sw-easychamp"),
      code("olysense", "olysense", "/Users/me/Projects/olysense"),
      code(
        "run-shell",
        "Run shell acceptance 357",
        "/Users/me/.specwithcode/m4/scratch/run-shell-blocks-installed/workspace",
      ),
      code("sketchmate", "sketchmate_dont_confuse", "/Users/me/Projects/sketchmate_dont_confuse"),
      code("specweave", "specweave", "/Users/me/Projects/specweave"),
      code(
        "swc-copy",
        "swc copy check 2026-10-20",
        "/Users/me/Projects/scratch/swc-copy-source-2026-10-20/specweave-copy-fixture",
      ),
      code("hack", "emergeAmericas_hackathon", "/Users/me/Projects/_events/hackathon", {
        archived: true,
      }),
    ],
  });
}

// `?scenario=elsewhere`: the list Anton saw on November 13, 2026, viewed from "host":
// two projects have a copy here, the rest live only on other machines. Those sit
// below an "On other machines" label, greyed, each with its machine's tag. Archived
// projects and the ones checks made stay out of the list (Settings > Archive has them).
if (params.get("scenario") === "elsewhere") {
  const project = (
    key: string,
    name: string,
    machines: string[],
    sharedWith: string[] = [],
    settings: Record<string, unknown> = {},
  ) => {
    const here = machines.includes("host");
    return {
      projectKey: `logical:${key}`,
      displayName: name,
      workspaceRoot: `/Users/me/Projects/${key}`,
      environmentPresence: here ? (machines.length > 1 ? "mixed" : "local-only") : "remote-only",
      allRemoteMembersAreDesktopLocal: false,
      memberProjects: machines.map((environmentId) => ({
        environmentId,
        environmentLabel: environmentId,
        id: `${key}-${environmentId}`,
        title: name,
        workspaceRoot: `/Users/me/Projects/${key}`,
        workspaceSettings: {
          kind: "code",
          archived: false,
          revision: 1,
          ...settings,
          ...(sharedWith.length > 0
            ? {
                logicalProject: {
                  id: `logical-${key}`,
                  members: [environmentId, ...sharedWith].map((member) => ({
                    environmentId: member,
                  })),
                },
              }
            : {}),
        },
      })),
    };
  };
  publish({
    environments: [
      { environmentId: "host", label: "M5" },
      { environmentId: "m4", label: "m4" },
      { environmentId: "m1", label: "m1" },
      { environmentId: "linux-mini", label: "linux-mini" },
    ],
    groups: [
      project("ai-com", "ai-company", ["linux-mini"]),
      project("easychamp", "EasyChamp", ["m4", "m1", "linux-mini"]),
      project("firstproject", "firstproject", ["host"]),
      project("fortnite", "fortnite-3js", ["m4", "m1"]),
      project("hack-openai", "hack26-openai", ["m4"]),
      project("specweave", "specweave", ["host", "m4"], ["linux-mini"]),
      project("sketchmate", "sketchmate_pro", ["m1"]),
      project("old-site", "old-site", ["host"], [], { archived: true }),
      project("legacy", "legacy-api", ["m4"], [], { archived: true }),
      project("run-shell", "Run shell acceptance 357", ["host"], [], { origin: "automated" }),
      project("move-check", "1164 handoff move check", ["host"], [], { origin: "automated" }),
    ],
  });
}

// `?scenario=automated-attention`: coordinators asking in the person's projects and in
// checks' projects. Only a project nobody works in stays quiet; one merely named like a
// check keeps its count, and a name that starts with a number gets real initials.
if (params.get("scenario") === "automated-attention") {
  const projects = [
    ["easychamp", "EasyChamp", "/Users/me/Projects/sw-easychamp", {}],
    ["specweave", "specweave", "/Users/me/Projects/specweave", {}],
    [
      "move-check",
      "1164 handoff move check",
      "/Users/me/Projects/scratch/swc-1164-handoff3",
      { origin: "automated" },
    ],
    ["hello", "hello-handoff", "/Users/me/.specwithcode/m4/scratch/e2e/hello-handoff", {}],
    ["client", "client-demo", "/Users/me/Projects/client-demo", {}],
  ] as const;
  const asking = ["easychamp", "move-check", "hello", "client"];
  publish({
    // The check's project is open: the sidebar lists it alone under the projects.
    params: { projectKey: "host:/Users/me/Projects/scratch/swc-1164-handoff3" },
    groups: projects.map(([id, name, root, settings]) => ({
      projectKey: `host:${root}`,
      displayName: name,
      workspaceRoot: root,
      memberProjects: [
        {
          environmentId: "host",
          id,
          title: name,
          workspaceRoot: root,
          workspaceSettings: { kind: "code", archived: false, revision: 1, ...settings },
        },
      ],
    })),
    shells: asking.map((id) =>
      shell(`project-coordinator:${id}`, "Coordinator", {
        projectId: id,
        hasPendingUserInput: true,
      } as Partial<EnvironmentThreadShell>),
    ),
    attentionMembers: projects.map(([id]) => ({
      environmentId: "host",
      projectId: id,
      coordinatorThreadId: `project-coordinator:${id}`,
      includeUserRoots: false,
      freshness: "live",
      remoteWorkers: [],
      remoteWorkersComplete: true,
    })),
  });
}

// `?scenario=chats`: chats in the machine's "No project" folder, one of them marked
// resolved by an older server's idle sweep, beside a project of the person's own.
if (params.get("scenario") === "chats") {
  const scratchRoot = "/Users/me/.specwithcode/scratch";
  publish({
    configs: new Map([
      [
        "host",
        {
          scratchWorkspaceRoot: scratchRoot,
          providers: [],
          environment: { capabilities: { threadProjectMove: true } },
        },
      ],
    ]),
    groups: [
      {
        projectKey: "host:/Users/me/Projects/specweave",
        displayName: "specweave",
        workspaceRoot: "/Users/me/Projects/specweave",
        memberProjects: [
          {
            environmentId: "host",
            id: "specweave",
            title: "specweave",
            workspaceRoot: "/Users/me/Projects/specweave",
            workspaceSettings: { kind: "code", archived: false, revision: 1 },
          },
        ],
      },
      {
        projectKey: `host:${scratchRoot}`,
        displayName: "No project",
        workspaceRoot: scratchRoot,
        memberProjects: [
          { environmentId: "host", id: "scratch", title: "No project", workspaceRoot: scratchRoot },
        ],
      },
    ],
    shells: fixture.shells.map((t) =>
      t.id === "time" ? { ...t, settledOverride: "settled" as const } : t,
    ),
  });
}

// `?scenario=chat-machines`: the November 1 report. One chat lives on this machine, the
// rest on others, one of them moved and one on a machine that stopped answering.
if (params.get("scenario") === "chat-machines") {
  const on = (environmentId: string, overrides: Partial<EnvironmentThreadShell> = {}) => ({
    environmentId,
    projectId: `${environmentId}-scratch`,
    ...overrides,
  });
  publish({
    environments: [
      { environmentId: "host", label: "m4" },
      { environmentId: "m1", label: "m1" },
      { environmentId: "m3", label: "m3" },
      { environmentId: "ministorm", label: params.has("short") ? "m2" : "ministorm" },
    ],
    unreachable: ["m3"],
    params: { environmentId: "host", threadId: "extension" },
    shells: [
      shell("extension", "Chrome extension version check", {
        ...on("host"),
        latestUserMessageAt: minutesAgo(1),
      }),
      shell("version", "M1 SpecWithCode version check", on("m1", { updatedAt: minutesAgo(4) })),
      shell("disk", "Disk audit", {
        ...on("ministorm", { updatedAt: minutesAgo(8) }),
        runtime: { status: "running" } as EnvironmentThreadShell["runtime"],
      }),
      shell("update", "Update desktop app on every machine in the fleet", on("m1")),
      shell("iphone", "Boot iPhone Duo simulator", on("m3", { updatedAt: minutesAgo(16) })),
      shell("stranded", "Moved to the silent machine", {
        ...on("host", { updatedAt: minutesAgo(24) }),
        source: { ownerMachineId: "host", executionMachineId: "m3", executionState: "running" },
      } as Partial<EnvironmentThreadShell>),
      shell("moved", "Moved to the Linux box", {
        ...on("host", { updatedAt: minutesAgo(20) }),
        source: {
          ownerMachineId: "host",
          executionMachineId: "ministorm",
          executionState: "running",
        },
      } as Partial<EnvironmentThreadShell>),
    ],
  });
}

// `?scenario=reviewers`: the November 14, 2026 report. Adversarial reviewer chats on m5
// whose checklists are done or nearly done while the last run failed on an expired
// sign-in, beside quiet chats on m1 and m4 and older increment chats.
if (params.get("scenario") === "reviewers") {
  const on = (environmentId: string, overrides: Partial<EnvironmentThreadShell> = {}) => ({
    environmentId,
    projectId: `${environmentId}-scratch`,
    ...overrides,
  });
  const failed = {
    status: "failed",
    lastError:
      "Provider error after 5/5 retries: unexpected status 401 Unauthorized: Provided authentication token is expired. auth error code: token_expired",
    lastErrorClass: "provider_error",
  } as unknown as EnvironmentThreadShell["runtime"];
  const gpt = { instanceId: "codex", model: "gpt-6.1-sol" };
  const reviewer = (id: string, title: string, minutes: number, fail = true) =>
    shell(id, title, {
      ...on("m5", { createdAt: minutesAgo(minutes), updatedAt: minutesAgo(minutes) }),
      modelSelection: gpt,
      ...(fail ? { runtime: failed } : {}),
    } as Partial<EnvironmentThreadShell>);
  const checklist = (completed: number, total: number) => ({
    source: "todo",
    label: null,
    completed,
    total,
    current: completed < total ? "Re-run the folder copy probes" : null,
    next: null,
  });
  const increment = (label: string, completed: number, total: number) => ({
    ...checklist(completed, total),
    source: "increment",
    label,
  });
  publish({
    environments: [
      { environmentId: "host", label: "m4" },
      { environmentId: "m1", label: "m1" },
      { environmentId: "m5", label: "m5" },
      { environmentId: "linux-mini", label: "linux-mini" },
    ],
    params: { environmentId: "m5", threadId: "review-354" },
    // m5 has no specweave copy: its reviewers land in its "No project" folder.
    configs: new Map([
      ["m5", { scratchWorkspaceRoot: "/Users/me/.specwithcode/m5/scratch", providers: [] }],
    ]),
    groups: [
      {
        projectKey: "host:/Users/me/Projects/specweave",
        displayName: "specweave",
        workspaceRoot: "/Users/me/Projects/specweave",
        memberProjects: [
          {
            environmentId: "host",
            id: "p-specweave",
            title: "specweave",
            workspaceRoot: "/Users/me/Projects/specweave",
            workspaceSettings: { kind: "code", archived: false, revision: 1 },
          },
        ],
      },
      {
        projectKey: "m5:/Users/me/.specwithcode/m5/scratch",
        displayName: "No project",
        workspaceRoot: "/Users/me/.specwithcode/m5/scratch",
        memberProjects: [
          {
            environmentId: "m5",
            id: "m5-scratch",
            title: "No project",
            workspaceRoot: "/Users/me/.specwithcode/m5/scratch",
          },
        ],
      },
    ],
    shells: [
      shell("hourly", "EasyChamp hourly New York sessions", on("m1", { createdAt: minutesAgo(5) })),
      shell("briefing", "Proactive briefing", on("host", { createdAt: minutesAgo(10) })),
      reviewer("review-354", "Review: folder copy carries a safe Git config (1328, PR 354)", 20),
      reviewer("review-351", "Review: machine color top line (PR 351)", 25),
      reviewer("review-349", "Review: release train insiders channel (PR 349)", 30),
      reviewer("review-347", "Review: first-run folder choice (PR 347)", 35),
      reviewer("review-345", "Review: handoff scrub for secrets (PR 345)", 40),
      reviewer("review-343", "Review: update pause setting (PR 343)", 45, false),
      // Asked for by a specweave worker on m4: the project's work, not a chat.
      shell("worker", "1328 folder copy safe Git config", {
        environmentId: "host",
        projectId: "p-specweave",
        createdAt: minutesAgo(70),
      }),
      {
        ...reviewer("review-341", "Review: asked for by the specweave worker (PR 341)", 22),
        origin: {
          kind: "fleet_machine",
          label: "SpecWithCode",
          machineLabel: "m4",
          parentThreadRef: { environmentId: "host", threadId: "worker" },
        },
      } as EnvironmentThreadShell,
      // November 25, 2026: a coordinator's delegate_task worker asked m5 for a check; the
      // requester is a subagent shell and the helper's origin names no project.
      shell("thread:delegated-task:push", "Fix push failures", {
        environmentId: "host",
        projectId: "p-specweave",
        createdAt: minutesAgo(80),
        lineage: {
          parentThreadId: "project-coordinator:p-specweave",
          relationshipToParent: "subagent",
          rootThreadId: "project-coordinator:p-specweave",
        },
      } as Partial<EnvironmentThreadShell>),
      {
        ...shell(
          "push-check",
          "Git push credentials check on m5",
          on("m5", { createdAt: minutesAgo(21) }),
        ),
        origin: {
          kind: "fleet_machine",
          label: "SpecWithCode",
          machineLabel: "m4",
          environmentId: "host",
          parentThreadRef: { environmentId: "host", threadId: "thread:delegated-task:push" },
        },
      } as EnvironmentThreadShell,
      // Its requester is not loaded here, so it stays in Chats, under the project it names.
      {
        ...shell(
          "orphan-check",
          "Disk check for specweave",
          on("m5", { createdAt: minutesAgo(23) }),
        ),
        origin: {
          kind: "fleet_machine",
          label: "SpecWithCode",
          machineLabel: "m4",
          environmentId: "host",
          parentProjectLabel: "specweave",
          parentThreadRef: { environmentId: "host", threadId: "gone" },
        },
      } as EnvironmentThreadShell,
      shell("verify", "Verify M4 to M5 specweave handoff", on("m5", { createdAt: minutesAgo(50) })),
      shell(
        "appstore",
        "App Store screenshots for 1039",
        on("m1", { createdAt: minutesAgo(60 * 26) }),
      ),
      shell(
        "sweep",
        "Sweep idle threads, finish the queue",
        on("m1", { createdAt: minutesAgo(60 * 27) }),
      ),
      shell(
        "build",
        "Build the Linux desktop package",
        on("linux-mini", { createdAt: minutesAgo(60 * 24 * 3) }),
      ),
    ],
    plans: new Map<string, unknown>([
      ["m5:review-354", checklist(4, 4)],
      ["m5:review-351", checklist(3, 4)],
      ["m5:review-349", checklist(4, 5)],
      ["m5:review-347", checklist(2, 4)],
      ["m5:review-345", checklist(3, 4)],
      ["m5:review-343", checklist(4, 4)],
      ["m1:appstore", increment("1039-app-store-screenshots", 5, 6)],
      ["linux-mini:build", increment("0001-linux-desktop", 26, 26)],
    ]),
  });
}

// `?scenario=row-room`: the November 15, 2026 report. One date group mixes machines
// with short and long names, and two of its chats carry an open plan count.
if (params.get("scenario") === "row-room") {
  const on = (environmentId: string, minutes: number) => ({
    environmentId,
    projectId: `${environmentId}-scratch`,
    createdAt: minutesAgo(minutes),
    updatedAt: minutesAgo(minutes),
  });
  const day = 60 * 24;
  const tasks = (label: string, completed: number, total: number) => ({
    source: "increment",
    label,
    completed,
    total,
    current: "Capture the remaining screens",
    next: null,
  });
  publish({
    environments: [
      { environmentId: "host", label: "m4" },
      { environmentId: "m1", label: "m1" },
      { environmentId: "linux-mini", label: "linux-mini" },
    ],
    params: { environmentId: "host", threadId: "briefing" },
    shells: [
      shell("hourly", "Hourly alert sweep for the staging cluster", on("m1", 30)),
      shell("briefing", "Proactive briefing", on("host", day + 60)),
      shell("appstore", "App Store review notes and screenshots", on("m1", day * 2)),
      shell("sweep", "Sweep idle threads, finish the queue", on("m1", day * 2 + 10)),
      shell("camera", "Two-camera capture for match highlights", on("m1", day * 2 + 20)),
      shell("club", "1024 club app onboarding flow", on("m1", day * 2 + 30)),
      shell("pin", "Pin the model version for one provider", on("host", day * 3)),
      shell("linux", "Build the Linux desktop package", on("linux-mini", day * 3 + 10)),
    ],
    plans: new Map<string, unknown>([
      ["m1:appstore", tasks("1039-app-store-review", 5, 6)],
      ["m1:club", tasks("1024-club-app", 7, 8)],
    ]),
  });
}

const LANES = ["lane-0949", "lane-0948", "lane-0951", "prep"];
let tick = 0;
/** One server event: a streamed item, a tool call or a status change on one lane. */
function liveEvent(): void {
  tick += 1;
  const id = LANES[(tick * 7) % LANES.length]!;
  const kind = tick % 4;
  publish({
    shells: fixture.shells.map((t) =>
      t.id !== id
        ? t
        : {
            ...t,
            updatedAt: new Date().toISOString(),
            runtime:
              kind === 3 ? null : ({ status: "running" } as EnvironmentThreadShell["runtime"]),
            hasPendingApprovals: kind === 2,
            pendingBackgroundTasks: kind === 1 ? ([{}] as never) : [],
          },
    ),
  });
}
const order = () =>
  [...document.querySelectorAll(".sws-chat-row .sws-side-row-label")].map((e) => e.textContent);
const current = () =>
  document.querySelector('.sws-chat-row [aria-current="page"] .sws-side-row-label')?.textContent ??
  null;
Object.assign(window, {
  fixture: {
    order,
    current,
    navigations: () => [...fixture.navigations],
    renames: () => [...fixture.renames],
    refuseNextRename: (reason: string) => {
      fixture.refuseNextRename = reason;
    },
    title: (id: string) => fixture.shells.find((t) => t.id === id)?.title ?? null,
    liveEvent,
    events: () => tick,
    sendMessage(id: string) {
      publish({
        shells: fixture.shells.map((t) =>
          t.id === id ? { ...t, latestUserMessageAt: new Date().toISOString() } : t,
        ),
      });
    },
    projectUpdates: () => [...fixture.projectUpdates],
    moves: () => [...fixture.moves],
    newChat() {
      const now = new Date().toISOString();
      publish({
        shells: [
          ...fixture.shells,
          shell("new", "New chat from the person", { createdAt: now, updatedAt: now }),
        ],
      });
    },
  },
});
if (params.get("live") !== "off") setInterval(liveEvent, 40);

createRoot(document.getElementById("root")!).render(
  <SidebarProvider>
    <aside
      className="h-screen w-[400px] max-w-full overflow-auto border-r border-border bg-sidebar text-sidebar-foreground"
      style={params.has("width") ? { width: `${params.get("width")}px` } : undefined}
    >
      <UnreachableHostsContext.Provider value={new Set(fixture.unreachable)}>
        <StudioSidebar />
      </UnreachableHostsContext.Provider>
    </aside>
  </SidebarProvider>,
);
