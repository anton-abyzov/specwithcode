import { useEffect } from "react";
import {
  RouterProvider,
  createMemoryHistory,
  createRootRoute,
  createRouter,
} from "@tanstack/react-router";
import { announceCopy } from "../../src/components/studio/HandoffFolderCopyWatcher";
import { syncCopyToasts } from "../../src/components/studio/folderCopyToasts";
import { ToastProvider } from "../../src/components/ui/toast";
import type { CopyActivity, CopyWatch } from "../../src/studio/folderCopyActivity";

// `?toasts=1`: the top-right copy notifications from the real toast stack: a copy running
// in the background (40 MB a second, so time left appears after a few seconds), one that
// finished and one that failed.
const GB = 1_000_000_000;
const TOTAL = 7.5 * GB;
const FILES = 121_868;
const watch: CopyWatch = {
  environmentId: "m4" as never,
  projectId: "specweave",
  machineLabel: () => "m5",
  sourceLabel: "m4",
};
const sending = (sent: number): CopyActivity => ({
  machine: "m5",
  label: "Copying files",
  fraction: sent / TOTAL,
  waiting: false,
  source: "m4",
  progress: {
    phase: "send",
    step: "Sending files to m5",
    fraction: sent / TOTAL,
    bytes: { done: sent, total: TOTAL },
    files: { done: Math.round((sent / TOTAL) * FILES), total: FILES },
    bytesLocal: 0,
    rateKey: "send:files",
    outcome: "running",
  },
});
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

function Toasts() {
  useEffect(() => {
    // The provider subscribes in its own effect, after this child's: add on the next tick.
    let timer = 0;
    const start = window.setTimeout(() => {
      const open = () => {};
      announceCopy("Open Move Project", status("applied"), "m1", null, "m4", open);
      announceCopy(
        "Open Move Project",
        status("failed", {
          error: {
            code: "source_unreachable",
            message: "m4 stopped answering over Connect for 2 minutes",
          },
        }),
        "linux-box",
        null,
        "m4",
        open,
      );
      let sent = 2.1 * GB;
      const watches = new Map([["m4:specweave", watch]]);
      syncCopyToasts(new Map([["m4:specweave", sending(sent)]]), watches);
      timer = window.setInterval(() => {
        sent += 80_000_000;
        syncCopyToasts(new Map([["m4:specweave", sending(sent)]]), watches);
      }, 2_000);
    }, 100);
    return () => {
      window.clearTimeout(start);
      window.clearInterval(timer);
    };
  }, []);
  return <main className="min-h-screen bg-background text-foreground" />;
}

const router = createRouter({
  routeTree: createRootRoute({
    component: () => (
      <ToastProvider>
        <Toasts />
      </ToastProvider>
    ),
  }),
  history: createMemoryHistory(),
});

export function ToastGallery() {
  return <RouterProvider router={router} />;
}
