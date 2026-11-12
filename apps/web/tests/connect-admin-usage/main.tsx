import type { RelayAdminUsageResponse } from "@specweave-studio/contracts/relayAdmin";
import { createRoot } from "react-dom/client";

import type { PublicDownloads } from "../../src/cloud/publicDownloads";
import { ConnectAdminUsageView } from "../../src/components/settings/ConnectAdminUsage";
import "./fixture.css";

// The Usage section of Settings > Connect admin in every state, with the real view.
// Open it with ?state=ready|no-clerk|partial|loading|failed|no-downloads&theme=light|dark.
const params = new URLSearchParams(location.search);
document.documentElement.classList.toggle("dark", params.get("theme") === "dark");
const state = params.get("state") ?? "ready";

const weeks = (counts: ReadonlyArray<number>) =>
  counts.map((count, index) => ({
    weekStart: new Date(Date.UTC(2026, 7, 24 + index * 7)).toISOString(),
    count,
  }));

const USAGE: RelayAdminUsageResponse = {
  generatedAt: "2026-11-11T12:00:00.000Z",
  signUps: {
    total: 1083,
    created: { day: 2, week: 9, month: 31 },
    active: { day: 12, week: 40, month: 61 },
    weekly: weeks([0, 1, 0, 2, 3, 12, 5, 6, 7, 118, 9, 4]),
    complete: state !== "partial",
  },
  connect: {
    created: { day: 1, week: 4, month: 14 },
    active: { day: 6, week: 15, month: 19 },
    machinesLinked: { day: 3, week: 8, month: 27 },
    weekly: weeks([0, 0, 0, 0, 0, 1, 2, 2, 3, 4, 2, 1]),
  },
};

const DOWNLOADS: PublicDownloads = {
  installers: {
    mac: 2915,
    windows: 1330,
    linux: 1382,
    releases: 162,
    complete: state !== "partial",
  },
  npm: [
    { name: "specweave", week: 3900, month: 16078 },
    { name: "vskill", week: 510, month: 2156 },
  ],
};

createRoot(document.getElementById("root")!).render(
  <div className="min-h-screen bg-background p-4 sm:p-8">
    <main className="mx-auto max-w-[44rem]">
      <ConnectAdminUsageView
        usage={
          state === "loading"
            ? { status: "loading" }
            : state === "failed"
              ? {
                  status: "failed",
                  failure: { kind: "unavailable", status: 503, traceId: "trace-1" },
                }
              : {
                  status: "ready",
                  value: state === "no-clerk" ? { ...USAGE, signUps: null } : USAGE,
                }
        }
        downloads={
          state === "loading"
            ? null
            : state === "no-downloads"
              ? { installers: null, npm: null }
              : DOWNLOADS
        }
        locale="en"
        onRetry={() => {}}
      />
    </main>
  </div>,
);
