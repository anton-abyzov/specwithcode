import { createRoot } from "react-dom/client";
import type { EnvironmentThreadShell } from "@specweave-studio/client-runtime/state/shell";
import { SidebarProvider } from "../../src/components/ui/sidebar";
import StudioSidebar from "../../src/components/studio/shell/StudioSidebar";
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
    <aside className="h-screen w-[400px] max-w-full overflow-auto border-r border-border bg-sidebar text-sidebar-foreground">
      <StudioSidebar />
    </aside>
  </SidebarProvider>,
);
