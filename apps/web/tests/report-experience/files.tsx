// The Files list, file states, property cards and the file reader with synthetic inputs
// (`/files.html`): the real list, viewer, cards, right panel and focused viewer. `&offline=1`
// takes the machine offline. No server, account or network.
import { createRoot } from "react-dom/client";
import {
  createMemoryHistory,
  createRootRoute,
  createRouter,
  RouterProvider,
} from "@tanstack/react-router";
import { useLayoutEffect, useMemo, useState } from "react";
import {
  FileCodeIcon,
  FileIcon,
  FileTextIcon,
  GlobeIcon,
  HashIcon,
  LinkIcon,
  ShapesIcon,
} from "lucide-react";
import { shelfEntries, type ShelfFileCheck } from "../../src/artifactShelf";
import { fileLinkMetaAtPath } from "../../src/markdown-links";
import { nativeArtifactFromItem } from "../../src/nativeArtifacts";
import {
  fileArtifact,
  nativeArtifact,
  type ThreadArtifact,
  type ThreadArtifactKind,
  type ThreadFileArtifact,
} from "../../src/threadArtifacts";
import { ArtifactShelfList } from "../../src/components/chat/ArtifactShelfList";
import { ArtifactViewer } from "../../src/components/chat/ThreadArtifacts";
import { structuredFenceView } from "../../src/components/chat/StructuredBlocks";
import { RightPanelTabs } from "../../src/components/RightPanelTabs";
import { ViewerOverlayHost } from "../../src/components/ViewerOverlayHost";
import { useRightPanelStore } from "../../src/rightPanelStore";
import {
  openFileInFront,
  useFileReaderLayoutReport,
  useFocusedFileStore,
} from "../../src/lib/openInFront";
import { useViewerOverlayStore } from "../../src/viewerOverlayStore";
import { Button } from "../../src/components/ui/button";
import { Popover, PopoverPopup, PopoverTrigger } from "../../src/components/ui/popover";
import { AnchoredToastProvider, ToastProvider } from "../../src/components/ui/toast";
import "./fixture.css";

const search = new URLSearchParams(location.search);
document.documentElement.classList.toggle("dark", search.get("theme") === "dark");
const offline = search.has("offline");

const threadRef = { environmentId: "fixture", threadId: "fixture-thread" } as never;
const ROOT = "/Users/fixture/work/atlas";
const PANEL_WIDTH = 600;
// Fixed, so rows date the same in every capture.
const NOW = Date.parse("2026-10-24T16:00:00.000Z");
const minutesAgo = (minutes: number) => NOW - minutes * 60_000;

const KIND_ICON: Record<ThreadArtifactKind, typeof FileIcon> = {
  image: FileIcon,
  video: FileIcon,
  audio: FileIcon,
  html: HashIcon,
  markdown: FileTextIcon,
  pdf: FileTextIcon,
  code: FileCodeIcon,
  file: FileIcon,
  link: LinkIcon,
  native: GlobeIcon,
};

function file(path: string, messageId: string): ThreadFileArtifact {
  return fileArtifact(fileLinkMetaAtPath({}, path), messageId);
}

function published(id: string, path: string, url: string, seq: number, at: number) {
  const native = nativeArtifactFromItem({
    id,
    type: "dynamic_tool",
    status: "completed",
    toolName: "Artifact",
    nativeItemRef: { driver: "claudeAgent" },
    input: { path },
    output: {
      url,
      path,
      title: "Season standings preview",
      seq,
      version: `v-${seq}`,
      audience: "owner",
    },
    completedAt: new Date(at).toISOString(),
  });
  if (native === null) throw new Error("The synthetic publish result did not parse");
  return nativeArtifact(native);
}

const PATHS = {
  plan: `${ROOT}/docs/season-plan.md`,
  report: `${ROOT}/reports/registration-summary.html`,
  missing: `${ROOT}/reports/archive/report-final.md`,
  unreachable: "/Users/fixture/work/shared/exports/standings-2026.csv",
  checking: `${ROOT}/notes/todo.md`,
  long: `${ROOT}/.specweave/increments/0042-season-registration-and-payments/reports/registration-and-payments-review-with-a-long-name.md`,
  inherited: `${ROOT}/docs/handoff-notes.md`,
  native: `${ROOT}/artifacts/standings-preview.html`,
  nativeGone: `${ROOT}/artifacts/old-preview.html`,
};

const ARTIFACTS: ThreadArtifact[] = [
  published(
    "item-native",
    PATHS.native,
    "https://claude.ai/artifact/ExampleArtifact0001",
    2,
    minutesAgo(4),
  ),
  file(PATHS.plan, "message-plan"),
  file(PATHS.long, "message-review"),
  file(PATHS.report, "message-report"),
  file(PATHS.checking, "message-notes"),
  file(PATHS.unreachable, "message-export"),
  {
    key: "https://example.com/docs/registration",
    kind: "link",
    url: "https://example.com/docs/registration",
    host: "example.com",
    name: "Registration guide",
    messageId: "message-plan",
  },
  published(
    "item-native-old",
    PATHS.nativeGone,
    "https://claude.ai/code/artifact/00000000-0000-4000-8000-000000000001",
    1,
    minutesAgo(90),
  ),
  file(PATHS.missing, "message-archive"),
  file(PATHS.inherited, "message-inherited"),
];

const DATES: Record<string, number> = {
  "message-plan": minutesAgo(12),
  "message-review": minutesAgo(20),
  "message-report": minutesAgo(31),
  "message-notes": minutesAgo(44),
  "message-export": minutesAgo(60),
  "message-archive": minutesAgo(180),
  "message-inherited": minutesAgo(60 * 26),
};
const SOURCES: Record<string, string> = {
  "message-plan": "Season plan is ready",
  "message-review": "Review of the payments flow",
  "message-report": "Registration summary",
  "message-notes": "Notes for tomorrow",
  "message-export": "Standings export",
  "message-archive": "Earlier draft",
  "message-inherited": "Handoff",
};

function fileChecks(): Map<string, ShelfFileCheck> {
  const reason = offline ? "Studio Mini is offline" : undefined;
  if (offline) {
    return new Map(
      ARTIFACTS.flatMap((artifact) => {
        const path =
          artifact.kind === "native"
            ? artifact.native.localPath
            : "meta" in artifact
              ? artifact.meta.filePath
              : null;
        return path === null ? [] : [[path, { state: "unreachable", reason } as const]];
      }),
    );
  }
  return new Map<string, ShelfFileCheck>([
    [PATHS.plan, { state: "present" }],
    [PATHS.long, { state: "present" }],
    [PATHS.report, { state: "present" }],
    [PATHS.native, { state: "present" }],
    [PATHS.checking, { state: "unknown", checking: true }],
    [PATHS.unreachable, { state: "unreachable", reason: "The check timed out" }],
    [PATHS.nativeGone, { state: "missing" }],
    [PATHS.missing, { state: "missing" }],
    [PATHS.inherited, { state: "present" }],
  ]);
}

const KV = [
  "# Increment",
  `Spec: ${ROOT}/.specweave/increments/0042-season-registration-and-payments/spec.md`,
  "Artifact: https://claude.ai/artifact/ExampleArtifact0001",
  `Hash: ${"0123456789abcdef".repeat(4)}`,
  "worker.queue_path-override: /tmp/fixture/worker-lane_b/queue.log",
  "Ratio: 0.75",
  "Started: 2026-10-24 08:11:52",
].join("\n");
const JSON_TEXT = JSON.stringify({
  worktree: `${ROOT}/apps/web/src/components/chat`,
  at: "2026-10-24T08:22:41.586Z",
  port: 8319,
  address: "10.0.0.12",
});

function FilesMenu(props: { onOpenFile: (artifact: ThreadFileArtifact) => void }) {
  const [open, setOpen] = useState(false);
  const [pinned, setPinned] = useState<ReadonlySet<string>>(new Set());
  const [hidden, setHidden] = useState<ReadonlySet<string>>(new Set());
  const checks = useMemo(fileChecks, []);
  const entries = useMemo(
    () =>
      shelfEntries({
        artifacts: ARTIFACTS,
        mentionedAt: (artifact) =>
          artifact.kind === "native"
            ? artifact.native.publishedAt
            : (DATES[artifact.messageId] ?? null),
        source: (artifact) =>
          artifact.kind === "native"
            ? { label: "Published to claude.ai" }
            : SOURCES[artifact.messageId]
              ? { label: SOURCES[artifact.messageId]! }
              : null,
        inherited: (artifact) =>
          artifact.messageId === "message-inherited" ? { machineLabel: "Studio Mini" } : null,
        root: ROOT,
        pullRequests: new Map(),
        fileChecks: checks,
        pinned,
        hidden,
        now: NOW,
      }),
    [checks, hidden, pinned],
  );
  const toggle = (set: ReadonlySet<string>, id: string, on: boolean) => {
    const next = new Set(set);
    if (on) next.add(id);
    else next.delete(id);
    return next;
  };
  const visible = entries.filter((entry) => !entry.hidden).length;
  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger
        render={
          <Button
            size="xs"
            variant="ghost"
            aria-label={`${visible} artifacts`}
            data-thread-artifacts={visible}
          />
        }
      >
        <ShapesIcon aria-hidden />
        <span className="tabular-nums">{visible}</span>
      </PopoverTrigger>
      <PopoverPopup align="end" padding="compact" className="w-96 max-w-[90vw]">
        <ArtifactShelfList
          entries={entries}
          now={NOW}
          notice={
            offline ? "Studio Mini is offline. Its files can't be checked until it is back." : null
          }
          iconFor={(entry) => KIND_ICON[entry.artifact.kind]}
          onOpen={(entry) => {
            setOpen(false);
            const { artifact } = entry;
            if (artifact.kind === "native" || artifact.kind === "link") {
              // The app opens these in the system browser; the fixture records the request.
              Object.assign(window, {
                fixtureExternal: artifact.kind === "native" ? artifact.native.url : artifact.url,
              });
              return;
            }
            if ("meta" in artifact) props.onOpenFile(artifact);
          }}
          onPin={(entry, on) => setPinned((current) => toggle(current, entry.id, on))}
          onHide={(entry, on) => setHidden((current) => toggle(current, entry.id, on))}
        />
      </PopoverPopup>
    </Popover>
  );
}

function FixtureReader(props: { path: string }) {
  return (
    <div className="p-4 text-sm" data-fixture-reader={props.path}>
      <p className="font-medium">Fixture file</p>
      <p className="mt-1 break-all font-mono text-muted-foreground text-xs">{props.path}</p>
    </div>
  );
}

function useRowWidth(): number {
  const [width, setWidth] = useState(() => window.innerWidth);
  useLayoutEffect(() => {
    const update = () => setWidth(window.innerWidth);
    window.addEventListener("resize", update);
    return () => window.removeEventListener("resize", update);
  }, []);
  return width;
}

function RightPanel() {
  const thread = useRightPanelStore((state) => state.byThreadKey["fixture:fixture-thread"]);
  const surfaces = thread?.surfaces ?? [];
  const active = surfaces.find((surface) => surface.id === thread?.activeSurfaceId) ?? null;
  if (!thread?.isOpen || active === null) return null;
  return (
    <div
      style={{ width: PANEL_WIDTH, flex: "none" }}
      className="flex min-h-0 border-s border-border"
    >
      <RightPanelTabs
        mode="inline"
        open
        keybindings={[] as never}
        getShortcutContext={() => ({}) as never}
        surfaces={surfaces}
        environmentId={"fixture" as never}
        activeSurfaceId={active.id}
        pendingSurfaceIds={new Set()}
        previewSessions={{}}
        desktopByTabId={{}}
        terminalLabelsById={new Map()}
        onActivate={(surface) =>
          useRightPanelStore.getState().activateSurface(threadRef, surface.id)
        }
        onCloseSurface={(surface) =>
          useRightPanelStore.getState().closeSurface(threadRef, surface.id)
        }
        onCloseOtherSurfaces={() => {}}
        onCloseSurfacesToRight={() => {}}
        onCloseAllSurfaces={() => useRightPanelStore.getState().closeAllSurfaces(threadRef)}
        onCopyFilePath={() => {}}
        onAddBrowser={() => {}}
        onAddBrowserInProfile={() => {}}
        onAddTerminal={() => {}}
        onAddDiff={() => {}}
        onAddFiles={() => {}}
        onAddPullRequest={() => {}}
        onAddPullRequests={() => {}}
        onAddDevice={() => {}}
        browserAvailable={false}
        terminalAvailable={false}
        diffAvailable={false}
        filesAvailable={false}
        pullRequestAvailable={false}
        pullRequestsAvailable={false}
        deviceAvailable={false}
      >
        {active.kind === "file" ? <FixtureReader path={active.relativePath} /> : null}
      </RightPanelTabs>
    </div>
  );
}

function Root() {
  const [opened, setOpened] = useState<ThreadFileArtifact | null>(null);
  const rowWidth = useRowWidth();
  const panelOpen = useRightPanelStore(
    (state) => state.byThreadKey["fixture:fixture-thread"]?.isOpen ?? false,
  );
  useFileReaderLayoutReport(threadRef, rowWidth, PANEL_WIDTH, false, false);
  const viewable = useMemo(
    () => ARTIFACTS.filter((artifact): artifact is ThreadFileArtifact => "meta" in artifact),
    [],
  );
  const checks = useMemo(fileChecks, []);
  const index =
    opened === null ? -1 : viewable.findIndex((artifact) => artifact.key === opened.key);
  const link = (path: string, label: string) => (
    <button
      type="button"
      className="text-left underline underline-offset-2"
      data-fixture-link={path}
      onClick={() =>
        openFileInFront({
          environmentId: "fixture" as never,
          threadRef,
          cwd: "",
          path,
          line: undefined,
        })
      }
    >
      {label}
    </button>
  );
  return (
    <ToastProvider>
      <AnchoredToastProvider>
        <div className="flex h-screen min-h-0 bg-background text-foreground">
          <main
            className="flex min-w-0 flex-1 flex-col overflow-y-auto"
            data-fixture-conversation=""
          >
            <header className="flex items-center justify-between border-b border-border px-4 py-2 text-sm">
              <span className="text-muted-foreground">Season setup · Conversation</span>
              <FilesMenu onOpenFile={setOpened} />
            </header>
            <div className="mx-auto w-full max-w-3xl px-4 py-6">
              <div className="chat-markdown w-full min-w-0 text-sm leading-relaxed text-foreground [overflow-wrap:anywhere] [word-break:break-word]">
                <p>
                  The plan is in {link("docs/season-plan.md", "season-plan.md")} and the notes are
                  in {link("notes/todo.md", "todo.md")}.
                </p>
                <div className="my-[0.65rem]" data-fixture-card="kv">
                  {structuredFenceView("kv", KV)}
                </div>
                <div className="my-[0.65rem]" data-fixture-card="json">
                  {structuredFenceView("json", JSON_TEXT)}
                </div>
              </div>
              <textarea
                aria-label="Message draft"
                placeholder="Ask a follow-up"
                className="mt-5 w-full rounded-xl border border-border bg-transparent p-4"
              />
            </div>
          </main>
          {panelOpen ? <RightPanel /> : null}
        </div>
        {index >= 0 ? (
          <ArtifactViewer
            threadRef={threadRef}
            cwd={ROOT}
            artifacts={viewable}
            index={index}
            onIndex={(next) => setOpened(viewable[next] ?? null)}
            onClose={() => setOpened(null)}
            fileStateOf={(artifact) => {
              const check = checks.get(artifact.meta.filePath);
              return check ? { state: check.state, reason: check.reason ?? null, offline } : null;
            }}
          />
        ) : null}
        <ViewerOverlayHost />
      </AnchoredToastProvider>
    </ToastProvider>
  );
}

const router = createRouter({
  routeTree: createRootRoute({ component: Root }),
  history: createMemoryHistory({ initialEntries: ["/"] }),
});
Object.assign(window, {
  fixtureState: () => ({
    overlay: useViewerOverlayStore.getState().active?.title ?? null,
    focused: useFocusedFileStore.getState().file?.path ?? null,
    panel: (() => {
      const thread = useRightPanelStore.getState().byThreadKey["fixture:fixture-thread"];
      const active = thread?.surfaces.find((surface) => surface.id === thread.activeSurfaceId);
      return thread?.isOpen && active?.kind === "file" ? active.relativePath : null;
    })(),
    external: (window as { fixtureExternal?: string }).fixtureExternal ?? null,
  }),
});
createRoot(document.getElementById("root")!).render(<RouterProvider router={router} />);
