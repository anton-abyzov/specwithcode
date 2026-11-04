import { ReleaseRun } from "@specweave-studio/contracts";
import * as Schema from "effect/Schema";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vite-plus/test";

// Written by scripts/release/run_record.py (apps/web/tests/releases-view/make-fixture.py).
import fixture from "../../../tests/releases-view/fixture-runs.json";
import {
  formatSeconds,
  hostSummary,
  releaseGraphColumns,
  releaseHostGroups,
  selectedRun,
  stageDuration,
} from "./releaseRunModel";
import { ReleasesView } from "./ReleasesView";

const runs = Schema.decodeUnknownSync(Schema.Array(ReleaseRun))(fixture);
const [held, done] = runs as [ReleaseRun, ReleaseRun];
const NOW = Date.parse("2026-11-04T14:30:00Z");

const render = (props: Partial<Parameters<typeof ReleasesView>[0]> = {}) =>
  renderToStaticMarkup(
    <ReleasesView
      runs={runs}
      skipped={0}
      loading={false}
      failed={false}
      selectedRunId={null}
      onSelectRun={() => {}}
      nowMs={NOW}
      {...props}
    />,
  );

describe("release graph model", () => {
  it("lays the stages out in columns by what they need", () => {
    const columns = releaseGraphColumns(held.stages);
    expect(columns.map((column) => column.stages.map((stage) => stage.id))).toEqual([
      ["resolve"],
      ["preflight", "test.unit", "test.server", "test.web", "test.fleet", "test.desktop-e2e"],
      ["test.migration", "build.mac", "build.windows", "build.linux"],
      ["verify.mac", "verify.windows", "verify.linux"],
      ["publish.candidate"],
      ["canary"],
      ["fleet"],
      ["finalize"],
      ["verify.release"],
    ]);
    expect(columns.map((column) => column.label)).toEqual([
      "Resolve",
      "Preflight · Tests",
      "Tests · Build",
      "Verify",
      "Publish",
      "Canary",
      "Fleet",
      "Finalize",
      "Released",
    ]);
  });

  it("survives a need the record does not hold, and a cycle", () => {
    const stage = held.stages[0]!;
    const columns = releaseGraphColumns([
      { ...stage, id: "a", needs: ["b", "missing"] },
      { ...stage, id: "b", needs: ["a"] },
    ]);
    expect(columns.flatMap((column) => column.stages.map((entry) => entry.id)).sort()).toEqual([
      "a",
      "b",
    ]);
  });

  it("groups machines by role, required first, and sums them up", () => {
    const groups = releaseHostGroups(held.hosts);
    expect(groups.map((group) => [group.label, group.hosts.map((host) => host.identity)])).toEqual([
      ["Canary", ["m4"]],
      ["Fleet", ["m1", "m3", "annas-macbook-air"]],
    ]);
    expect(hostSummary(held.hosts)).toBe("2 of 3 required machines verified, 2 not updated");
    expect(hostSummary(done.hosts)).toBe("3 of 3 required machines verified");
    expect(hostSummary([])).toBeNull();
  });

  it("times stages, a running one up to now", () => {
    expect(formatSeconds(65)).toBe("1m 05s");
    expect(formatSeconds(3720)).toBe("1h 02m");
    const canary = held.stages.find((stage) => stage.id === "canary")!;
    expect(stageDuration(canary, NOW)).toBe("15m 00s");
    const running = { ...canary, state: "running" as const, endedAt: null };
    expect(stageDuration(running, Date.parse(canary.startedAt!) + 90_000)).toBe("1m 30s");
    expect(stageDuration({ ...canary, startedAt: null }, NOW)).toBeNull();
    expect(selectedRun(runs, done.runId)).toBe(done);
    expect(selectedRun(runs, "gone")).toBe(held);
    expect(selectedRun([], null)).toBeNull();
  });
});

describe("ReleasesView", () => {
  it("shows the newest run's stage graph with each stage's state", () => {
    const html = render();
    expect(html).toContain("SpecWithCode 1.0.190");
    expect(html).toContain("Held");
    for (const [stage, state] of [
      ["canary", "passed"],
      ["fleet", "failed"],
      ["test.server", "passed"],
      ["test.web", "pending"],
    ]) {
      expect(html).toContain(`data-stage="${stage}" data-state="${state}"`);
    }
    expect(html).toContain('aria-label="8 of 8 shards passed"');
    expect(html).toContain("Migration rehearsal");
  });

  it("lists canary and fleet machines with their steps and reasons", () => {
    const html = render();
    expect(html).toContain('data-host-group="canary"');
    expect(html).toContain('data-host-group="fleet"');
    expect(html).toContain('data-host="m3" data-state="not-updated"');
    expect(html).toContain("busy: 3 windows elapsed (claude, node)");
    expect(html).toContain('data-host="annas-macbook-air" data-state="not-updated"');
    expect(html).toContain("no SSH and no Connect address");
    expect(html).toContain('data-host="m4" data-state="verified"');
    expect(html).toContain("1.0.189 → 1.0.190");
    expect(html).toContain("2 of 3 required machines verified, 2 not updated");
  });

  it("shows the run picked in the list", () => {
    const html = render({ selectedRunId: done.runId });
    expect(html).toContain("SpecWithCode 1.0.189");
    expect(html).toContain("Released");
    expect(html).toContain("3 of 3 required machines verified");
  });

  it("says when there is nothing yet, when it cannot read, and what it skipped", () => {
    expect(render({ runs: [] })).toContain("No release has run on this machine yet.");
    expect(render({ runs: [], loading: true })).toContain("Reading release runs");
    expect(render({ failed: true })).toContain("Could not read the release runs");
    expect(render({ skipped: 2 })).toContain("2 files in the runs folder could not be read");
  });
});
