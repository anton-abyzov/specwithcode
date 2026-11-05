// Run records written by scripts/release/run_record.py: synthetic ones (make-fixture.py), and with
// `?real=1` the 1.0.192 release's own record as M4 wrote it (fixture-release-1.0.192.json), decoded
// with the same contract schema the server endpoint answers with. The frame is the Releases page's:
// a sidebar's width beside it from md up, and the page's "wide" container.
import { ReleaseRun } from "@specweave-studio/contracts";
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
          />
        </WorkspacePageContainer>
      </main>
    </div>
  );
}

createRoot(document.getElementById("root")!).render(<Fixture />);
