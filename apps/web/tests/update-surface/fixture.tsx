/* Isolated update UI fixture: the bridge, update agent and server are in-memory fakes. */
import type { CSSProperties } from "react";
import { createRoot } from "react-dom/client";
import { RegistryContext } from "@effect/atom-react";
import type { Atom } from "effect/reactivity";
import { appAtomRegistry } from "../../src/rpc/atomRegistry";
import { ConfirmDialogHost } from "../../src/components/ConfirmDialogHost";
import { StudioWordmark } from "../../src/components/StudioWordmark";
import { SidebarRestartToUpdate } from "../../src/components/sidebar/SidebarRestartToUpdate";
import { SidebarServerUpdate } from "../../src/components/sidebar/SidebarServerUpdate";
import {
  resolveInitialThreadSidebarWidth,
  resolveThreadSidebarMinimumWidth,
} from "../../src/components/threadSidebarWidth";
import { serverEnvironment } from "./mocks";

const scene = new URLSearchParams(location.search).get("scene") ?? "restart";
// The app sidebar's width before anyone resizes it (256px).
const defaultWidth = resolveInitialThreadSidebarWidth(null, window.innerWidth);

// The sidebar wrapper's titlebar inset (ui/sidebar.tsx), as in a browser window.
const titlebarInset = {
  "--workspace-titlebar-content-left":
    "calc(var(--workspace-controls-left) + var(--workspace-titlebar-control-size) + var(--workspace-titlebar-control-gap))",
} as CSSProperties;

Object.assign(window, {
  // The narrowest the app sidebar can be dragged to at the current text size: 208px, or the
  // brand's width once Settings > Appearance raises the text size enough.
  __sidebarMinimumWidth: () =>
    resolveThreadSidebarMinimumWidth(
      document.querySelector('[data-testid="sidebar-brand-probe"]')!.getBoundingClientRect().width,
    ),
  // Switches a server's update between idle, running and failed.
  __setServerUpdateState: (id: string, state: unknown) =>
    appAtomRegistry.set(serverEnvironment.updateStateAtom(id) as Atom.Writable<unknown>, state),
});

/* A copy of SidebarBrandWidthProbe (sidebar/SidebarChrome.tsx), which sets that minimum. */
function BrandWidthProbe() {
  return (
    <div style={titlebarInset}>
      <div
        aria-hidden="true"
        data-testid="sidebar-brand-probe"
        className="pointer-events-none invisible fixed top-0 left-0 flex w-max border-r border-transparent pr-3"
      >
        <div className="ml-[var(--workspace-titlebar-content-left)] flex">
          <span className="inline-flex min-w-0 items-center gap-1.5 text-sm font-medium tracking-tight">
            <StudioWordmark aria-label="SpecWithCode" className="size-[18px] shrink-0" />
            <span className="truncate leading-5 text-muted-foreground">SpecWithCode</span>
          </span>
        </div>
      </div>
    </div>
  );
}

/* A stand-in for the sidebar footer: a column of the app sidebar's width, pinned to the bottom left. */
function Fixture() {
  return (
    <RegistryContext.Provider value={appAtomRegistry}>
      <BrandWidthProbe />
      <div className="flex h-screen bg-background text-foreground">
        <aside
          data-testid="sidebar-column"
          data-default-width={defaultWidth}
          style={{ width: defaultWidth }}
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
