// @effect-diagnostics nodeBuiltinImport:off - Reads the workflow file as text.
import * as NodeFS from "node:fs";
import { describe, expect, it } from "vite-plus/test";
import { parse } from "yaml";

const workflow = NodeFS.readFileSync(
  new URL("../.github/workflows/release-macos.yml", import.meta.url),
  "utf8",
);

interface Step {
  readonly name?: string;
  readonly id?: string;
  readonly run?: string;
  readonly uses?: string;
}
interface Job {
  readonly "runs-on"?: unknown;
  readonly needs?: ReadonlyArray<string>;
  readonly if?: string;
  readonly env?: Record<string, string>;
  readonly outputs?: Record<string, string>;
  readonly steps?: ReadonlyArray<Step>;
  readonly with?: Record<string, string>;
}
const parsed = parse(workflow, { uniqueKeys: true }) as {
  on: { workflow_dispatch: { inputs: Record<string, { required?: boolean }> } };
  concurrency: Record<string, unknown>;
  jobs: Record<string, Job>;
};
const steps = (job: string) => parsed.jobs[job]?.steps ?? [];
const stepIndex = (job: string, name: string) => steps(job).findIndex((step) => step.name === name);

describe("release-macos.yml runner", () => {
  it("defaults to the self-hosted M1 release runner", () => {
    expect(parsed.jobs.release?.["runs-on"]).toBe(
      "${{ vars.RELEASE_MACOS_RUNNER || 'swc-release' }}",
    );
  });
});

// Any number of sessions dispatch this workflow; the workflow, not the caller, picks the version.
describe("release-macos.yml: one run cuts each version", () => {
  it("needs no version from the caller", () => {
    expect(parsed.on.workflow_dispatch.inputs.version?.required).toBe(false);
  });

  it("runs one release at a time for the whole run and keeps every waiting run", () => {
    expect(parsed.concurrency).toEqual({
      group: "release-macos",
      "cancel-in-progress": false,
      queue: "max",
    });
    // A job-level group would let another run plan between this run's plan and its release.
    for (const [name, job] of Object.entries(parsed.jobs)) {
      expect(job, name).not.toHaveProperty("concurrency");
    }
  });

  it("plans on a hosted runner before the release Mac is used", () => {
    expect(parsed.jobs.plan?.["runs-on"]).toBe("ubuntu-24.04");
    const planned = steps("plan")
      .map((step) => step.run ?? "")
      .join("\n");
    expect(planned).toContain('python3 -B scripts/release/release_plan.py "${args[@]}"');
    // release_plan.py takes its command first; without it every run would fail here.
    expect(planned).toContain('args=(plan --repo "$GITHUB_REPOSITORY"');
    expect(parsed.jobs.release?.needs).toEqual(["plan"]);
    expect(parsed.jobs.release?.if).toBe("${{ needs.plan.outputs.action == 'release' }}");
  });

  it("releases the planned version, never the dispatched one", () => {
    expect(parsed.jobs.release?.env?.RELEASE_VERSION).toBe("${{ needs.plan.outputs.version }}");
    expect(parsed.jobs.attest_macos?.with?.version).toBe("${{ needs.plan.outputs.version }}");
    // inputs.version is read for the run's title, by the plan step and to tell a run with no
    // version apart; nothing downstream of the plan takes the version from it.
    const uses = workflow.split("\n").filter((line) => line.includes("${{ inputs.version"));
    expect(uses.map((line) => line.trim().split(":")[0])).toEqual([
      "run-name",
      "INPUT_VERSION",
      "if",
    ]);
  });

  it("decides how an earlier attempt continues before the toolchain steps", () => {
    const attempt = stepIndex("release", "Continue an earlier attempt or start over");
    expect(attempt).toBeGreaterThan(stepIndex("release", "Checkout"));
    expect(attempt).toBeLessThan(stepIndex("release", "Select Xcode 26"));
    expect(steps("release")[attempt]?.id).toBe("attempt");
    expect(parsed.jobs.release?.outputs?.resumed).toBe("${{ steps.attempt.outputs.resumed }}");
    const release = steps("release")[stepIndex("release", "Release")]?.run ?? "";
    expect(release).toContain('if [ "$RESUMED" = true ]; then args+=(--resume); fi');
    expect(release).not.toContain("INPUT_RESUME");
  });

  it("skips the follow-on jobs when nothing was released", () => {
    for (const job of ["windows_linux", "attest_macos", "follow_up"]) {
      // A skipped release job skips what needs it; none of them forces itself with always().
      expect(parsed.jobs[job]?.needs, job).toEqual(["plan", "release"]);
      expect(parsed.jobs[job]?.if ?? "", job).not.toMatch(/always\(\)|failure\(\)|cancelled\(\)/);
    }
  });

  it("asks for another run only after a run with no version continued an older candidate", () => {
    expect(parsed.jobs.follow_up?.if).toBe(
      "${{ inputs.version == '' && inputs.stop_after == '' && needs.release.outputs.resumed == 'true' }}",
    );
  });
});
