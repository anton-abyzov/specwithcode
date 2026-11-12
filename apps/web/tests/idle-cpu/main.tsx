/* The idle window: sidebar and a settled thread on screen while other threads work. */
import { createRoot } from "react-dom/client";
import * as DateTime from "effect/DateTime";
import * as Option from "effect/Option";
import { AsyncResult } from "effect/reactivity";
import {
  applyShellStreamEvent,
  type EnvironmentShellState,
} from "@specweave-studio/client-runtime/state/shell";
import {
  ProjectId,
  ProviderInstanceId,
  RunId,
  ThreadId,
  type OrchestrationProjectShell,
  type OrchestrationV2ShellSnapshot,
  type OrchestrationV2ThreadShell,
} from "@specweave-studio/contracts";
import { SidebarProvider } from "../../src/components/ui/sidebar";
import StudioSidebar from "../../src/components/studio/shell/StudioSidebar";
import { ThreadRouteView } from "../../src/components/ThreadRouteView";
import { AppAtomRegistryProvider, appAtomRegistry } from "../../src/rpc/atomRegistry";
import { ProjectPage } from "./project-page";
import {
  HOST,
  SCRATCH_ROOT,
  archive,
  environmentShell,
  fixture,
  projectRemoteAttentionAtom,
  publish,
  remoteAttentionKey,
} from "./mocks";
import "./fixture.css";

// ?threads=1100 &projects=13 &running=40 &batches=9 (per second) &events=1 (per batch)
// &polls=4 (remote worker answers per second) &archived=1200 &live=off &theme=light
const params = new URLSearchParams(location.search);
const number = (name: string, fallback: number) => Number(params.get(name) ?? fallback);
const THREADS = number("threads", 1100);
const PROJECTS = number("projects", 13);
const RUNNING = number("running", 40);
const BATCHES_PER_SECOND = number("batches", 9);
const EVENTS_PER_BATCH = number("events", 1);
const POLLS_PER_SECOND = number("polls", 4);
const ARCHIVED = number("archived", 1200);
document.documentElement.classList.toggle("dark", params.get("theme") !== "light");

const provider = ProviderInstanceId.make("claudeAgent");
const at = (msAgo: number) => DateTime.makeUnsafe(Date.now() - msAgo);
function thread(
  id: string,
  projectId: string,
  title: string,
  ageMinutes: number,
  overrides: Partial<OrchestrationV2ThreadShell> = {},
): OrchestrationV2ThreadShell {
  const threadId = ThreadId.make(id);
  return {
    id: threadId,
    projectId: ProjectId.make(projectId),
    title,
    providerInstanceId: provider,
    modelSelection: { instanceId: provider, model: "claude-opus-5-5" },
    runtimeMode: "full-access",
    interactionMode: "default",
    branch: null,
    worktreePath: null,
    activeProviderThreadId: null,
    lineage: { rootThreadId: threadId, parentThreadId: null, relationshipToParent: null },
    forkedFrom: null,
    createdBy: "user",
    creationSource: "web",
    latestRunId: null,
    activeRunId: null,
    status: "idle",
    pendingRuntimeRequest: null,
    latestVisibleMessage: null,
    latestUserMessageAt: null,
    hasActionableProposedPlan: false,
    itemCount: 40,
    visibleItemCount: 40,
    createdAt: at(ageMinutes * 60_000),
    updatedAt: at(ageMinutes * 60_000),
    archivedAt: null,
    settledOverride: null,
    settledAt: null,
    lastVisitedAt: null,
    deletedAt: null,
    ...overrides,
  };
}

// The shape of a busy machine's thread list (counted on one in November 2026): one
// project holds three quarters of the threads, nine in ten threads are subagents, a
// quarter of those report to a project coordinator (one coordinator has over 200)
// and the rest to its workers, and about fifty are the person's own chats.
const PROJECT_SHARES = [834, 143, 54, 41, 9, 8, 6, 4, 4, 4, 2, 1, 1].slice(0, PROJECTS);
const shareTotal = PROJECT_SHARES.reduce((sum, share) => sum + share, 0);
const projectIds = PROJECT_SHARES.map((_, index) => `project-${index}`);
const projects: OrchestrationProjectShell[] = [
  ...projectIds.map((id, index) => ({ id, title: `Project ${index}`, root: `/work/${id}` })),
  { id: "scratch", title: "No project", root: SCRATCH_ROOT },
].map(({ id, title, root }) => ({
  id: ProjectId.make(id),
  title,
  workspaceRoot: root,
  repositoryIdentity: null,
  defaultModelSelection: null,
  scripts: [],
  createdAt: "2026-06-20T00:00:00.000Z",
  updatedAt: "2026-06-20T00:00:00.000Z",
}));
const threads: OrchestrationV2ThreadShell[] = [];
const CHATS = Math.round(THREADS * 0.045);
for (const [index, projectId] of projectIds.entries()) {
  const size = Math.max(1, Math.round(((THREADS - CHATS) * PROJECT_SHARES[index]!) / shareTotal));
  const coordinator = ThreadId.make(`project-coordinator:${projectId}`);
  threads.push(
    thread(coordinator, projectId, "Coordinator", 30 + index, {
      createdBy: "system",
      creationSource: "server",
    } as never),
  );
  const workers: string[] = [];
  for (let member = 1; member < size; member += 1) {
    const id = `${projectId}-thread-${member}`;
    // Every fourth thread is a worker the coordinator started; the others are
    // subagents of the nearest worker before them.
    const worker = member % 4 === 1;
    const parent = worker ? coordinator : ThreadId.make(workers.at(-1)!);
    if (worker) workers.push(id);
    threads.push(
      thread(
        id,
        projectId,
        `${1000 + member} ${worker ? "Worker" : "Subagent"} task ${member} of project ${index}`,
        60 + member * 7 + index,
        {
          createdBy: "agent",
          creationSource: worker || member % 3 === 0 ? "mcp" : "provider",
          lineage: {
            rootThreadId: coordinator,
            parentThreadId: parent,
            relationshipToParent: "subagent",
          },
          ...(member % 5 < 2 ? { settledOverride: "settled", settledAt: at(member * 60_000) } : {}),
        } as never,
      ),
    );
  }
}
for (let index = 0; index < CHATS; index += 1) {
  threads.push(thread(`chat-${index}`, "scratch", `Chat about topic ${index}`, 15 + index * 11));
}
const OPEN_THREAD = "chat-open";
threads.push(thread(OPEN_THREAD, "scratch", "The settled chat on screen", 5));

// The archive is its own bounded read; the project page merges it with the live list.
archive.snapshots = [
  {
    environmentId: HOST,
    snapshot: {
      threads: Array.from({ length: ARCHIVED }, (_, index) =>
        thread(
          `archived-${index}`,
          projectIds[index % projectIds.length]!,
          `Archived task ${index}`,
          2000 + index,
          { archivedAt: at(index * 60_000) },
        ),
      ),
    },
  },
];

// Every Nth thread is working when the page opens.
const runningIds: string[] = [];
for (let index = 0; index < RUNNING; index += 1) {
  const position = Math.floor((index * (threads.length - 1)) / RUNNING);
  const target = threads[position]!;
  const run = RunId.make(`run-${target.id}-0`);
  threads[position] = {
    ...target,
    status: "running",
    latestRunId: run,
    activeRunId: run,
    updatedAt: at(0),
  };
  runningIds.push(target.id);
}

let state: EnvironmentShellState = {
  snapshot: Option.some<OrchestrationV2ShellSnapshot>({
    schemaVersion: 1,
    snapshotSequence: 1,
    projects,
    threads,
    archivedThreads: [],
  }),
  status: "live",
  error: Option.none(),
};
const stateAtom = environmentShell.stateAtom(HOST);
appAtomRegistry.set(stateAtom, AsyncResult.success(state));
publish({
  params: { environmentId: HOST, threadId: OPEN_THREAD },
  groups: projects.map((project) => ({
    projectKey: `${HOST}:${project.workspaceRoot}`,
    displayName: project.title,
    workspaceRoot: project.workspaceRoot,
    memberProjects: [
      {
        environmentId: HOST,
        id: project.id,
        title: project.title,
        workspaceRoot: project.workspaceRoot,
        ...(project.id === "scratch"
          ? {}
          : { workspaceSettings: { kind: "code", archived: false, revision: 1 } }),
      },
    ],
  })),
});

// The rate: a server resends each working thread's shell every 5 s, so 40 of them
// make 8 deltas a second before any real change, and it flushes many times a second.
// A window that keeps up receives them one at a time; `batches=2.2&events=4` is what a
// saturated window was seen applying.
const counters = { batches: 0, events: 0, polls: 0 };
let turn = 0;
/**
 * One batch from the shell subscription, applied the way the app applies it: each
 * delta through the shell reducer, then one state write. Most deltas are the server's
 * periodic resend of a working thread (only `updatedAt` moved); some change the
 * current tool call, a few finish a run and start another, one in sixty asks a question.
 */
function shellBatch(): void {
  let snapshot = Option.getOrThrow(state.snapshot);
  for (let index = 0; index < EVENTS_PER_BATCH; index += 1) {
    turn += 1;
    const slot = (turn * 7) % runningIds.length;
    const current = snapshot.threads.find((candidate) => candidate.id === runningIds[slot])!;
    let next: OrchestrationV2ThreadShell = {
      ...current,
      updatedAt: at(0),
      activeRunActivityAt: at(0),
    };
    if (turn % 8 === 0) {
      next = { ...next, activeWork: { label: `Running step ${turn}`, startedAt: at(0) } } as never;
    }
    if (turn % 60 === 0) {
      next = {
        ...next,
        pendingRuntimeRequest:
          current.pendingRuntimeRequest === null
            ? ({ id: `request-${turn}`, kind: "user_input", createdAt: at(0) } as never)
            : null,
      };
    }
    if (turn % 30 === 0) {
      // This run finishes; an idle thread of the same project starts one.
      next = { ...next, status: "idle", activeRunId: null, latestRunCompletedAt: at(0) };
      const idle = snapshot.threads.find(
        (candidate) =>
          candidate.status === "idle" &&
          candidate.projectId === current.projectId &&
          candidate.id !== OPEN_THREAD &&
          candidate.id !== current.id,
      );
      if (idle) {
        const run = RunId.make(`run-${idle.id}-${turn}`);
        runningIds[slot] = idle.id;
        snapshot = applyShellStreamEvent(snapshot, {
          kind: "thread.updated",
          sequence: snapshot.snapshotSequence + 1,
          location: "active",
          thread: {
            ...idle,
            status: "running",
            latestRunId: run,
            activeRunId: run,
            updatedAt: at(0),
          },
        } as never);
      }
    }
    snapshot = applyShellStreamEvent(snapshot, {
      kind: "thread.updated",
      sequence: snapshot.snapshotSequence + 1,
      location: "active",
      thread: next,
    } as never);
    counters.events += 1;
  }
  counters.batches += 1;
  state = { ...state, snapshot: Option.some(snapshot) };
  appAtomRegistry.set(stateAtom, AsyncResult.success(state));
}

/** One project's remote worker poll answers: the app re-reads each project every 10 s. */
function remoteWorkerPoll(): void {
  counters.polls += 1;
  const projectId = projectIds[counters.polls % projectIds.length]!;
  appAtomRegistry.set(projectRemoteAttentionAtom(remoteAttentionKey(projectId)), {
    workers: [],
    complete: true,
  });
}

const timers: number[] = [];
function start(): void {
  if (timers.length > 0) return;
  if (BATCHES_PER_SECOND > 0)
    timers.push(window.setInterval(shellBatch, 1000 / BATCHES_PER_SECOND));
  if (POLLS_PER_SECOND > 0)
    timers.push(window.setInterval(remoteWorkerPoll, 1000 / POLLS_PER_SECOND));
}
function stop(): void {
  for (const timer of timers.splice(0)) window.clearInterval(timer);
}
const labels = (selector: string) =>
  [...document.querySelectorAll(selector)].map((element) => element.textContent ?? "");
Object.assign(window, {
  fixture: {
    start,
    stop,
    shellBatch,
    remoteWorkerPoll,
    counters: () => ({ ...counters, chatViewRenders: fixture.chatViewRenders }),
    scale: () => ({
      threads: threads.length,
      projects: projectIds.length,
      subagents: threads.filter((item) => item.lineage.relationshipToParent === "subagent").length,
      running: RUNNING,
      batchesPerSecond: BATCHES_PER_SECOND,
      eventsPerBatch: EVENTS_PER_BATCH,
      pollsPerSecond: POLLS_PER_SECOND,
    }),
    chatOrder: () => labels(".sws-chat-row .sws-side-row-label"),
    currentChat: () =>
      document.querySelector('.sws-chat-row [aria-current="page"] .sws-side-row-label')
        ?.textContent ?? null,
    /** What the person reads off the screen, without ages: the same events give the same answer. */
    signature: () => ({
      chats: labels(".sws-chat-row .sws-side-row-label"),
      projectsWaiting: labels(".sws-count-waiting"),
      paneSummary: document.querySelector(".sws-threads-head")?.textContent ?? null,
      paneGroups: labels(".sws-thread-group > :first-child"),
      paneRows: labels(".sws-thread-row .sws-thread-open").map((row) =>
        row.replace(/updated.*$/, ""),
      ),
    }),
    projectRows: () => document.querySelectorAll("[data-project-key], .sws-project-row").length,
    workingThreads: () =>
      Option.getOrThrow(state.snapshot).threads.filter(
        (candidate) => candidate.status === "running",
      ).length,
  },
});
if (params.get("live") !== "off") start();

createRoot(document.getElementById("root")!).render(
  <AppAtomRegistryProvider>
    <SidebarProvider>
      <aside className="h-screen w-[400px] max-w-full shrink-0 overflow-auto border-r border-border bg-sidebar text-sidebar-foreground">
        <StudioSidebar />
      </aside>
      <ThreadRouteView
        target={{
          kind: "server",
          threadRef: { environmentId: HOST, threadId: ThreadId.make(OPEN_THREAD) },
        }}
      />
      <ProjectPage project={{ ...projects[0]!, environmentId: HOST }} />
    </SidebarProvider>
  </AppAtomRegistryProvider>,
);
