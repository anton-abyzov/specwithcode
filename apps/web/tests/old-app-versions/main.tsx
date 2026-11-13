// Synthetic data only: Ministorm's numbers from November 13, 2026, no server.
import { EnvironmentId, type StorageHomeUsage } from "@specweave-studio/contracts";
import { createRoot } from "react-dom/client";

import { LowDiskSpaceNoticeCard } from "../../src/components/LowDiskSpaceBanner";
import { resolveLowDiskSpaceNotices } from "../../src/components/LowDiskSpaceBanner.logic";
import { homeUsageBreakdown } from "../../src/components/settings/StorageUsageBreakdown";
import { applyThemePalette } from "../../src/themePalette";
import "./fixture.css";

const dark = new URLSearchParams(location.search).get("theme") === "dark";
document.documentElement.classList.toggle("dark", dark);
applyThemePalette("studio-chat", dark ? "dark" : "light");

const MINISTORM = EnvironmentId.make("env-ministorm");
const usage = (parts: StorageHomeUsage["parts"]): StorageHomeUsage => ({
  level: "large",
  path: "/home/anton/.specwithcode",
  totalBytes: 82e9,
  warnAboveBytes: 50e9,
  parts,
  worktreeCount: 9,
  complete: true,
  checkedAt: "2026-11-13T15:00:00.000Z",
});
const cases = {
  before: {
    usage: usage([
      { key: "other", bytes: 66e9 },
      { key: "worktrees", bytes: 8.1e9 },
      { key: "scratch", bytes: 6.5e9 },
      { key: "logs", bytes: 0.4e9 },
    ]),
    canClean: false,
  },
  after: {
    usage: usage([
      { key: "app-versions", bytes: 48e9 },
      { key: "other", bytes: 18e9 },
      { key: "worktrees", bytes: 8.1e9 },
      { key: "scratch", bytes: 6.5e9 },
    ]),
    canClean: true,
  },
};

function Case({ id }: { id: keyof typeof cases }) {
  const { usage: homeUsage, canClean } = cases[id];
  const [notice] = resolveLowDiskSpaceNotices({
    statuses: [
      {
        environmentId: MINISTORM,
        os: "linux",
        storage: {
          level: "low",
          freeBytes: 4.7e9,
          totalBytes: 157e9,
          checkedAt: "2026-11-13T15:00:00.000Z",
          homeUsage,
        },
        canCleanOldAppVersions: canClean,
      },
    ],
    primaryEnvironmentId: MINISTORM,
    primaryIsThisMachine: true,
    labelFor: () => "Ministorm",
    dismissed: new Set(),
    appName: "SpecWithCode",
  });
  return (
    <section data-case={id} style={{ width: 480, padding: 16 }}>
      <h2 style={{ font: "600 13px system-ui", margin: "0 0 8px" }}>
        {id === "before" ? "Before" : "After"}
      </h2>
      <LowDiskSpaceNoticeCard
        notice={notice!}
        onDismiss={() => {}}
        onReviewStorage={() => {}}
        {...(canClean ? { onCleanOldAppVersions: () => {} } : {})}
      />
      <p data-storage-row="" style={{ font: "12px system-ui", marginTop: 12 }}>
        Settings &gt; Storage: {homeUsageBreakdown(homeUsage)}
      </p>
    </section>
  );
}

createRoot(document.getElementById("root")!).render(
  <div style={{ display: "flex", gap: 24, flexWrap: "wrap" }}>
    <Case id="before" />
    <Case id="after" />
  </div>,
);
