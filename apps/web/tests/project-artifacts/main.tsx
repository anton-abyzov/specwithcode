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
import { artifactPreviewCache, artifactPreviewFormat } from "../../src/studio/artifactPreview";
import { documentPreview, imagePreview } from "../../src/studio/artifactPreviewRaster";
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

interface BenchManifest {
  readonly outputs: ReadonlyArray<{
    readonly path: string;
    readonly byteLength: number;
    readonly modifiedAt: string;
  }>;
}

function benchArtifacts(manifest: BenchManifest, pinned: ReadonlySet<string>) {
  return collectProjectArtifacts({
    workspaceRoot: "/work/app",
    library: {
      workspaceRoot: "/work/app",
      specweave: true,
      hub: null,
      hubProblem: null,
      artifacts: [],
      folders: [],
      outputs: manifest.outputs.map((output) => ({ ...output, increment: null })),
    },
    designs: [],
    threadArtifacts: [],
    threadOf: (id) => THREADS[id] ?? null,
    pinned,
  });
}

function Fixture(props: { readonly bench: BenchManifest | null }) {
  const [pinned, setPinnedSet] = useState<ReadonlySet<string>>(() => new Set(["design:d1"]));
  const [type, setType] = useState<ArtifactTypeFilter>("all");
  const [view, setView] = useState<"list" | "grid">(
    params.get("view") === "grid" ? "grid" : "list",
  );
  const list = props.bench ? benchArtifacts(props.bench, pinned) : artifacts(pinned);
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
            3 threads · 1 needs you
          </p>
        </div>
      </div>
      <div
        className="fixture-pane"
        style={{ width: 760, ...(props.bench ? { height: "calc(100vh - 40px)" } : {}) }}
        data-testid="library-pane"
      >
        <h2>Library</h2>
        <div
          className="sws-threads-body sws-library"
          data-testid="library-scroll"
          style={{ paddingTop: 12 }}
        >
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

// `?bench=1` swaps the fictional artifacts for the ones bench.mjs serves.
const bench = params.has("bench")
  ? ((await (await fetch("/bench/manifest.json")).json()) as BenchManifest)
  : null;
createRoot(document.getElementById("root")!).render(<Fixture bench={bench} />);

declare global {
  interface Window {
    __artifactPreviewCacheStats: () => unknown;
    __artifactPreviewCost: () => Promise<unknown>;
  }
}
window.__artifactPreviewCacheStats = () => artifactPreviewCache.stats();
// Builds every preview once, one after another, and reports time and size per format.
window.__artifactPreviewCost = async () => {
  const seen: Record<string, { ms: number[]; bytes: number[]; failed: number }> = {};
  for (const artifact of benchArtifacts(bench!, new Set())) {
    const format = artifactPreviewFormat(artifact);
    if (format === null) continue;
    const url = `/bench/file?path=${encodeURIComponent(artifact.path!)}`;
    const started = performance.now();
    const preview =
      format === "image"
        ? await imagePreview(url)
        : await documentPreview(await (await fetch(url)).text(), format);
    const entry = (seen[format] ??= { ms: [], bytes: [], failed: 0 });
    entry.ms.push(performance.now() - started);
    if (preview === null || (preview.type !== "image" && preview.type !== "lines")) {
      entry.failed += 1;
    }
    entry.bytes.push(
      preview?.type === "image"
        ? preview.src.length
        : preview?.type === "lines"
          ? preview.lines.reduce((sum, line) => sum + line.text.length + 16, 32)
          : 16,
    );
  }
  return seen;
};
