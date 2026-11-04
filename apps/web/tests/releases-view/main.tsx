// Synthetic data only: run records written by scripts/release/run_record.py (make-fixture.py),
// decoded with the same contract schema the server endpoint answers with.
import { ReleaseRun } from "@specweave-studio/contracts";
import * as Schema from "effect/Schema";
import { useState } from "react";
import { createRoot } from "react-dom/client";

import { ReleasesView } from "../../src/components/releases/ReleasesView";
import { applyThemePalette } from "../../src/themePalette";
import fixture from "./fixture-runs.json";
import "./fixture.css";

const params = new URLSearchParams(location.search);
const dark = params.get("theme") === "dark";
document.documentElement.classList.toggle("dark", dark);
applyThemePalette("studio-chat", dark ? "dark" : "light");

const runs = Schema.decodeUnknownSync(Schema.Array(ReleaseRun))(fixture);
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
const NOW = Date.parse("2026-11-04T14:20:07Z");

function Fixture() {
  const [selected, setSelected] = useState<string | null>(params.get("run"));
  return (
    <main className="mx-auto max-w-6xl p-4 sm:p-6">
      <h1 className="mb-4 font-semibold text-lg">Releases</h1>
      <ReleasesView
        runs={shown}
        skipped={0}
        loading={false}
        failed={false}
        selectedRunId={selected}
        onSelectRun={setSelected}
        onRefresh={() => {}}
        nowMs={NOW}
      />
    </main>
  );
}

createRoot(document.getElementById("root")!).render(<Fixture />);
