/* Isolated update UI fixture: the bridge, update agent and server are in-memory fakes. */
import { createRoot } from "react-dom/client";
import { RegistryContext } from "@effect/atom-react";
import { appAtomRegistry } from "../../src/rpc/atomRegistry";
import { ConfirmDialogHost } from "../../src/components/ConfirmDialogHost";
import { SidebarRestartToUpdate } from "../../src/components/sidebar/SidebarRestartToUpdate";
import { SidebarServerUpdate } from "../../src/components/sidebar/SidebarServerUpdate";

const scene = new URLSearchParams(location.search).get("scene") ?? "restart";

/* A stand-in for the sidebar footer: a 260px column pinned to the bottom left. */
function Fixture() {
  return (
    <RegistryContext.Provider value={appAtomRegistry}>
      <div className="flex h-screen bg-background text-foreground">
        <aside
          data-testid="sidebar-column"
          style={{ width: 260 }}
          className="flex shrink-0 flex-col border-r border-border bg-sidebar text-sidebar-foreground"
        >
          <div className="flex-1 p-3 text-xs text-muted-foreground">Threads</div>
          <div data-testid="sidebar-footer" className="flex flex-col gap-1.5 p-2">
            {scene === "restart" ? <SidebarRestartToUpdate /> : <SidebarServerUpdate />}
          </div>
        </aside>
        <main className="flex-1" />
      </div>
      <ConfirmDialogHost />
    </RegistryContext.Provider>
  );
}

createRoot(document.getElementById("root")!).render(<Fixture />);
