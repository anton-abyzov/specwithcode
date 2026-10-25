// Synthetic data only: no server, account, provider, network or store.
// ?theme=light|dark
// ?scene=system|files|assets|empty|scratch|menu|edit|connect|more-menu|board
import type {
  DesignDocument,
  DesignNode,
  DesignSummary,
  ProjectId,
} from "@specweave-studio/contracts";
import {
  createMemoryHistory,
  createRootRoute,
  createRoute,
  createRouter,
  RouterProvider,
} from "@tanstack/react-router";
import { useEffect, useRef, useState, type ReactNode } from "react";
import { createRoot } from "react-dom/client";

import { DesignGalleryView } from "../../src/components/design/gallery/DesignGalleryView";
import { DesignThumbnail } from "../../src/components/design/gallery/DesignThumbnail";
import type { GalleryProject } from "../../src/components/design/gallery/DesignActions";
import type { GalleryScope } from "../../src/components/design/gallery/galleryModel";
import {
  connectSubjectOf,
  useConnectDesign,
} from "../../src/components/design/gallery/useConnectDesign";
import { SystemPage } from "../../src/components/design/systems/workspace/SystemPage";
import { ProjectMoreMenu } from "../../src/components/studio/shell/ProjectMoreMenu";
import { AnchoredToastProvider, ToastProvider } from "../../src/components/ui/toast";
import { TooltipProvider } from "../../src/components/ui/tooltip";
import { WorkspacePageContainer } from "../../src/components/WorkspacePageContainer";
import { WorkspacePageHeader } from "../../src/components/WorkspacePageHeader";
import {
  ineligibleProjectLabel,
  isScratchMember,
  projectChoiceIneligibleReason,
} from "../../src/studio/projectListVisibility";
import { DOCUMENTS } from "../design-workspace/designs";
import { fixture, useFixtureDesigns } from "./mocks";
import {
  DESIGNS,
  EMPTY_SYSTEM,
  ENVIRONMENT,
  PROJECT,
  PROJECTS,
  SCRATCH_ROOT,
  SYSTEM_ID,
} from "./systemData";
import "./fixture.css";

const params = new URLSearchParams(location.search);
const dark = params.get("theme") === "dark";
const scene = params.get("scene") ?? "system";
document.documentElement.classList.toggle("dark", dark);

const NOW = Date.parse("2026-10-24T09:00:00.000Z");
const OWNER = { kind: "project", projectId: PROJECT } as const;
const record = (label: string, value: unknown) =>
  fixture.calls.push({ label, rpc: label, environmentId: null, input: value });

/** Berth board: a harbor master's grid in the Harbor UI colors. */
const BERTH_STATUS = ["#16A34A", "#DC2626", "#16A34A", "#D97706", "#0E7490", "#16A34A"];
const berthNode = (index: number, fill: string) => ({
  id: `n_${index}`,
  parentId: "f_root",
  type: "rect" as const,
  x: 64 + (index % 6) * 220,
  y: 200 + Math.floor(index / 6) * 140,
  width: 196,
  height: 116,
  fill,
  radius: 12,
});
const BERTH_BOARD: DesignDocument = {
  ...DOCUMENTS[0]!,
  id: "d_berths",
  title: "Berth board",
  pages: [
    {
      id: "p_1",
      name: "Page 1",
      nodes: [
        { ...DOCUMENTS[0]!.pages[0]!.nodes[0]!, fill: "#FAFAFA" },
        { ...berthNode(-1, "#22263B"), x: 0, y: 0, width: 1440, height: 120, radius: 0 },
        ...Array.from({ length: 30 }, (_, index) =>
          berthNode(index, BERTH_STATUS[(index * 7) % BERTH_STATUS.length]!),
        ),
      ] as DesignNode[],
    },
  ],
};
const THUMBNAIL_DOCUMENTS = new Map(
  [...DOCUMENTS, BERTH_BOARD].map((document) => [document.id, document]),
);

/** The gallery's projects, as the Design page builds them: names stay, ineligible ones say why. */
const GALLERY_PROJECTS: GalleryProject[] = PROJECTS.filter(
  (project) => !isScratchMember(project as never, () => SCRATCH_ROOT),
).map((project) => {
  const reason = projectChoiceIneligibleReason(project as never, () => SCRATCH_ROOT, "design");
  return {
    id: project.id,
    title: project.title,
    projectKey: `logical-project:${project.id}`,
    icon: project as never,
    kind: "code" as const,
    updatedAt: project.updatedAt,
    ...(reason === null ? {} : { unavailable: ineligibleProjectLabel(reason) }),
  };
});

function SystemScene({ systemId, hash: initialHash = "" }: { systemId: string; hash?: string }) {
  const [hash, setHash] = useState(initialHash);
  return (
    <div className="flex h-dvh min-h-0 flex-col" data-testid="fixture-page">
      <SystemPage
        environmentId={ENVIRONMENT}
        owner={OWNER}
        systemId={systemId as never}
        hash={hash}
        onHashChange={setHash}
      />
    </div>
  );
}

/** A project's design board (or the Playground), wired as DesignGalleryPage wires it. */
function BoardScene({ scope, connectFirst }: { scope: GalleryScope; connectFirst?: boolean }) {
  const designs = useFixtureDesigns();
  const [moved, setMoved] = useState<string | null>(null);
  const connect = useConnectDesign({
    environmentId: ENVIRONMENT,
    owner: true,
    designs,
    onMoved: ({ project }) => setMoved(project.title),
  });
  const opened = useRef(false);
  useEffect(() => {
    if (!connectFirst || opened.current || !connect.available) return;
    opened.current = true;
    connect.request(connectSubjectOf(DESIGNS[0]!));
  }, [connect, connectFirst]);
  const handlers = {
    onOpen: (summary: DesignSummary) => record("gallery.open", summary.ref.designId),
    onCopy: async (summary: DesignSummary) => {
      record("gallery.copy", summary.ref.designId);
      return null;
    },
    onDelete: async (summary: DesignSummary) => {
      record("gallery.delete", summary.ref.designId);
      return null;
    },
    onCopyLink: (summary: DesignSummary) => record("gallery.copyLink", summary.ref.designId),
    onRename: async (summary: DesignSummary, title: string) => {
      record("gallery.rename", { designId: summary.ref.designId, title });
      return null;
    },
    onDuplicate: (summary: DesignSummary) => record("gallery.duplicate", summary.ref.designId),
  };
  const title = scope.kind === "project" ? "Harbor app" : "Playground";
  return (
    <div className="flex h-dvh min-h-0 flex-col bg-background text-foreground">
      <WorkspacePageHeader className="gap-2">
        <h1 className="min-w-0 truncate font-medium text-sm">{title} · Designs</h1>
      </WorkspacePageHeader>
      <div className="min-h-0 flex-1 overflow-auto" data-testid="fixture-page">
        <WorkspacePageContainer width="expanded">
          {moved !== null ? (
            <p role="status" className="sr-only" data-testid="fixture-moved">
              Moved to {moved}
            </p>
          ) : null}
          <DesignGalleryView
            designs={designs}
            error={null}
            problems={[]}
            projects={GALLERY_PROJECTS}
            now={NOW}
            canWrite
            canOperate
            renderThumbnail={(summary) => (
              <DesignThumbnail
                className="h-full w-full"
                document={THUMBNAIL_DOCUMENTS.get(summary.ref.designId) ?? null}
              />
            )}
            onCreate={(kind) => record("gallery.create", kind)}
            {...handlers}
            onOpenProject={(summary, projectKey) =>
              record("gallery.openProject", { designId: summary.ref.designId, projectKey })
            }
            onConnect={
              connect.available
                ? (summary, projectId) => connect.request(connectSubjectOf(summary), projectId)
                : null
            }
            scope={scope}
            onScopeChange={(next) => record("gallery.scope", next)}
          />
        </WorkspacePageContainer>
      </div>
      {connect.dialog}
    </div>
  );
}

function MoreMenuScene() {
  const harbor = PROJECTS[0]!;
  return (
    <div className="flex h-dvh min-h-0 flex-col bg-background text-foreground">
      <WorkspacePageHeader className="gap-2" data-testid="fixture-page">
        <h1 className="min-w-0 flex-1 truncate font-medium text-sm">{harbor.title}</h1>
        <ProjectMoreMenu
          project={harbor as never}
          projectKey={`logical-project:${harbor.id}`}
          projectTitle={harbor.title}
          onOpenPlan={() => record("project.plan", harbor.id)}
          onOpenSettingsTab={(tab) => record("project.settings", tab)}
        />
      </WorkspacePageHeader>
    </div>
  );
}

const PROJECT_SCOPE: GalleryScope = { kind: "project", projectId: PROJECT as ProjectId };

function Scene() {
  switch (scene) {
    case "empty":
      return <SystemScene systemId={EMPTY_SYSTEM.id} />;
    case "assets":
      return <SystemScene systemId={SYSTEM_ID} hash="assets" />;
    case "system":
    case "files":
    case "menu":
    case "edit":
      return <SystemScene systemId={SYSTEM_ID} />;
    case "connect":
      return <BoardScene scope={{ kind: "playground" }} connectFirst />;
    case "more-menu":
      return <MoreMenuScene />;
    case "board":
    case "scratch":
      return <BoardScene scope={PROJECT_SCOPE} />;
    default:
      return <p>Unknown scene {scene}</p>;
  }
}

function Providers({ children }: { children: ReactNode }) {
  return (
    <ToastProvider>
      <AnchoredToastProvider>
        <TooltipProvider>{children}</TooltipProvider>
      </AnchoredToastProvider>
    </ToastProvider>
  );
}

// Every path matches, so a navigation is recorded and the scene stays.
const rootRoute = createRootRoute({
  component: () => (
    <Providers>
      <Scene />
    </Providers>
  ),
});
const anyPath = createRoute({ getParentRoute: () => rootRoute, path: "$", component: () => null });
const index = createRoute({ getParentRoute: () => rootRoute, path: "/", component: () => null });
const router = createRouter({
  routeTree: rootRoute.addChildren([index, anyPath]),
  history: createMemoryHistory({ initialEntries: ["/"] }),
});

Object.assign(window, {
  __fixture: Object.assign(fixture, { location: () => router.state.location.href }),
});

createRoot(document.getElementById("root")!).render(<RouterProvider router={router} />);
