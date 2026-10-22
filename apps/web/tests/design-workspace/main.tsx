// Synthetic data only: no server, account, provider, network or store.
// ?theme=light|dark  ?scene=gallery|dialog|new|library
import type { DesignSystemSummary, DesignSummary } from "@specweave-studio/contracts";
import { createRoot } from "react-dom/client";
import { useState } from "react";

import { DesignFromCodeDialog } from "../../src/components/design/DesignFromCodeDialog";
import { DesignGalleryView } from "../../src/components/design/gallery/DesignGalleryView";
import { DesignThumbnail } from "../../src/components/design/gallery/DesignThumbnail";
import { workerModelLabel } from "../../src/components/design/gallery/designFromCode";
import { LibraryPane } from "../../src/components/studio/shell/LibraryPane";
import { ToastProvider } from "../../src/components/ui/toast";
import {
  WorkspaceBreadcrumb,
  WorkspaceBreadcrumbItem,
} from "../../src/components/WorkspaceBreadcrumb";
import { WorkspacePageContainer } from "../../src/components/WorkspacePageContainer";
import { WorkspacePageHeader } from "../../src/components/WorkspacePageHeader";
import { NewDesignDialog } from "../../src/components/design/gallery/NewDesignDialog";
import { DOCUMENTS, NOW, PROJECTS, SUMMARIES } from "./designs";
import { fixture, publish } from "./mocks";
import "./fixture.css";

const params = new URLSearchParams(location.search);
const dark = params.get("theme") === "dark";
const scene = params.get("scene") ?? "gallery";
document.documentElement.classList.toggle("dark", dark);

const SYSTEMS = [
  {
    ref: {
      owner: { kind: "project", environmentId: "host", projectId: "atlas-web" },
      systemId: "atlas-ui",
      path: ".specweave/design/systems/atlas-ui",
    },
    name: "Atlas UI",
    revision: 1,
    updatedAt: new Date(NOW).toISOString(),
    tokenCount: 84,
    componentCount: 23,
    sources: [],
    ownerLabel: "Atlas web",
  },
] as unknown as DesignSystemSummary[];

const WORKER = workerModelLabel(
  {
    instanceId: "claudeAgent",
    model: "claude-opus-5-5",
    options: [{ id: "effort", value: "high" }],
  } as never,
  [
    {
      instanceId: "claudeAgent",
      displayName: "Claude",
      models: [{ slug: "claude-opus-5-5", name: "Opus 5.5" }],
    },
  ] as never,
);

const record = (label: string, value: unknown) => fixture.calls.push({ label, value });
// The page resolves each project's workspace key; the fixture invents them.
const GALLERY_PROJECTS = PROJECTS.map((project) => ({
  ...project,
  projectKey: `logical-project:${project.id}`,
}));
Object.assign(window, { __fixture: fixture });

function Gallery() {
  const [designs, setDesigns] = useState(SUMMARIES);
  const [dialog, setDialog] = useState<string | null>(
    scene === "dialog" ? "design-from-code" : scene === "new" ? "design" : null,
  );
  return (
    <div className="flex h-dvh min-h-0 flex-col bg-background text-foreground">
      <WorkspacePageHeader>
        <WorkspaceBreadcrumb ariaLabel="Design breadcrumb" className="min-w-0">
          <WorkspaceBreadcrumbItem current>
            <h1>Design</h1>
          </WorkspaceBreadcrumbItem>
        </WorkspaceBreadcrumb>
      </WorkspacePageHeader>
      <div className="min-h-0 flex-1 overflow-auto">
        <WorkspacePageContainer width="expanded">
          <DesignGalleryView
            designs={designs}
            error={null}
            problems={[]}
            projects={GALLERY_PROJECTS as never}
            now={NOW}
            canWrite
            canOperate
            renderThumbnail={(summary: DesignSummary) => (
              <DesignThumbnail
                className="h-full w-full"
                document={DOCUMENTS.find((doc) => doc.id === summary.ref.designId) ?? null}
              />
            )}
            onCreate={(kind) => {
              record("create", kind);
              setDialog(kind);
            }}
            onOpen={(summary) => record("open", summary.ref.designId)}
            onCopy={async (summary, to) => {
              record("copy", { designId: summary.ref.designId, to });
              return null;
            }}
            onDelete={async (summary) => {
              record("delete", summary.ref.designId);
              setDesigns((current) => current.filter((entry) => entry !== summary));
              return null;
            }}
            onCopyLink={(summary) => record("copyLink", summary.ref.designId)}
            onRename={async (summary, title) => {
              record("rename", {
                designId: summary.ref.designId,
                title,
                expectedRevision: summary.revision,
              });
              setDesigns((current) =>
                current.map((entry) => (entry === summary ? { ...entry, title } : entry)),
              );
              return null;
            }}
            onDuplicate={(summary) => record("duplicate", summary.ref.designId)}
            onOpenProject={(summary, projectKey) =>
              record("openProject", { designId: summary.ref.designId, projectKey })
            }
          />
        </WorkspacePageContainer>
      </div>
      {dialog === "design-from-code" ? (
        <DesignFromCodeDialog
          open
          onOpenChange={(open) => !open && setDialog(null)}
          projects={PROJECTS as never}
          systems={SYSTEMS}
          initialProjectId={(scene === "dialog" ? "atlas-web" : null) as never}
          workerLabelFor={() => WORKER}
          onStart={async (request) => {
            record("start", request);
            setDialog(null);
            return null;
          }}
        />
      ) : null}
      {dialog === "design" ? (
        <NewDesignDialog
          open
          onOpenChange={(open) => !open && setDialog(null)}
          projects={PROJECTS as never}
          systems={SYSTEMS}
          onCreate={async (request) => {
            record("createDesign", request);
            setDialog(null);
            return null;
          }}
        />
      ) : null}
    </div>
  );
}

function Library() {
  return (
    <div className="flex h-dvh min-h-0 bg-background text-foreground">
      <div className="flex-1" />
      <aside className="project-thread-pane sws-threads flex w-[460px] flex-col border-border border-l">
        <LibraryPane
          environmentId={"host" as never}
          projectId={"atlas-web" as never}
          workspaceRoot="/Users/me/atlas-web"
          canChange
          bar={{
            tab: "library",
            onTabChange: () => undefined,
            counts: {},
            onNewThread: () => undefined,
            onOpenPlan: () => undefined,
            onOpenUsage: () => undefined,
            expanded: false,
            onToggleExpanded: () => undefined,
            onClose: () => undefined,
          }}
        />
      </aside>
    </div>
  );
}

publish({
  projectDesigns: SUMMARIES.filter(
    (summary) =>
      summary.ref.owner.kind === "project" && summary.ref.owner.projectId === "atlas-web",
  ),
});

createRoot(document.getElementById("root")!).render(
  <ToastProvider>{scene === "library" ? <Library /> : <Gallery />}</ToastProvider>,
);
