// @effect-diagnostics nodeBuiltinImport:off - Reads the workflow file as text and runs its step.
import * as NodeChildProcess from "node:child_process";
import * as NodeFS from "node:fs";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";
import { describe, expect, it } from "vite-plus/test";
import { parse } from "yaml";

interface Step {
  readonly name?: string;
  readonly run?: string;
  readonly uses?: string;
  readonly with?: Record<string, string>;
  readonly env?: Record<string, string>;
}
interface Job {
  readonly needs?: ReadonlyArray<string> | string;
  readonly if?: string;
  readonly environment?: unknown;
  readonly concurrency?: unknown;
  readonly permissions?: Record<string, string>;
  readonly "runs-on"?: unknown;
  readonly steps?: ReadonlyArray<Step>;
}
const workflow = parse(
  NodeFS.readFileSync(
    new URL("../.github/workflows/release-windows-linux.yml", import.meta.url),
    "utf8",
  ),
  { uniqueKeys: true },
) as { "run-name"?: string; concurrency?: unknown; jobs: Record<string, Job> };
const retry = workflow.jobs.retry;
const run = String(retry?.steps?.find((step) => step.run?.includes("gh workflow run"))?.run ?? "");

// 1.0.304: the run the published release started failed at the update proof. release-macos.yml
// had seen it going and started nothing, so the version had no Windows or Linux apps until a
// person dispatched the build.
describe("release-windows-linux.yml retry job", () => {
  it("runs last, only for a failed run that the published release started", () => {
    const names = Object.keys(workflow.jobs);
    expect(names.at(-1)).toBe("retry");
    // Every build job, not the macOS checksums signature: a signature that failed is redone by the
    // next daily run (mac-sums-signature), never by building the version again.
    expect(retry?.needs).toEqual(names.filter((name) => name !== "retry" && name !== "mac-sums-signature"));
    // A job that ran into its timeout ends cancelled and failure() does not see it. cancelled()
    // is the run a person cancelled.
    expect(retry?.if).toBe(
      "${{ !cancelled() && github.event_name == 'release' && (failure() || contains(needs.*.result, 'cancelled')) }}",
    );
    expect(retry?.if ?? "").not.toMatch(/always\(\)/);
    for (const [name, job] of Object.entries(workflow.jobs)) {
      if (name !== "retry") expect([job.needs ?? []].flat(), name).not.toContain("retry");
    }
  });

  it("may start a run, holds no lock and reads no release secret", () => {
    expect(retry?.permissions).toEqual({ actions: "write", contents: "read" });
    expect(retry?.["runs-on"]).toBe("ubuntu-24.04");
    // A lock would queue the new run's upload behind this run; the environment holds the secrets.
    expect(retry?.concurrency).toBeUndefined();
    expect(retry?.environment).toBeUndefined();
    expect(workflow.concurrency).toBeUndefined();
    expect(JSON.stringify(retry)).not.toContain("secrets.");
  });

  it("fetches the release helper of the tagged commit before the step that reads it", () => {
    const [node, fetch, start] = retry?.steps ?? [];
    expect(node?.uses).toMatch(/^actions\/setup-node@[0-9a-f]{40}$/);
    expect(node?.with?.["node-version"]).toBe("22.20.0");
    expect(fetch?.run).toContain("contents/scripts/release-windows-linux.ts?ref=$GITHUB_SHA");
    expect(fetch?.run).toContain('echo "TOOL=$tool" >> "$GITHUB_ENV"');
    expect(start?.run).toBe(run);
    expect(run).toContain('node "$TOOL" release-state --version "$version" --repo "$repo"');
    expect(run).toContain("for repo in $RELEASE_REPOSITORIES; do");
    expect(retry?.steps).toHaveLength(3);
  });

  it("dispatches a real run of the version the event names, on the default branch", () => {
    const step = retry?.steps?.find((entry) => entry.run === run);
    expect(step?.env?.RELEASE_TAG).toBe("${{ github.event.release.tag_name }}");
    expect(run).not.toContain("needs.plan");
    expect(run).toMatch(
      /gh workflow run release-windows-linux\.yml -R "\$GITHUB_REPOSITORY" \\\n\s+-f version="\$version" -f dry_run=false\n/,
    );
    expect(run).not.toMatch(/--ref|-f replace/);
    expect(run.match(/gh workflow run/g)).toHaveLength(1);
  });

  it("looks for the title a dispatched real run gets", () => {
    expect(workflow["run-name"]).toBe(
      "${{ github.event_name == 'workflow_dispatch' && format('Release Windows and Linux {0}{1}', inputs.version, inputs.dry_run && ' (dry run)' || '') || '' }}",
    );
    expect(run).toContain('.displayTitle == \\"Release Windows and Linux $version\\"');
  });

  describe("the step, run against a fake gh and release helper", () => {
    // gh: `api .../releases/tags/vX` filters the release FAKE_RELEASE by --jq, or fails as gh
    // does (the body on stdout, the status on stderr). `run list` filters FAKE_RUNS (FAKE_RUNS_AFTER once a run was
    // dispatched) by --event and --jq, as gh does. node: release-state exits FAKE_STATE for this
    // repository and FAKE_STATE_FEED for another. sleep: returns at once.
    const fakeGh = `#!/usr/bin/env bash
set -o pipefail
echo "gh $*" >> "$FAKE_LOG"
case "$1 $2" in
  "api repos/$GITHUB_REPOSITORY/releases/tags/v"*)
    if [ -n "$FAKE_RELEASE_ERROR" ]; then
      echo '{"message":"x"}'; echo "gh: $FAKE_RELEASE_ERROR" >&2; exit 1
    fi
    while [ "$#" -gt 0 ]; do if [ "$1" = --jq ]; then expr="$2"; fi; shift; done
    printf '%s' "$FAKE_RELEASE" | jq -r "$expr" ;;
  "run list")
    if [ -n "$FAKE_LIST_ERROR" ]; then echo "$FAKE_LIST_ERROR" >&2; exit 1; fi
    if [ -n "$FAKE_LIST_ERROR_AFTER" ] && grep -q '^dispatched$' "$FAKE_LOG"; then
      echo "$FAKE_LIST_ERROR_AFTER" >&2; exit 1
    fi
    event="" expr=""
    while [ "$#" -gt 0 ]; do
      case "$1" in --event) event="$2" ;; --jq) expr="$2" ;; esac
      shift
    done
    runs="$FAKE_RUNS"
    if grep -q '^dispatched$' "$FAKE_LOG"; then runs="$FAKE_RUNS_AFTER"; fi
    printf '%s' "$runs" | jq --arg event "$event" '[.[] | select($event == "" or .event == $event)]' | jq -r "$expr" ;;
  "workflow run") echo dispatched >> "$FAKE_LOG" ;;
  *) echo "unexpected gh $*" >&2; exit 2 ;;
esac
`;
    const fakeNode = `#!/usr/bin/env bash
echo "node $*" >> "$FAKE_LOG"
repo=""
while [ "$#" -gt 0 ]; do if [ "$1" = --repo ]; then repo="$2"; fi; shift; done
if [ "$repo" = "$GITHUB_REPOSITORY" ]; then exit "$FAKE_STATE"; fi
exit "$FAKE_STATE_FEED"
`;
    const release = (draft: boolean, prerelease: boolean) =>
      JSON.stringify({ tag_name: "v1.0.304", draft, prerelease });
    const step = (env: Record<string, string>) => {
      const dir = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "windows-linux-retry-"));
      NodeFS.writeFileSync(NodePath.join(dir, "gh"), fakeGh, { mode: 0o755 });
      NodeFS.writeFileSync(NodePath.join(dir, "node"), fakeNode, { mode: 0o755 });
      NodeFS.writeFileSync(NodePath.join(dir, "sleep"), "#!/usr/bin/env bash\n", { mode: 0o755 });
      const log = NodePath.join(dir, "log");
      const summary = NodePath.join(dir, "summary");
      NodeFS.writeFileSync(log, "");
      NodeFS.writeFileSync(summary, "");
      const result = NodeChildProcess.spawnSync("bash", ["-c", run], {
        encoding: "utf8",
        env: {
          ...process.env,
          PATH: `${dir}:${process.env.PATH ?? ""}`,
          FAKE_LOG: log,
          GITHUB_STEP_SUMMARY: summary,
          GITHUB_REPOSITORY: "owner/repo",
          RELEASE_REPOSITORIES: "owner/repo",
          TOOL: "release-windows-linux.ts",
          RELEASE_TAG: "v1.0.304",
          FAKE_RELEASE: release(false, false),
          FAKE_RELEASE_ERROR: "",
          FAKE_LIST_ERROR: "",
          FAKE_LIST_ERROR_AFTER: "",
          FAKE_STATE: "3",
          FAKE_STATE_FEED: "3",
          FAKE_RUNS: "[]",
          FAKE_RUNS_AFTER: "[]",
          ...env,
        },
      });
      const calls = NodeFS.readFileSync(log, "utf8");
      const written = NodeFS.readFileSync(summary, "utf8");
      NodeFS.rmSync(dir, { recursive: true, force: true });
      return {
        status: result.status,
        dispatched: calls.split("\n").filter((line) => line === "dispatched").length,
        calls,
        output: `${result.stdout}${result.stderr}${written}`,
      };
    };
    const outcome = (env: Record<string, string>) => {
      const { status, dispatched } = step(env);
      return { status, dispatched };
    };
    const runs = (...items: ReadonlyArray<[title: string, conclusion: string, event?: string]>) =>
      JSON.stringify(
        items.map(([displayTitle, conclusion, event = "workflow_dispatch"], index) => ({
          displayTitle,
          conclusion,
          event,
          url: `https://example.test/runs/${index + 1}`,
        })),
      );
    const failedEvent: [string, string, string] = ["SpecWithCode 1.0.304", "", "release"];

    it("starts one real run for the version when nothing else did", () => {
      const result = step({ FAKE_RUNS: runs(failedEvent) });
      expect(result.status).toBe(0);
      expect(result.dispatched).toBe(1);
      expect(result.calls).toContain(
        "gh workflow run release-windows-linux.yml -R owner/repo -f version=1.0.304 -f dry_run=false\n",
      );
      expect(result.calls).toContain("--event workflow_dispatch");
      expect(result.calls).toContain("gh api repos/owner/repo/releases/tags/v1.0.304 ");
      expect(result.calls).toContain(
        "node release-windows-linux.ts release-state --version 1.0.304 --repo owner/repo\n",
      );
    });

    it("waits until the new run is listed, and gives up quietly when it is not", () => {
      const listed = step({
        FAKE_RUNS_AFTER: runs(["Release Windows and Linux 1.0.304", ""]),
      });
      expect(listed).toMatchObject({ status: 0, dispatched: 1 });
      expect(listed.calls.match(/gh run list/g)).toHaveLength(2);
      expect(listed.output).toContain("again: https://example.test/runs/1");
      const never = step({});
      expect(never).toMatchObject({ status: 0, dispatched: 1 });
      expect(never.calls.match(/gh run list/g)).toHaveLength(13);
      expect(never.output).toContain("### Started the build for 1.0.304 again\n");
      expect(never.output).toContain(
        "::warning::Dispatched the Windows and Linux build for 1.0.304",
      );
      expect(listed.output).not.toContain("::warning::");
      // Once dispatched, a failure does not claim the build was not started.
      const late = step({ GITHUB_STEP_SUMMARY: "/nonexistent-dir/summary" });
      expect(late.dispatched).toBe(1);
      expect(late.status).not.toBe(0);
      expect(late.output).not.toContain("was not started again");
      // A listing that fails after the dispatch does not turn a started retry into a failure.
      for (const after of [
        { FAKE_LIST_ERROR_AFTER: "HTTP 502" },
        { FAKE_RUNS_AFTER: "not json" },
      ]) {
        const flaky = step(after);
        expect(flaky, JSON.stringify(after)).toMatchObject({ status: 0, dispatched: 1 });
        expect(flaky.calls.match(/gh run list/g)).toHaveLength(13);
        expect(flaky.output).not.toContain("was not started again");
      }
    });

    it("does not start a second run while one is going or after one succeeded", () => {
      // The title carries the version as typed: a hand dispatch may say v1.0.304.
      for (const title of [
        "Release Windows and Linux 1.0.304",
        "Release Windows and Linux v1.0.304",
      ]) {
        for (const conclusion of ["", "success"]) {
          const same = runs(failedEvent, [title, conclusion]);
          expect(outcome({ FAKE_RUNS: same }), `${title} ${conclusion}`).toEqual({
            status: 0,
            dispatched: 0,
          });
        }
      }
    });

    it("starts one after a dispatched run that ended any other way, or that was not this build", () => {
      for (const conclusion of [
        "failure",
        "cancelled",
        "timed_out",
        "startup_failure",
        "skipped",
      ]) {
        const ended = runs(failedEvent, ["Release Windows and Linux 1.0.304", conclusion]);
        expect(outcome({ FAKE_RUNS: ended }), conclusion).toEqual({ status: 0, dispatched: 1 });
      }
      const others = runs(
        failedEvent,
        ["Release Windows and Linux 1.0.303", "success"],
        ["Release Windows and Linux 1.0.3040", ""],
        ["Release Windows and Linux 1.0.304 (dry run)", "success"],
        // A scheduled or release-event run never carries the dispatched title; were one to, it
        // would still not count.
        ["Release Windows and Linux 1.0.304", "success", "schedule"],
        ["SpecWithCode 1.0.304", "success", "release"],
      );
      expect(outcome({ FAKE_RUNS: others })).toEqual({ status: 0, dispatched: 1 });
    });

    it("leaves a draft, a prerelease, a deleted release and a tag that is no X.Y.Z alone", () => {
      // The endpoint finds published releases only: a draft is a 404 like a deleted release.
      expect(outcome({ FAKE_RELEASE_ERROR: "Not Found (HTTP 404)" })).toEqual({
        status: 0,
        dispatched: 0,
      });
      for (const state of [release(true, false), release(false, true), release(true, true)]) {
        expect(outcome({ FAKE_RELEASE: state }), state).toEqual({ status: 0, dispatched: 0 });
      }
      // Only a release the API calls neither draft nor prerelease is built again.
      expect(outcome({ FAKE_RELEASE: '{"draft":false}' })).toEqual({ status: 0, dispatched: 0 });
      for (const tag of ["v1.0.304-rc.1", "1.0", "nightly", "v01.0.1", ""]) {
        const result = step({ RELEASE_TAG: tag });
        expect({ status: result.status, dispatched: result.dispatched }, tag).toEqual({
          status: 0,
          dispatched: 0,
        });
        expect(result.calls, tag).toBe("");
      }
    });

    it("fails without starting a run when gh cannot say, and says how to start it by hand", () => {
      const hint =
        "::error::The build for 1.0.304 was not started again. If v1.0.304 still lacks its Windows and Linux apps, run Release Windows and Linux by hand with version=1.0.304 and dry_run=false.";
      for (const env of [
        { FAKE_RELEASE_ERROR: "API rate limit exceeded (HTTP 403)" },
        { FAKE_RELEASE_ERROR: "release not found" },
        { FAKE_RELEASE_ERROR: "Server Error (HTTP 502)" },
        { FAKE_LIST_ERROR: "HTTP 502" },
        { FAKE_STATE: "1" },
      ]) {
        const result = step(env);
        const label = JSON.stringify(env);
        expect({ status: result.status, dispatched: result.dispatched }, label).toEqual({
          status: 1,
          dispatched: 0,
        });
        expect(result.output, label).toContain(hint);
      }
    });

    it("looks for a run of the version before it reads the release", () => {
      // A run that is uploading right now makes the release look half attached.
      const going = step({
        FAKE_RUNS: runs(["Release Windows and Linux 1.0.304", ""]),
        FAKE_STATE: "4",
      });
      expect(going).toMatchObject({ status: 0, dispatched: 0 });
      expect(going.calls).not.toContain("release-state");
    });

    it("builds only when no release holds any of the apps", () => {
      // 0 complete, 3 absent, 4 partial or inconsistent, anything else a failed read.
      expect(outcome({ FAKE_STATE: "0" })).toEqual({ status: 0, dispatched: 0 });
      const partial = step({ FAKE_STATE: "4" });
      expect(partial).toMatchObject({ status: 4, dispatched: 0 });
      // The helper printed the replace repair; a plain dispatch would be refused.
      expect(partial.output).not.toContain("was not started again");
      const both = { RELEASE_REPOSITORIES: "owner/repo anton-abyzov/specwithcode" };
      expect(outcome({ ...both })).toEqual({ status: 0, dispatched: 1 });
      expect(outcome({ ...both, FAKE_STATE: "0", FAKE_STATE_FEED: "0" })).toEqual({
        status: 0,
        dispatched: 0,
      });
      const mixed = step({ ...both, FAKE_STATE: "0" });
      expect({ status: mixed.status, dispatched: mixed.dispatched }).toEqual({
        status: 1,
        dispatched: 0,
      });
      expect(mixed.output).toContain("version=1.0.304, dry_run=false and replace=true");
      expect(mixed.output).not.toContain("was not started again");
      expect(outcome({ ...both, FAKE_STATE_FEED: "4" })).toEqual({ status: 4, dispatched: 0 });
    });
  });
});
