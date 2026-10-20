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
    shell("count", "Count Projects on This Machine", { createdAt: minutesAgo(60 * 26) }),
    shell("name", "Identify the User's Name", { createdAt: minutesAgo(60 * 24 * 3) }),
  ],
  params: { environmentId: "host", threadId: "lane-0951" },
});

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
    liveEvent,
    events: () => tick,
    sendMessage(id: string) {
      publish({
        shells: fixture.shells.map((t) =>
          t.id === id ? { ...t, latestUserMessageAt: new Date().toISOString() } : t,
        ),
      });
    },
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
