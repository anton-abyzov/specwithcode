import { createRoot } from "react-dom/client";
import { scopeProjectRef } from "@specweave-studio/client-runtime/environment";
import { EnvironmentId, ProjectId } from "@specweave-studio/contracts";
import { DraftId, useComposerDraftStore } from "../../src/composerDraftStore";
import { DraftMachinePicker } from "../../src/components/chat/DraftMachinePicker";
import StudioSidebar from "../../src/components/studio/shell/StudioSidebar";
import { SidebarProvider } from "../../src/components/ui/sidebar";
import { projects } from "./mocks";
import "./fixture.css";

const params = new URLSearchParams(location.search);
const view = params.get("view") ?? "sidebar";
document.documentElement.classList.toggle("dark", params.get("theme") === "dark");

// view=menu: a draft on this machine's assistant (project=personal) or on a code project.
const active = projects.find(
  (p) => p.id === (params.get("project") === "code" ? "household-m4" : "aide-m4"),
)!;
const draftId = DraftId.make("aide-per-machine");
useComposerDraftStore
  .getState()
  .setLogicalProjectDraftThreadId(
    active.workspaceRoot,
    scopeProjectRef(EnvironmentId.make(active.environmentId), ProjectId.make(active.id)),
    draftId,
    {},
  );
useComposerDraftStore.getState().setPrompt(draftId, "Plan the grocery run for Saturday");

createRoot(document.getElementById("root")!).render(
  view === "menu" ? (
    <main className="min-h-screen bg-background p-8 text-foreground">
      <h1 className="mb-4 font-medium">{active.title}</h1>
      <div className="flex items-center gap-2 rounded-lg border p-2">
        <DraftMachinePicker
          draftId={draftId}
          disabled={false}
          sendInFlightRef={{ current: false }}
          onPendingChange={() => {}}
        />
      </div>
    </main>
  ) : (
    <SidebarProvider>
      <aside className="h-screen w-[400px] max-w-full overflow-auto border-r border-border bg-sidebar text-sidebar-foreground">
        <StudioSidebar />
      </aside>
    </SidebarProvider>
  ),
);
