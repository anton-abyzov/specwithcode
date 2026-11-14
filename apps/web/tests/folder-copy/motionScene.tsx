import { useEffect, useState } from "react";
import {
  RouterProvider,
  createMemoryHistory,
  createRootRoute,
  createRouter,
} from "@tanstack/react-router";
import { CopyProgressPanel } from "../../src/components/studio/CopyProgressPanel";
import { FolderCopyBanner } from "../../src/components/studio/FolderCopyBanner";
import { announceCopy } from "../../src/components/studio/HandoffFolderCopyWatcher";
import { syncCopyToasts } from "../../src/components/studio/folderCopyToasts";
import { ToastProvider } from "../../src/components/ui/toast";
import type { CopyProgressView } from "../../src/studio/copyProgress";
import {
  copyActivityKey,
  overallFraction,
  registerCopyOpener,
  setCopyActivity,
  useCopyActivity,
  type CopyActivity,
  type CopyWatch,
} from "../../src/studio/folderCopyActivity";

// `?motion=1`: two copies played on a clock, for a headless recording of the motion. The
// specweave copy to m5 measures, sends, applies and finishes; the vskill copy to linux-box
// stops partway through Send. The dialog panel, the project banner, the sidebar line and
// the toasts are the real components; only the clock is faster than a real copy.
const GB = 1_000_000_000;
const TOTAL = 7.5 * GB;
const FILES = 121_868;
const A = copyActivityKey("m4", "specweave");
const B = copyActivityKey("m4", "vskill");
const STARTED = new Date(Date.now() - 64_000).toISOString();

type Script = { measure: number; send: number; apply: number; failAt?: number };
const SCRIPTS: Record<string, Script & { target: string }> = {
  [A]: { measure: 2_400, send: 9_000, apply: 10_800, target: "m5" },
  [B]: { measure: 2_000, send: 12_000, apply: 13_000, failAt: 6_600, target: "linux-box" },
};

function viewAt(script: Script & { target: string }, t: number): CopyProgressView {
  const files = (fraction: number) => ({ done: Math.round(fraction * FILES), total: FILES });
  const bytes = (fraction: number) => ({ done: fraction * TOTAL, total: TOTAL });
  if (t < script.measure) {
    const fraction = t / script.measure;
    return {
      phase: "measure",
      step: "Reading the selected files on m4",
      fraction,
      bytes: bytes(fraction),
      files: files(fraction),
      bytesLocal: 0,
      rateKey: null,
      outcome: "running",
    };
  }
  const sendAt = (time: number) =>
    Math.min(1, (time - script.measure) / (script.send - script.measure));
  if (script.failAt !== undefined && t >= script.failAt) {
    const fraction = sendAt(script.failAt);
    return {
      phase: "send",
      step: `Stopped while sending to ${script.target}`,
      fraction,
      bytes: bytes(fraction),
      files: files(fraction),
      bytesLocal: 0,
      rateKey: null,
      outcome: "failed",
    };
  }
  if (t < script.send) {
    const fraction = sendAt(t);
    return {
      phase: "send",
      step: `Sending files to ${script.target}`,
      fraction,
      bytes: bytes(fraction),
      files: files(fraction),
      bytesLocal: 0,
      rateKey: "send:files",
      outcome: "running",
    };
  }
  const fraction = Math.min(1, (t - script.send) / (script.apply - script.send));
  return {
    phase: "apply",
    step: fraction < 1 ? `Writing files on ${script.target}` : `Copied to ${script.target}`,
    fraction,
    bytes: bytes(1),
    files: files(fraction),
    bytesLocal: 0,
    rateKey: null,
    outcome: fraction < 1 ? "running" : "finished",
  };
}

const activityOf = (key: string, view: CopyProgressView): CopyActivity => ({
  machine: SCRIPTS[key]!.target,
  label: view.phase === "measure" ? "Measuring the folder" : "Copying files",
  fraction: view.fraction,
  waiting: false,
  source: "m4",
  progress: view,
});
const watches = new Map<string, CopyWatch>(
  [A, B].map((key) => [
    key,
    {
      environmentId: "m4" as never,
      projectId: key.split(":")[1]!,
      machineLabel: () => SCRIPTS[key]!.target,
      sourceLabel: "m4",
    },
  ]),
);
const status = (state: string, extra: Record<string, unknown> = {}) =>
  ({
    state,
    mode: "copy-only",
    rows: [],
    checks: [],
    unstable: [],
    error: null,
    ...extra,
  }) as never;

function useClock(): number {
  const [t, setT] = useState(0);
  useEffect(() => {
    const start = performance.now() + 600;
    const timer = window.setInterval(() => setT(Math.max(0, performance.now() - start)), 250);
    return () => window.clearInterval(timer);
  }, []);
  return t;
}

/** The sidebar row's line, with the same classes and overall fraction as the real row. */
function SidebarRow({ name, copyKey }: { readonly name: string; readonly copyKey: string }) {
  const [environmentId, id] = copyKey.split(":") as [string, string];
  const activity = useCopyActivity([{ environmentId, id }]);
  const fraction = activity ? overallFraction(activity) : null;
  return (
    <div className="relative flex h-8 items-center rounded-md px-3 text-sm text-sidebar-foreground">
      {name}
      {activity ? (
        <span className="sws-copy-progress" aria-hidden>
          <span
            className="sws-copy-progress-fill"
            style={fraction === null ? undefined : { width: `${Math.round(fraction * 100)}%` }}
          />
        </span>
      ) : null}
    </div>
  );
}

function Scene() {
  const t = useClock();
  const [ended, setEnded] = useState<ReadonlySet<string>>(new Set());
  const views = new Map([A, B].map((key) => [key, viewAt(SCRIPTS[key]!, t)]));
  useEffect(() => {
    const off = [A, B].map((key) => registerCopyOpener(key, () => {}));
    return () => off.forEach((stop) => stop());
  }, []);
  useEffect(() => {
    // The toast provider subscribes in its own effect, after this one: start on the first tick.
    if (t === 0) return;
    const live = new Map<string, CopyActivity>();
    for (const [key, view] of views) {
      if (ended.has(key)) continue;
      if (view.outcome === "running") {
        live.set(key, activityOf(key, view));
        setCopyActivity(key, activityOf(key, view));
        continue;
      }
      // Hold the finished or stopped bar for a beat, as the real watcher does, then announce.
      setCopyActivity(key, activityOf(key, view));
      setEnded((prev) => new Set(prev).add(key));
      window.setTimeout(() => {
        setCopyActivity(key, null);
        const target = SCRIPTS[key]!.target;
        announceCopy(
          "Open Move Project",
          view.outcome === "finished"
            ? status("applied")
            : status("failed", {
                error: {
                  code: "source_unreachable",
                  message: "m4 stopped answering over Connect for 2 minutes",
                },
              }),
          target,
          null,
          "m4",
          () => {},
        );
      }, 1_400);
    }
    syncCopyToasts(live, watches);
  });
  const panel = (key: string, title: string) => (
    <section className="rounded-xl border bg-popover p-5 shadow-sm" data-slot="motion-dialog">
      <h2 className="mb-3 text-sm font-medium">{title}</h2>
      <CopyProgressPanel
        view={views.get(key)!}
        sourceLabel="m4"
        targetLabel={SCRIPTS[key]!.target}
        startedAt={STARTED}
      />
    </section>
  );
  return (
    <div className="flex h-screen bg-background text-foreground">
      <aside className="w-60 shrink-0 bg-sidebar text-sidebar-foreground space-y-0.5 border-r p-3">
        <div className="px-3 pb-2 text-xs text-muted-foreground">Projects</div>
        <SidebarRow name="specweave" copyKey={A} />
        <SidebarRow name="vskill" copyKey={B} />
        <div className="relative flex h-8 items-center px-3 text-sm">easychamp</div>
      </aside>
      <main className="flex min-w-0 flex-1 flex-col">
        <FolderCopyBanner environmentId="m4" projectId="specweave" />
        <div className="grid flex-1 content-start gap-6 p-8 md:grid-cols-2">
          {panel(A, "Copy specweave to m5")}
          {panel(B, "Copy vskill to linux-box")}
        </div>
      </main>
    </div>
  );
}

const router = createRouter({
  routeTree: createRootRoute({
    component: () => (
      <ToastProvider>
        <Scene />
      </ToastProvider>
    ),
  }),
  history: createMemoryHistory(),
});

export function MotionScene() {
  return <RouterProvider router={router} />;
}
