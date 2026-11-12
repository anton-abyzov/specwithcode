// @effect-diagnostics nodeBuiltinImport:off - Reads the workflow file as text.
import * as NodeChild from "node:child_process";
import * as NodeFS from "node:fs";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";
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
    for (const job of ["attest_macos", "follow_up"]) {
      // A skipped release job skips what needs it; none of them forces itself with always().
      expect(parsed.jobs[job]?.needs, job).toEqual(["plan", "release"]);
      expect(parsed.jobs[job]?.if ?? "", job).not.toMatch(/always\(\)|failure\(\)|cancelled\(\)/);
    }
  });

  it("starts the Windows and Linux build after a release that failed once macOS was published", () => {
    // 1.0.261 failed at its merge stage after publishing, which skipped this job and left the
    // version with macOS files only. The job runs unless the run was cancelled or nothing was
    // planned, and its step dispatches only for a published release.
    const job = parsed.jobs.windows_linux;
    expect(job?.needs).toEqual(["plan", "release"]);
    expect(job?.if).toBe(
      "${{ !cancelled() && needs.plan.outputs.action == 'release' && inputs.stop_after == '' }}",
    );
    expect(job?.if ?? "").not.toMatch(/always\(\)/);
    const run = String(job?.steps?.[0]?.run ?? "");
    expect(run).toMatch(/gh release view "v\$VERSION"/);
    expect(run.indexOf("gh release view")).toBeLessThan(run.indexOf("gh workflow run"));
  });

  describe("the Windows and Linux step, run against a fake gh", () => {
    const run = String(parsed.jobs.windows_linux?.steps?.[0]?.run ?? "");
    const fakeGh = `#!/usr/bin/env bash
echo "$*" >> "$FAKE_LOG"
case "$1 $2" in
  "release view")
    if [ -n "$FAKE_RELEASE_ERROR" ]; then echo "$FAKE_RELEASE_ERROR" >&2; exit 1; fi
    echo "$FAKE_DRAFT" ;;
  "run list")
    while [ "$#" -gt 0 ]; do if [ "$1" = --jq ]; then expr="$2"; fi; shift; done
    printf '%s' "$FAKE_RUNS" | jq -r "$expr" ;;
  "workflow run") echo dispatched >> "$FAKE_LOG" ;;
  *) echo "unexpected gh $*" >&2; exit 2 ;;
esac
`;
    const step = (env: Record<string, string>) => {
      const dir = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "windows-linux-step-"));
      NodeFS.writeFileSync(NodePath.join(dir, "gh"), fakeGh, { mode: 0o755 });
      const log = NodePath.join(dir, "log");
      NodeFS.writeFileSync(log, "");
      const result = NodeChild.spawnSync("bash", ["-c", run], {
        encoding: "utf8",
        env: {
          ...process.env,
          PATH: `${dir}:${process.env.PATH ?? ""}`,
          FAKE_LOG: log,
          GITHUB_REPOSITORY: "owner/repo",
          VERSION: "1.0.265",
          FAKE_DRAFT: "false",
          FAKE_RELEASE_ERROR: "",
          FAKE_RUNS: "[]",
          ...env,
        },
      });
      const calls = NodeFS.readFileSync(log, "utf8");
      NodeFS.rmSync(dir, { recursive: true, force: true });
      return { status: result.status, dispatched: calls.includes("dispatched") };
    };
    const runs = (...items: ReadonlyArray<[string, string]>) =>
      JSON.stringify(items.map(([displayTitle, conclusion]) => ({ displayTitle, conclusion })));

    it("dispatches a published release whose build no run started", () => {
      expect(step({})).toEqual({ status: 0, dispatched: true });
    });

    it("dispatches even when another version's build started meanwhile", () => {
      // 1.0.265 skipped its build because a hand dispatch for 1.0.261 fell in its time window.
      const other = runs(["Release Windows and Linux 1.0.261", ""], ["Release Windows and Linux", "success"]);
      expect(step({ FAKE_RUNS: other })).toEqual({ status: 0, dispatched: true });
    });

    it("does not dispatch twice for the same version, and retries after a failed build", () => {
      const same = runs(["Release Windows and Linux 1.0.265", ""]);
      expect(step({ FAKE_RUNS: same })).toEqual({ status: 0, dispatched: false });
      const failed = runs(["Release Windows and Linux 1.0.265", "failure"]);
      expect(step({ FAKE_RUNS: failed })).toEqual({ status: 0, dispatched: true });
      for (const conclusion of ["cancelled", "timed_out", "startup_failure"]) {
        const ended = runs(["Release Windows and Linux 1.0.265", conclusion]);
        expect(step({ FAKE_RUNS: ended })).toEqual({ status: 0, dispatched: true });
      }
      const done = runs(["Release Windows and Linux 1.0.265", "success"]);
      expect(step({ FAKE_RUNS: done })).toEqual({ status: 0, dispatched: false });
      const dryRun = runs(["Release Windows and Linux 1.0.265 (dry run)", "success"]);
      expect(step({ FAKE_RUNS: dryRun })).toEqual({ status: 0, dispatched: true });
    });

    it("counts the release event's build only while it is turned on", () => {
      const event = JSON.stringify([
        { displayTitle: "SpecWithCode 1.0.265", event: "release", conclusion: "" },
      ]);
      expect(step({ FAKE_RUNS: event, ON_PUBLISH: "true" })).toEqual({ status: 0, dispatched: false });
      expect(step({ FAKE_RUNS: event, ON_PUBLISH: "false" })).toEqual({ status: 0, dispatched: true });
      const skipped = JSON.stringify([
        { displayTitle: "SpecWithCode 1.0.265", event: "release", conclusion: "skipped" },
      ]);
      expect(step({ FAKE_RUNS: skipped, ON_PUBLISH: "true" })).toEqual({ status: 0, dispatched: true });
      const older = JSON.stringify([
        { displayTitle: "SpecWithCode 1.0.264", event: "release", conclusion: "success" },
      ]);
      expect(step({ FAKE_RUNS: older, ON_PUBLISH: "true" })).toEqual({ status: 0, dispatched: true });
    });

    it("skips a draft or missing release and fails on any other gh error", () => {
      expect(step({ FAKE_DRAFT: "true" })).toEqual({ status: 0, dispatched: false });
      expect(step({ FAKE_RELEASE_ERROR: "release not found" })).toEqual({ status: 0, dispatched: false });
      expect(step({ FAKE_RELEASE_ERROR: "HTTP 403: API rate limit exceeded" })).toEqual({
        status: 1,
        dispatched: false,
      });
    });

    it("matches the title release-windows-linux.yml gives a dispatched run", () => {
      const windowsLinux = parse(
        NodeFS.readFileSync(
          new URL("../.github/workflows/release-windows-linux.yml", import.meta.url),
          "utf8",
        ),
      ) as { "run-name"?: string };
      expect(windowsLinux["run-name"]).toBe(
        "${{ github.event_name == 'workflow_dispatch' && format('Release Windows and Linux {0}{1}', inputs.version, inputs.dry_run && ' (dry run)' || '') || '' }}",
      );
      expect(run).toContain('.displayTitle == \\"Release Windows and Linux $VERSION\\"');
    });
  });

  it("asks for another run only after a run with no version continued an older candidate", () => {
    expect(parsed.jobs.follow_up?.if).toBe(
      "${{ inputs.version == '' && inputs.stop_after == '' && needs.release.outputs.resumed == 'true' }}",
    );
  });
});
