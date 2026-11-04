// @effect-diagnostics nodeBuiltinImport:off - Reads the workflow files as text and the graph from run_record.py.
import * as NodeChildProcess from "node:child_process";
import * as NodeFS from "node:fs";
import { describe, expect, it } from "vite-plus/test";
import { parse } from "yaml";

const read = (name: string) =>
  parse(NodeFS.readFileSync(new URL(`../.github/workflows/${name}`, import.meta.url), "utf8"), {
    uniqueKeys: true,
  }) as Record<string, unknown>;

interface StageJob {
  readonly needs?: string | ReadonlyArray<string>;
  readonly uses?: string;
  readonly secrets?: string;
  readonly strategy?: { readonly "fail-fast"?: boolean; readonly matrix?: { shard?: unknown } };
  readonly with?: Record<string, string | boolean>;
}

const workflow = read("release.yml") as {
  on: { workflow_dispatch: { inputs: Record<string, unknown> } };
  concurrency: { group: string };
  jobs: Record<string, StageJob>;
};
interface StageStep {
  readonly name?: string;
  readonly if?: string;
  readonly run?: string;
  readonly env?: Record<string, string>;
  readonly with?: Record<string, string>;
}
const stageWorkflow = read("release-stage.yml") as {
  on: { workflow_call: { inputs: Record<string, { required?: boolean }> } };
  env: Record<string, string>;
  jobs: {
    stage: { "runs-on": string; env: Record<string, string>; steps: ReadonlyArray<StageStep> };
  };
};
const macos = read("release-macos.yml") as { jobs: Record<string, { "runs-on"?: string }> };

/** The release graph as run_record.py (the run record and release.sh --stage) defines it. */
const graph = JSON.parse(
  NodeChildProcess.execFileSync(
    "python3",
    ["-B", new URL("./release/run_record.py", import.meta.url).pathname, "graph"],
    { encoding: "utf8" },
  ),
) as ReadonlyArray<[string, ReadonlyArray<string>]>;

const jobId = (stage: string) => stage.replaceAll(".", "_").replaceAll("-", "_");
const needsOf = (job: StageJob) =>
  [job.needs ?? []].flat().toSorted((left, right) => left.localeCompare(right));

describe("release.yml", () => {
  it("has one job per graph stage, plus the server suite's merge", () => {
    expect(Object.keys(workflow.jobs).toSorted()).toEqual(
      [...graph.map(([stage]) => jobId(stage)), "test_server_merge"].toSorted(),
    );
  });

  it("expresses the graph's needs, with the server suite done once its merge passed", () => {
    for (const [stage, needs] of graph) {
      const expected = needs
        .map((need) => (need === "test.server" ? "test_server_merge" : jobId(need)))
        .toSorted((left, right) => left.localeCompare(right));
      expect([stage, needsOf(workflow.jobs[jobId(stage)]!)]).toEqual([stage, expected]);
    }
    expect(needsOf(workflow.jobs.test_server_merge!)).toEqual(["test_server"]);
  });

  it("runs every job as release.sh --stage <id> --resume through release-stage.yml", () => {
    for (const [name, job] of Object.entries(workflow.jobs)) {
      expect([name, job.uses, job.secrets]).toEqual([
        name,
        "./.github/workflows/release-stage.yml",
        "inherit",
      ]);
      expect(jobId(String(job.with?.stage))).toBe(
        name === "test_server_merge" ? "test_server" : name,
      );
      expect(job.with?.version).toBe("${{ inputs.version }}");
    }
    const run = stageWorkflow.jobs.stage.steps.map((step) => step.run ?? "").join("\n");
    expect(run).toContain('args=("$RELEASE_VERSION" --stage "$RELEASE_STAGE" --resume)');
    expect(run).toContain('args+=(--shard "$RELEASE_SHARD")');
    expect(run).toContain('bash scripts/release/release.sh "${args[@]}"');
    // Every job runs the dispatched commit, never a branch tip that moved during the run.
    expect(run).toContain('checkout -q --detach "$GITHUB_SHA"');
    expect(run).not.toContain('--detach "origin/');
    expect(stageWorkflow.on.workflow_call.inputs.stage?.required).toBe(true);
  });

  it("runs the server suite as an 8-shard matrix and a merge job", () => {
    const shards = workflow.jobs.test_server!;
    expect(shards.strategy?.matrix?.shard).toEqual([1, 2, 3, 4, 5, 6, 7, 8]);
    expect(shards.strategy?.["fail-fast"]).toBe(false);
    expect(shards.with?.shard).toBe("${{ format('{0}', matrix.shard) }}");
    expect(workflow.jobs.test_server_merge!.with).toMatchObject({
      stage: "test.server",
      shard: "merge",
    });
  });

  it("sets the shard count the matrix runs, so a runner's own RELEASE_GRAPH_SHARDS is ignored", () => {
    const count = Number(stageWorkflow.env.RELEASE_GRAPH_SHARDS);
    expect(workflow.jobs.test_server!.strategy?.matrix?.shard).toEqual(
      Array.from({ length: count }, (_, index) => index + 1),
    );
    const record = NodeFS.readFileSync(
      new URL("./release/release-record.sh", import.meta.url),
      "utf8",
    );
    expect(record).toContain(`GRAPH_SHARDS="\${RELEASE_GRAPH_SHARDS:-${count}}"`);
  });

  it("names each attempt's log artifact apart, so a re-run of failed jobs can upload", () => {
    const upload = stageWorkflow.jobs.stage.steps.find(
      (step) => step.name === "Upload logs and timings",
    );
    expect(upload?.with?.name).toMatch(/-a\$\{\{ github\.run_attempt \}\}$/);
  });

  it("gives release secrets only to the stages that sign, push or publish, never a test stage", () => {
    const listed = /contains\(fromJSON\('(\[.*\])'\), inputs\.stage\)/.exec(
      stageWorkflow.jobs.stage.env.RELEASE_SECRETS ?? "",
    );
    const secretStages = JSON.parse(listed?.[1] ?? "[]") as ReadonlyArray<string>;
    expect(secretStages).toEqual([
      "resolve",
      "preflight",
      "build.mac",
      "verify.mac",
      "publish.candidate",
      "canary",
      "fleet",
      "finalize",
    ]);
    for (const [stage] of graph) {
      if (stage.startsWith("test."))
        expect([stage, secretStages.includes(stage)]).toEqual([stage, false]);
    }
    const guarded = "env.RELEASE_SECRETS == 'true'";
    const token =
      "${{ env.RELEASE_SECRETS == 'true' && secrets.RELEASE_GH_TOKEN || github.token }}";
    expect(JSON.stringify(stageWorkflow.env)).not.toContain("secrets.");
    expect(JSON.stringify(stageWorkflow.jobs.stage.env)).not.toContain("secrets.");
    for (const step of stageWorkflow.jobs.stage.steps) {
      for (const [key, value] of Object.entries({ ...step.env, ...step.with })) {
        if (!String(value).includes("secrets.") || step.if === guarded) continue;
        // Unguarded, a step gets only the GitHub token: the run's read-only one in a test stage.
        expect([step.name, key, value]).toEqual([step.name, "GH_TOKEN", token]);
      }
    }
    const settings = stageWorkflow.jobs.stage.steps.filter((step) =>
      /settings$/.test(step.name ?? ""),
    );
    expect(settings.map((step) => [step.name, step.if])).toEqual([
      ["Write release settings", guarded],
      ["Write test settings", "env.RELEASE_SECRETS != 'true'"],
      ["Remove release settings", "always()"],
    ]);
    expect(JSON.stringify(settings[1])).not.toMatch(
      /secrets\.|p12|AuthKey|google-oauth|rules\.json/,
    );
  });

  it("is dispatched by hand only and never runs beside release-macos.yml", () => {
    expect(Object.keys(workflow.on)).toEqual(["workflow_dispatch"]);
    expect(workflow.concurrency.group).toBe("release-macos");
    expect(stageWorkflow.jobs.stage["runs-on"]).toBe(macos.jobs.release?.["runs-on"]);
    expect(macos.jobs.release?.["runs-on"]).toBe(
      "${{ vars.RELEASE_MACOS_RUNNER || 'swc-release' }}",
    );
  });
});
