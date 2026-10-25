// Synthetic data only: no server, account, provider, network or store.
// ?theme=light|dark
// ?scene=new-design|new-design-found|new-design-archived|from-code-found|from-code-scanning|
//        from-code-none|from-code-failed|from-code-copy|from-code-archived|editor-refused|editor-reuse
import type {
  DesignDocument,
  DesignOwnerInput,
  DesignSystemId,
  DesignSystemSummary,
  DesignThreadBinding,
  ProjectId,
} from "@specweave-studio/contracts";
import {
  createMemoryHistory,
  createRootRoute,
  createRouter,
  RouterProvider,
} from "@tanstack/react-router";
import { useEffect, useMemo, useState } from "react";
import { createRoot } from "react-dom/client";

import { DesignFromCodeDialog } from "../../src/components/design/DesignFromCodeDialog";
import { DesignEditor } from "../../src/components/design/editor/DesignEditor";
import type { ScanState } from "../../src/components/design/gallery/creationSystem";
import type { GalleryProject } from "../../src/components/design/gallery/DesignActions";
import type { FoundSystem } from "../../src/components/design/gallery/foundSystems";
import { NewDesignDialog } from "../../src/components/design/gallery/NewDesignDialog";
import type { CopyOutcome } from "../../src/components/design/systems/DesignSystemPicker";
import { PROJECTS, SYSTEMS } from "../../src/components/design/systems/fixtureData";
import { AnchoredToastProvider, ToastProvider } from "../../src/components/ui/toast";
import { TooltipProvider } from "../../src/components/ui/tooltip";
import { createFakeServer } from "../design-canvas/fakeServer";
import "./fixture.css";

const params = new URLSearchParams(location.search);
const dark = params.get("theme") === "dark";
const scene = params.get("scene") ?? "new-design";
document.documentElement.classList.toggle("dark", dark);

const calls: Array<{ label: string; value: unknown }> = [];
const record = (label: string, value: unknown) => calls.push({ label, value });
Object.assign(window, { __fixture: { calls } });

// Atlas web and Borealis API own systems in the shared fixture; Harbor app owns none.
const HARBOR = { id: "harbor-app" as ProjectId, title: "Harbor app", kind: "code" as const };
const PROJECTS_HERE: GalleryProject[] = [
  ...(PROJECTS as unknown as GalleryProject[]),
  HARBOR,
  { id: "aide" as ProjectId, title: "Aide", kind: "personal" },
];
const ARCHIVED = {
  id: "old-site" as ProjectId,
  title: "Old marketing site",
  reason: "Archived project, not available here",
};

const UI_KIT: FoundSystem = {
  key: "pkg:repositories/harbor/ui-kit",
  name: "ui-kit",
  description: "Harbor's component library and tokens",
  paths: ["repositories/harbor/ui-kit/src/styles/tokens.css"],
  sources: [
    { path: "repositories/harbor/ui-kit/src/styles/tokens.css", tokens: 283, components: 0 },
    { path: "repositories/harbor/ui-kit/src/primitives/index.ts", tokens: 0, components: 321 },
  ],
  tokens: 283,
  components: 321,
  modes: ["light", "dark"],
  swatches: [
    { name: "color-brand", value: "#595ecc", darkValue: "#7d84ff" },
    { name: "color-brand-deep", value: "#3a3f8f", darkValue: "#9a9ff5" },
    { name: "color-win", value: "#169c5b", darkValue: "#34d399" },
    { name: "color-draw", value: "#64748b", darkValue: "#94a3b8" },
    { name: "color-loss", value: "#dc2626", darkValue: "#f87171" },
    { name: "color-live", value: "#e11d48", darkValue: "#fb7185" },
    { name: "color-ground", value: "#fafafa", darkValue: "#12161c" },
    { name: "color-ink", value: "#22263b", darkValue: "#f4f6f8" },
  ],
  copies: ["repositories/harbor/status/public/brand/ui-kit-tokens.css"],
};
const SITE_THEME: FoundSystem = {
  ...UI_KIT,
  key: "pkg:repositories/harbor/site",
  name: "site",
  description: null,
  paths: ["repositories/harbor/site/src/app/globals.css"],
  sources: [{ path: "repositories/harbor/site/src/app/globals.css", tokens: 42, components: 6 }],
  tokens: 42,
  components: 6,
  modes: ["default"],
  swatches: UI_KIT.swatches.slice(0, 3),
  copies: [],
};

const SCANS: Record<string, ScanState> = {
  "from-code-found": { status: "done", found: [UI_KIT, SITE_THEME], truncated: false },
  "new-design-found": { status: "done", found: [UI_KIT, SITE_THEME], truncated: false },
  "from-code-copy": { status: "done", found: [], truncated: false },
  "from-code-scanning": { status: "scanning" },
  "from-code-none": { status: "done", found: [], truncated: true },
  "from-code-failed": {
    status: "failed",
    message: "The project folder is not on this machine. Clone it first.",
  },
};

const copy = async (system: DesignSystemSummary, to: DesignOwnerInput): Promise<CopyOutcome> => {
  record("copy", { system: system.ref.systemId, to });
  return { ok: true, systemId: "copied" as DesignSystemId, name: system.name };
};

function Dialogs() {
  const scan = SCANS[scene] ?? null;
  const common = {
    open: true,
    onOpenChange: (open: boolean) => record("open-change", open),
    systems: SYSTEMS,
    onCopySystem: copy,
    scanFor: () => scan,
    onScan: (projectId: ProjectId, again?: boolean) => record("scan", { projectId, again }),
  };
  if (scene.startsWith("new-design"))
    return (
      <NewDesignDialog
        {...common}
        projects={PROJECTS_HERE}
        onCreate={async (request) => {
          record("create", request);
          return null;
        }}
        {...(scene === "new-design-found"
          ? { initialOwner: { kind: "project", projectId: HARBOR.id } }
          : scene === "new-design-archived"
            ? { initialOwner: { kind: "project", projectId: ARCHIVED.id }, unavailable: ARCHIVED }
            : {})}
      />
    );
  return (
    <DesignFromCodeDialog
      {...common}
      projects={PROJECTS_HERE.filter((project) => project.kind !== "personal")}
      initialProjectId={scene === "from-code-archived" ? ARCHIVED.id : HARBOR.id}
      {...(scene === "from-code-archived" ? { unavailable: ARCHIVED } : {})}
      workerLabelFor={() => "Claude Code · Opus 5.5"}
      onStart={async (request) => {
        record("start", request);
        return null;
      }}
    />
  );
}

const editorScene = scene.startsWith("editor");
const server = editorScene
  ? createFakeServer({
      nodes: 0,
      thread: scene === "editor-refused" ? "none" : "here",
      latencyMs: 20,
      refuseBinding: scene === "editor-refused",
      ...(scene === "editor-reuse"
        ? {
            reuse: {
              name: UI_KIT.name,
              paths: UI_KIT.sources.map((source) => source.path),
              tokens: UI_KIT.tokens,
              components: UI_KIT.components,
              modes: [...UI_KIT.modes],
              proposalId: "prop_fixture",
              foundAt: "2026-10-23T21:40:00.000Z",
            },
          }
        : {}),
    })
  : null;
if (server) Object.assign(window, { __design: server });

function Chat({ binding }: { binding: DesignThreadBinding }) {
  return (
    <div className="flex min-h-0 flex-1 flex-col" data-testid="fixture-chat">
      <div className="border-b border-border/70 px-4 py-3 text-sm font-medium">Design thread</div>
      <p className="p-4 text-sm text-muted-foreground">Thread {binding.threadId}</p>
    </div>
  );
}

function Editor() {
  const fake = server!;
  const [live, setLive] = useState<DesignDocument | null>(null);
  const [initial] = useState(() => fake.head);
  useEffect(() => fake.watch(setLive), [fake]);
  const data = useMemo(
    () => ({
      initial,
      live,
      system: fake.system,
      assetUrl: (asset: string) => fake.assets.get(asset) ?? "",
    }),
    [fake, initial, live],
  );
  return (
    <div className="flex h-dvh min-h-0">
      <DesignEditor
        backend={fake.backend}
        data={data}
        designKey="p.harbor-app.d_fixture"
        renderChat={(binding) => <Chat binding={binding} />}
      />
    </div>
  );
}

const router = createRouter({
  routeTree: createRootRoute({
    component: () => (
      <ToastProvider>
        <AnchoredToastProvider>
          <TooltipProvider>
            {editorScene ? (
              <Editor />
            ) : (
              <div className="h-dvh bg-background">
                <Dialogs />
              </div>
            )}
          </TooltipProvider>
        </AnchoredToastProvider>
      </ToastProvider>
    ),
  }),
  history: createMemoryHistory(),
});

createRoot(document.getElementById("root")!).render(<RouterProvider router={router} />);
