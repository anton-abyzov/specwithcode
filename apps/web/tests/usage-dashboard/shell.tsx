// A stand-in for the app shell: sidebar, coordinator and threads panes, with
// the usage chip under the coordinator composer. Only the Usage page is real.
import { useState } from "react";
import { UsagePage } from "../../src/components/usage/UsagePage";

function Shell({ children }: { children?: React.ReactNode }) {
  return (
    <div className="flex h-dvh w-full bg-background text-foreground">
      <aside className="flex w-64 shrink-0 flex-col gap-1 border-e bg-sidebar p-3 text-sm text-sidebar-foreground">
        <span className="px-2 py-1 font-medium">Projects</span>
        {["specweave", "EasyChamp", "vskill"].map((name) => (
          <span
            key={name}
            className="rounded-md px-2 py-1 data-[on]:bg-accent"
            data-on={name === "specweave" ? "" : undefined}
          >
            {name}
          </span>
        ))}
        <span className="mt-4 px-2 py-1 text-muted-foreground">Usage</span>
        <span className="px-2 py-1 text-muted-foreground">Settings</span>
      </aside>
      {children}
    </div>
  );
}

function Workspace({ onOpenLimits }: { onOpenLimits: () => void }) {
  return (
    <>
      <section className="flex min-w-0 flex-1 flex-col border-e" data-pane="coordinator">
        <header className="flex h-12 items-center border-b px-4 text-sm font-medium">
          specweave · Coordinator
        </header>
        <div className="flex flex-1 flex-col gap-3 p-6 text-sm text-muted-foreground">
          <p>Coordinator conversation (fixture text).</p>
          <p>The thread, its scroll position and the composer draft stay mounted.</p>
        </div>
        <footer className="flex items-center gap-3 border-t p-3">
          <span className="flex-1 rounded-lg border px-3 py-2 text-sm text-muted-foreground">
            Draft kept: "check the limits"
          </span>
          <button
            type="button"
            aria-label="Coordinator subscription usage"
            className="rounded-md border px-2 py-1 text-xs text-warning-foreground"
            onClick={onOpenLimits}
          >
            Codex 10% left · All limits and accounts →
          </button>
        </footer>
      </section>
      <section className="flex w-96 shrink-0 flex-col" data-pane="threads">
        <header className="flex h-12 items-center border-b px-4 text-sm font-medium">
          Threads
        </header>
        <div className="flex flex-col gap-2 p-4 text-sm">
          {["Open all limits as a sheet", "Readable fallback badge", "Release 1015"].map(
            (title) => (
              <span key={title} className="rounded-md border px-3 py-2">
                {title}
              </span>
            ),
          )}
        </div>
      </section>
    </>
  );
}

export function ShellFixture({ mode }: { mode: "before" | "after" }) {
  const [open, setOpen] = useState(mode === "after");
  if (mode === "before") {
    // What the /usage route did: the page replaced both panes.
    return (
      <Shell>
        <UsagePage />
      </Shell>
    );
  }
  return (
    <Shell>
      <Workspace onOpenLimits={() => setOpen(true)} />
      {open ? (
        <UsagePage variant="sheet" initialMetric="limits" onClose={() => setOpen(false)} />
      ) : null}
    </Shell>
  );
}
