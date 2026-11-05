import { ReleaseRun } from "@specweave-studio/contracts";
import * as Schema from "effect/Schema";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vite-plus/test";

// Written by scripts/release/run_record.py (apps/web/tests/releases-view/make-fixture.py).
import fixture from "../../../tests/releases-view/fixture-runs.json";
// The 1.0.192 release's own record, as M4 wrote it (github channel, resumed once).
import realFixture from "../../../tests/releases-view/fixture-release-1.0.192.json";
import {
  formatSeconds,
  hostSummary,
  hostVersion,
  releaseGraphColumns,
  releaseHostGroups,
  selectedRun,
  stageCounts,
  stageDuration,
  stageName,
  stageViewState,
} from "./releaseRunModel";
import { ReleasesView } from "./ReleasesView";

const runs = Schema.decodeUnknownSync(Schema.Array(ReleaseRun))(fixture);
const [held, done] = runs as [ReleaseRun, ReleaseRun];
const NOW = Date.parse("2026-11-04T14:30:00Z");
const real = Schema.decodeUnknownSync(ReleaseRun)(realFixture);
const realStage = (id: string) => real.stages.find((stage) => stage.id === id)!;

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
    // Its steps ran 1m + 8m + 2m; the 4 minutes of publishing between them are not the canary's.
    expect(stageDuration(canary, NOW)).toBe("11m 00s");
    // A stage with no step times reads its own.
    const bare = { ...canary, steps: [] };
    expect(stageDuration(bare, NOW)).toBe("15m 00s");
    const running = { ...bare, state: "running" as const, endedAt: null };
    expect(stageDuration(running, Date.parse(canary.startedAt!) + 90_000)).toBe("1m 30s");
    expect(stageDuration({ ...bare, startedAt: null }, NOW)).toBeNull();
    // Between two steps a running stage keeps counting; a step with no end ran until the stage ended.
    const [first, second] = canary.steps;
    const firstEnd = Date.parse(first!.endedAt!);
    const between = {
      ...canary,
      state: "running" as const,
      endedAt: null,
      steps: [first!, { ...second!, state: "pending" as const, startedAt: null, endedAt: null }],
    };
    const firstSeconds = (firstEnd - Date.parse(first!.startedAt!)) / 1000;
    expect(stageDuration(between, firstEnd + 30_000)).toBe(formatSeconds(firstSeconds + 30));
    const killed = { ...canary, steps: [{ ...first!, state: "failed" as const, endedAt: null }] };
    expect(stageDuration(killed, NOW)).toBe(
      formatSeconds((Date.parse(canary.endedAt!) - Date.parse(first!.startedAt!)) / 1000),
    );
    // A step left "running" by a killed release stops at its finished stage's end.
    const stale = { ...canary, steps: [{ ...first!, state: "running" as const, endedAt: null }] };
    expect(stageDuration(stale, NOW + 3_600_000)).toBe(stageDuration(killed, NOW));
    expect(selectedRun(runs, done.runId)).toBe(done);
    expect(selectedRun(runs, "gone")).toBe(held);
    expect(selectedRun([], null)).toBeNull();
  });
});

describe("the 1.0.192 release record", () => {
  it("times a stage by its steps, not across the resume that reran one of them", () => {
    // trees reran on the resume, 27 minutes after prev, bump and candidate: 2s + 9s + 5s + 1s.
    expect(stageDuration(realStage("resolve"), NOW)).toBe("17s");
    // Canary's steps sit on both sides of the publish: quit-desktop 1s, fleet-m4 60s, desktop 6s.
    expect(stageDuration(realStage("canary"), NOW)).toBe("1m 07s");
    expect(stageDuration(realStage("test.server"), NOW)).toBe("15m 24s");
    const running = {
      ...realStage("test.unit"),
      state: "running" as const,
      steps: [{ ...realStage("test.unit").steps[0]!, state: "running" as const, endedAt: null }],
    };
    expect(stageDuration(running, Date.parse("2026-11-04T23:44:15Z"))).toBe("1m 00s");
  });

  it("shows the stages this run has no step for as not in it, and counts none as waiting", () => {
    const absent = real.stages.filter((stage) => stageViewState(stage, real) === "absent");
    expect(absent.map((stage) => stage.id)).toEqual([
      "test.web",
      "test.fleet",
      "test.desktop-e2e",
      "build.windows",
      "build.linux",
      "verify.windows",
      "verify.linux",
      "verify.release",
    ]);
    expect(stageCounts(real)).toEqual({
      passed: 11,
      running: 0,
      failed: 0,
      pending: 0,
      skipped: 0,
      absent: 8,
    });
    // While the run is not done release verification still waits; a release.yml run's stages too.
    const live = { ...real, state: "running" as const, endedAt: null };
    expect(stageViewState(realStage("verify.release"), live)).toBe("pending");
    expect(stageViewState(realStage("test.web"), live)).toBe("absent");
    expect(stageViewState(realStage("test.web"), { ...live, createdBy: "release.yml" })).toBe(
      "pending",
    );
    const html = render({ runs: [real] });
    expect(html).toContain("11 passed, 0 running, 0 failed, 0 waiting, 8 not in this run.");
    expect(html).toContain('data-stage="test.web" data-state="absent"');
    expect(html).toContain("Not in this run");
    expect(html).toContain("17s");
    expect(html).not.toContain("27m 44s");
  });

  it("names the github channel's publish and canary stages for what they do", () => {
    expect(stageName("publish.candidate", "github")).toBe("Publish");
    expect(stageName("canary", "github")).toBe("M4 rollout");
    expect(stageName("canary", "candidate")).toBe("Canary");
    expect(releaseGraphColumns(real.stages, real.channel).map((column) => column.label)).toContain(
      "M4 rollout",
    );
    const html = render({ runs: [real] });
    expect(html).toContain('data-stage="publish.candidate"');
    expect(html).toContain('data-stage="canary"');
    expect(html).not.toContain("Publish candidate");
    expect(html).toContain("M4 rollout");
  });

  it("lays the graph out by its own width, wrapping columns instead of a fixed-width row", () => {
    const html = render({ runs: [real] });
    const graph = /<div class="([^"]*)" data-release-graph/.exec(html)?.[1] ?? "";
    expect(graph.split(" ")).toEqual(expect.arrayContaining(["@container", "min-w-0"]));
    expect(html).toContain("grid-cols-[repeat(auto-fit,minmax(6rem,1fr))]");
    expect(html).not.toContain("--release-columns");
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
      ["test.web", "absent"],
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
    // A machine left behind shows the version it stayed on, not the release's target.
    expect(html).not.toContain("1.0.187 → 1.0.190");
    const anna = held.hosts.find((host) => host.identity === "annas-macbook-air")!;
    expect(hostVersion(anna)).toBe("1.0.187");
    expect(hostVersion({ ...anna, from: null })).toBe("—");
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
