// Run records written by scripts/release/run_record.py: synthetic ones (make-fixture.py), and with
// `?real=1` the 1.0.192 release's own record as M4 wrote it (fixture-release-1.0.192.json), decoded
// with the same contract schema the server endpoint answers with. The frame is the Releases page's:
// a sidebar's width beside it from md up, and the page's "wide" container.
import {
  ReleaseRun,
  type ReleaseInstallTiming,
  type ReleaseRunTiming,
} from "@specweave-studio/contracts";
import * as Schema from "effect/Schema";
import { useState } from "react";
import { createRoot } from "react-dom/client";

import { ReleasesView } from "../../src/components/releases/ReleasesView";
import { WorkspacePageContainer } from "../../src/components/WorkspacePageContainer";
import { applyThemePalette } from "../../src/themePalette";
import real from "./fixture-release-1.0.192.json";
import fixture from "./fixture-runs.json";
import "./fixture.css";

const params = new URLSearchParams(location.search);
const dark = params.get("theme") === "dark";
document.documentElement.classList.toggle("dark", dark);
applyThemePalette("studio-chat", dark ? "dark" : "light");

const runs = Schema.decodeUnknownSync(Schema.Array(ReleaseRun))(
  params.get("real") === "1" ? [real] : fixture,
);
// `?live=1`: the same run while its fleet stage still runs, as the view shows it mid-release.
const shown =
  params.get("live") === "1"
    ? runs.map((run, index) =>
        index > 0
          ? run
          : {
              ...run,
              state: "running" as const,
              endedAt: null,
              stages: run.stages.map((stage) =>
                stage.id === "fleet"
                  ? { ...stage, state: "running" as const, endedAt: null }
                  : stage,
              ),
              hosts: run.hosts.map((host) =>
                host.identity === "m3" ? { ...host, state: "acked" as const, reason: null } : host,
              ),
            },
      )
    : runs;
const NOW = Date.parse(
  params.get("real") === "1" ? "2026-11-05T00:20:00Z" : "2026-11-04T14:20:07Z",
);

// `?speed=1`: Speed by version over six synthetic versions and their installs here;
// `?speed=empty`: a machine with no release or install timings yet.
const STAGE_MINUTES: Record<string, ReadonlyArray<number | null>> = {
  resolve: [0.3, 0.3, 0.4, 0.3, 0.3, 0.3, 0.3],
  preflight: [1.2, 1.1, 1.2, 1.1, 1.2, 1.1, 1.0],
  "test.unit": [3.1, 3.0, 2.9, 3.2, 3.0, 3.1, 3.0],
  "test.server": [21.5, 15.4, 15.2, 14.9, 15.6, 15.0, 15.1],
  "build.mac": [6.2, 9.8, 9.6, 9.9, 10.1, 9.7, 9.9],
  "verify.mac": [2.0, 2.1, 2.0, 1.9, 2.2, 2.0, 2.1],
  "publish.candidate": [1.4, 1.3, 1.5, 1.4, 1.3, 1.4, 1.4],
  canary: [1.1, 1.2, 3.9, 1.2, 1.1, 1.3, 1.2],
  fleet: [null, 6.5, 6.1, 7.0, 6.4, 6.6, 6.3],
  finalize: [null, 0.5, 0.5, 0.5, 0.4, 0.5, 0.5],
};
const speedTimings: ReadonlyArray<ReleaseRunTiming> = Array.from({ length: 7 }, (_, index) => {
  const version = `1.0.${196 - index}`;
  const day = String(12 - index).padStart(2, "0");
  const state = index === 0 ? ("held" as const) : ("done" as const);
  const stages = Object.entries(STAGE_MINUTES).map(([id, minutes]) => ({
    id,
    state: minutes[index] === null ? ("pending" as const) : ("passed" as const),
    seconds: minutes[index] === null ? null : Math.round(minutes[index]! * 60),
  }));
  return {
    runId: `run-${version}`,
    version,
    channel: "github",
    state,
    createdBy: "release.sh",
    startedAt: `2026-11-${day}T14:00:00Z`,
    endedAt: `2026-11-${day}T15:00:00Z`,
    totalSeconds: stages.reduce((sum, stage) => sum + (stage.seconds ?? 0), 0),
    stages,
  };
});
const INSTALL_SECONDS = [151, 21, 22, 24, 21];
const speedInstalls: ReadonlyArray<ReleaseInstallTiming> = INSTALL_SECONDS.map((total, index) => ({
  version: `1.0.${195 - index}`,
  installedAt: `2026-11-${String(11 - index).padStart(2, "0")}T15:30:00.000Z`,
  totalMs: total * 1000,
  phases: {
    beforeRead: 1000,
    verifyAndStage: 1500,
    serviceStop: 3000,
    backupClone: 2500,
    readinessCheap: 5000,
    readiness: (total - 13) * 1000,
  },
}));
const speed = params.get("speed");

function Fixture() {
  const [selected, setSelected] = useState<string | null>(params.get("run"));
  return (
    <div className="flex min-h-dvh">
      <aside className="hidden w-64 shrink-0 border-border border-r md:block" />
      <main className="min-w-0 flex-1">
        <WorkspacePageContainer width="wide">
          <h1 className="font-semibold text-lg">Releases</h1>
          <ReleasesView
            runs={shown}
            skipped={0}
            loading={false}
            failed={false}
            selectedRunId={selected}
            onSelectRun={setSelected}
            onRefresh={() => {}}
            nowMs={NOW}
            {...(speed === "1"
              ? { timings: speedTimings, installs: speedInstalls }
              : speed === "empty"
                ? { runs: [], timings: [], installs: [] }
                : {})}
          />
        </WorkspacePageContainer>
      </main>
    </div>
  );
}

createRoot(document.getElementById("root")!).render(<Fixture />);
