// Synthetic data only: Ministorm's disks on November 13, 2026, no server.
import { EnvironmentId, type StorageStatus } from "@specweave-studio/contracts";
import { createRoot } from "react-dom/client";

import { LowDiskSpaceNoticeCard } from "../../src/components/LowDiskSpaceBanner";
import { resolveLowDiskSpaceNotices } from "../../src/components/LowDiskSpaceBanner.logic";
import { roomierVolumeMoveSteps } from "../../src/components/settings/StorageUsageBreakdown";
import { applyThemePalette } from "../../src/themePalette";
import "./fixture.css";

const dark = new URLSearchParams(location.search).get("theme") === "dark";
document.documentElement.classList.toggle("dark", dark);
applyThemePalette("studio-chat", dark ? "dark" : "light");

const MINISTORM = EnvironmentId.make("env-ministorm");
const low: StorageStatus = {
  level: "low",
  freeBytes: 4.4e9,
  totalBytes: 157e9,
  checkedAt: "2026-11-13T15:00:00.000Z",
};
const cases = {
  before: low,
  after: {
    ...low,
    roomierVolume: { path: "/srv", freeBytes: 1.4e12, fileSystem: "xfs", clones: true },
  } satisfies StorageStatus,
};

function Case({ id }: { id: keyof typeof cases }) {
  const [notice] = resolveLowDiskSpaceNotices({
    statuses: [{ environmentId: MINISTORM, os: "linux", storage: cases[id] }],
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
      <LowDiskSpaceNoticeCard notice={notice!} onDismiss={() => {}} onReviewStorage={() => {}} />
      {id === "after" && (
        <pre
          style={{ font: "11px ui-monospace, monospace", whiteSpace: "pre-wrap", marginTop: 12 }}
        >
          {`Settings > Storage, "Ministorm: /srv has 1400 GB free":\n`}
          {roomierVolumeMoveSteps({ homePath: "/home/anton/.specwithcode", volumePath: "/srv" })}
        </pre>
      )}
    </section>
  );
}

createRoot(document.getElementById("root")!).render(
  <div style={{ display: "flex", gap: 24, flexWrap: "wrap" }}>
    <Case id="before" />
    <Case id="after" />
  </div>,
);
