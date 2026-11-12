import { ReleaseRun, type ReleaseRunTiming } from "@specweave-studio/contracts";
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
import {
  formatPercent,
  formatSignedSeconds,
  installSpeedRows,
  phaseName,
  releaseSpeedRows,
  speedDelta,
} from "./releaseSpeedModel";

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

/** A run's timings as the server answers them; minutes per stage. */
const timing = (
  version: string,
  day: number,
  stages: Record<string, number | null>,
  state: ReleaseRunTiming["state"] = "done",
  runId = `run-${version}-${state}`,
): ReleaseRunTiming => {
  const values = Object.values(stages).filter((value): value is number => value !== null);
  return {
    runId,
    version,
    channel: "github",
    state,
    createdBy: "release.sh",
    startedAt: `2026-11-${String(day).padStart(2, "0")}T09:00:00Z`,
    endedAt: state === "running" ? null : `2026-11-${String(day).padStart(2, "0")}T10:00:00Z`,
    totalSeconds: values.length > 0 ? values.reduce((sum, value) => sum + value, 0) * 60 : null,
    stages: Object.entries(stages).map(([id, minutes]) => ({
      id,
      state: minutes === null ? ("pending" as const) : ("passed" as const),
      seconds: minutes === null ? null : minutes * 60,
    })),
  };
};

const history = [
  timing("1.0.199", 12, { resolve: 1, "test.server": 4 }, "running"),
  timing("1.0.198", 11, { resolve: 1, "test.server": 20, "build.mac": 10 }, "failed", "late-fail"),
  timing("1.0.198", 10, { resolve: 1, "test.server": 20, "build.mac": 10 }),
  timing("1.0.197", 9, { resolve: 1, "test.server": 15, "build.mac": 14, canary: null }),
  timing("1.0.196", 8, { resolve: 1, "test.server": 15, "build.mac": 14 }),
  timing("1.0.195", 7, { resolve: 1, "test.server": 15, "build.mac": 14 }),
  timing("1.0.194", 6, { resolve: 1, "test.server": 15, "build.mac": 14 }),
  timing("1.0.193", 5, { resolve: 1, "test.server": 15, "build.mac": 14 }),
];

describe("speed by version", () => {
  it("marks a change slower or faster only past 25% and 10 seconds", () => {
    expect(speedDelta(130, 100)).toEqual({ seconds: 30, percent: 30, verdict: "slower" });
    expect(speedDelta(120, 100).verdict).toBe("same");
    expect(speedDelta(3, 2).verdict).toBe("same");
    expect(speedDelta(12, 2).verdict).toBe("slower");
    expect(speedDelta(60, 100).verdict).toBe("faster");
    expect(speedDelta(10, 0)).toEqual({ seconds: 10, percent: null, verdict: "slower" });
    expect(formatSignedSeconds(65)).toBe("+1m 05s");
    expect(formatSignedSeconds(-12)).toBe("−12s");
    expect(formatSignedSeconds(0)).toBe("±0s");
    expect(formatPercent(-40.4)).toBe("−40%");
    expect(formatPercent(null)).toBeNull();
  });

  it("lists one row per version, each against the released version before it", () => {
    const rows = releaseSpeedRows(history);
    expect(rows.map((row) => row.version)).toEqual([
      "1.0.199",
      "1.0.198",
      "1.0.197",
      "1.0.196",
      "1.0.195",
      "1.0.194",
    ]);
    const [running, newest, older] = rows;
    // A run still going is not compared as a whole, and a version's released run wins over a
    // later failed one.
    expect(running!.delta).toBeNull();
    expect(running!.previousVersion).toBe("1.0.198");
    expect(newest!.key).toBe("run-1.0.198-done");
    expect(newest!.totalSeconds).toBe(31 * 60);
    expect(newest!.delta).toMatchObject({ seconds: 60, verdict: "same" });
    expect(newest!.slowest).toMatchObject({ id: "test.server", name: "Server tests" });
    expect(newest!.slower.map((part) => [part.id, part.delta?.seconds])).toEqual([
      ["test.server", 300],
    ]);
    expect(newest!.faster.map((part) => [part.id, part.delta?.seconds])).toEqual([
      ["build.mac", -240],
    ]);
    // A stage that never ran has no time and no row.
    expect(older!.parts.map((part) => part.id)).toEqual(["resolve", "test.server", "build.mac"]);
    expect(rows.at(-1)!.previousVersion).toBe("1.0.193");
    expect(releaseSpeedRows([history.at(-1)!])[0]!.delta).toBeNull();
  });

  it("compares a run only with a released run on the same channel, started the same way", () => {
    const candidate = {
      ...timing("1.0.198", 11, { resolve: 1, "test.server": 40 }),
      channel: "candidate",
      runId: "candidate-198",
    };
    const ci = {
      ...timing("1.0.197", 10, { resolve: 1, "test.server": 5 }),
      createdBy: "release.yml",
      runId: "ci-197",
    };
    const rows = releaseSpeedRows([
      timing("1.0.199", 12, { resolve: 1, "test.server": 20 }),
      candidate,
      ci,
      timing("1.0.196", 9, { resolve: 1, "test.server": 16 }),
    ]);
    expect(rows.map((row) => [row.version, row.previousVersion])).toEqual([
      ["1.0.199", "1.0.196"],
      ["1.0.198", null],
      ["1.0.197", null],
      ["1.0.196", null],
    ]);
    expect(rows[0]!.delta).toMatchObject({ seconds: 4 * 60, verdict: "same" });
    expect(rows[1]!.delta).toBeNull();
  });

  it("tells stage time from the wall clock a run took", () => {
    const [done, running] = [
      releaseSpeedRows([history[2]!])[0]!,
      releaseSpeedRows([history[0]!])[0]!,
    ];
    expect([done.totalSeconds, done.wallSeconds]).toEqual([31 * 60, 60 * 60]);
    expect(running.wallSeconds).toBeNull();
    const html = render({ timings: [history[2]!], installs: [] });
    expect(html).toContain("Stage time");
    expect(html).toContain("wall clock 1h 00m");
  });

  it("compares installs on this machine by version and phase", () => {
    const rows = installSpeedRows([
      {
        version: "1.0.197",
        installedAt: "2026-11-09T12:00:00.000Z",
        totalMs: 22_000,
        phases: { readiness: 6000, serviceStop: 3000 },
      },
      {
        version: "1.0.198",
        installedAt: "2026-11-10T12:00:00.000Z",
        totalMs: 151_000,
        phases: { readiness: 136_000, serviceStop: 3000 },
      },
      { version: "1.0.198", installedAt: "2026-11-10T11:00:00.000Z", totalMs: 9_000 },
    ]);
    expect(rows.map((row) => [row.version, row.totalSeconds])).toEqual([
      ["1.0.198", 151],
      ["1.0.197", 22],
    ]);
    expect(rows[0]!.delta).toMatchObject({ seconds: 129, verdict: "slower" });
    expect(rows[0]!.slowest).toMatchObject({ id: "readiness", name: "Readiness", seconds: 136 });
    expect(rows[0]!.slower.map((part) => part.id)).toEqual(["readiness"]);
    expect(rows[1]!.delta).toBeNull();
    expect(phaseName("serviceStop")).toBe("Service stop");
  });

  it("shows the section with marked regressions, and derives it from older servers' runs", () => {
    const html = render({
      timings: history,
      installs: [{ version: "1.0.198", installedAt: "2026-11-10T12:00:00.000Z", totalMs: 21_000 }],
    });
    expect(html).toContain("Speed by version");
    expect(html).toContain('data-speed-version="1.0.198"');
    expect(html).toContain('data-speed-part="test.server" data-verdict="slower"');
    expect(html).toContain('data-speed-part="build.mac" data-verdict="faster"');
    expect(html).toContain("vs 1.0.197");
    expect(html).toContain("Slower: Server tests +5m 00s");
    expect(html).toContain("Install on this machine");
    expect(html).toContain("21s");
    // No timings from the server: the two fixture runs give the rows, and installs are unknown.
    const derived = render();
    expect(derived).toContain('data-speed-version="1.0.190"');
    expect(derived).toContain('data-speed-version="1.0.189"');
    expect(derived).toContain("does not report install times yet");
  });

  it("says so when there are no timings, and stays out of the way of a failed read", () => {
    const empty = render({ runs: [], timings: [], installs: [] });
    expect(empty).toContain("data-speed-empty");
    expect(empty).toContain("No timings on this machine yet.");
    expect(render({ runs: [], loading: true })).not.toContain("data-release-speed");
    expect(render({ runs: [], failed: true })).not.toContain("data-release-speed");
  });
});
