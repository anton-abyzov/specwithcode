// The real artifacts shelf above Threads and Library > Artifacts, over fictional artifacts.
// `?theme=dark` picks the theme. Nothing here talks to a server.
import { useState } from "react";
import { createRoot } from "react-dom/client";
import type { EnvironmentId, ThreadId } from "@specweave-studio/contracts";
import { applyThemePalette } from "../../src/themePalette";
import {
  collectProjectArtifacts,
  type ArtifactTypeFilter,
} from "../../src/studio/projectArtifacts";
import { ProjectArtifactShelf } from "../../src/components/studio/shell/ProjectArtifactShelf";
import { ProjectArtifactsLibrary } from "../../src/components/studio/shell/ProjectArtifactsLibrary";
import "../../src/components/studio/shell/shell.css";
import "../../src/components/studio/shell/panes.css";
import "./fixture.css";

const params = new URLSearchParams(location.search);
const dark = params.get("theme") === "dark";
document.documentElement.classList.toggle("dark", dark);
applyThemePalette("studio-chat", dark ? "dark" : "light");

const NOW = Date.parse("2026-10-30T18:00:00Z");
Date.now = () => NOW;
const ago = (minutes: number) => new Date(NOW - minutes * 60_000).toISOString();
const env = "m4" as EnvironmentId;
const thread = (id: string, title: string) => ({
  environmentId: env,
  threadId: id as ThreadId,
  title,
});
const THREADS: Record<string, ReturnType<typeof thread>> = {
  t1: thread("t1", "Build the artifacts shelf"),
  t2: thread("t2", "Unify Connect sign-in"),
  t3: thread("t3", "Pricing page refresh"),
};

function artifacts(pinned: ReadonlySet<string>) {
  return collectProjectArtifacts({
    workspaceRoot: "/work/app",
    library: {
      workspaceRoot: "/work/app",
      specweave: true,
      hub: null,
      hubProblem: null,
      artifacts: [
        {
          id: "h1",
          title: "Launch checklist",
          location: "https://example.com/launch-checklist",
          kind: "link",
          intentId: null,
          createdAt: ago(60 * 24 * 6),
          missing: false,
        },
      ],
      folders: [],
      outputs: [
        {
          path: ".specweave/increments/1148-shelf/reports/shelf-light.png",
          byteLength: 184_000,
          modifiedAt: ago(4),
          increment: "1148-shelf",
        },
        {
          path: ".specweave/increments/1148-shelf/reports/review.md",
          byteLength: 6_400,
          modifiedAt: ago(40),
          increment: "1148-shelf",
        },
        {
          path: ".specweave/reports/threads/connect-sign-in-report.html",
          byteLength: 42_000,
          modifiedAt: ago(60 * 5),
          increment: null,
        },
        {
          path: ".specweave/increments/1140-pricing/reports/metrics.json",
          byteLength: 2_100,
          modifiedAt: ago(60 * 30),
          increment: "1140-pricing",
        },
      ],
    },
    designs: [
      {
        ref: {
          owner: { kind: "project", projectId: "app" },
          designId: "d1",
          path: ".specweave/design/d1",
        },
        kind: "slides",
        title: "YC demo deck",
        revision: 4,
        updatedAt: ago(60 * 26),
        pageCount: 9,
        designSystem: null,
        ownerLabel: "SpecWithCode",
        thread: { environmentId: env, threadId: "t3" },
      } as never,
    ],
    pullRequests: [
      {
        key: "a",
        number: 1101,
        repository: "me/app",
        url: "https://github.com/me/app/pull/1101",
        title: "Project artifacts shelf and library",
        state: "open",
        updatedAt: ago(12),
        threadId: "t1" as ThreadId,
        threadTitle: "Build the artifacts shelf",
      },
      {
        key: "b",
        number: 1097,
        repository: "me/app",
        url: "https://github.com/me/app/pull/1097",
        title: "Check gh sign-in with an API call",
        state: "merged",
        updatedAt: ago(60 * 8),
        threadId: "t2" as ThreadId,
        threadTitle: "Unify Connect sign-in",
      },
    ],
    threadArtifacts: [
      {
        thread: THREADS.t2!,
        entries: [
          {
            id: "link:claude.ai/artifact/abc",
            kind: "native",
            name: "Sign-in flow explainer",
            url: "https://claude.ai/artifact/abc",
            at: NOW - 60 * 60_000 * 3,
          },
        ],
      },
      {
        thread: THREADS.t1!,
        entries: [
          {
            id: "file:x",
            kind: "image",
            name: "shelf-light.png",
            path: "/work/app/.specweave/increments/1148-shelf/reports/shelf-light.png",
            at: NOW - 3 * 60_000,
          },
        ],
      },
    ],
    threadOf: (id) => THREADS[id] ?? null,
    pinned,
  });
}

function Fixture() {
  const [pinned, setPinnedSet] = useState<ReadonlySet<string>>(() => new Set(["design:d1"]));
  const [type, setType] = useState<ArtifactTypeFilter>("all");
  const [view, setView] = useState<"list" | "grid">(
    params.get("view") === "grid" ? "grid" : "list",
  );
  const list = artifacts(pinned);
  const setPinned = (id: string, on: boolean) =>
    setPinnedSet((current) => {
      const next = new Set(current);
      if (on) next.add(id);
      else next.delete(id);
      return next;
    });
  return (
    <div className="fixture">
      <div className="fixture-pane" style={{ width: 440 }} data-testid="threads-pane">
        <h2>Threads</h2>
        <div className="sws-threads-body" style={{ paddingTop: 12 }}>
          <ProjectArtifactShelf
            environmentId={env}
            workspaceRoot="/work/app"
            artifacts={list}
            now={NOW}
            onPin={setPinned}
            onViewAll={() => undefined}
            onOpenThread={() => undefined}
          />
          <p style={{ fontSize: 13, color: "var(--muted-foreground)", margin: "0 4px" }}>
            3 threads · 1 waiting on you
          </p>
        </div>
      </div>
      <div className="fixture-pane" style={{ width: 760 }} data-testid="library-pane">
        <h2>Library</h2>
        <div className="sws-threads-body sws-library" style={{ paddingTop: 12 }}>
          <ProjectArtifactsLibrary
            environmentId={env}
            workspaceRoot="/work/app"
            artifacts={list}
            loaded
            query=""
            type={type}
            onTypeChange={setType}
            view={view}
            onViewChange={setView}
            onPin={setPinned}
            onOpenThread={() => undefined}
            sectionSwitch={
              <div className="sws-library-sections" role="tablist" aria-label="Library">
                <button type="button" role="tab" aria-selected className="sws-library-section">
                  Artifacts <span className="sws-library-section-count">{list.length}</span>
                </button>
                <button
                  type="button"
                  role="tab"
                  aria-selected={false}
                  className="sws-library-section"
                >
                  Files
                </button>
              </div>
            }
          />
        </div>
      </div>
    </div>
  );
}

createRoot(document.getElementById("root")!).render(<Fixture />);
