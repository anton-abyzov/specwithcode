import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, it } from "@effect/vitest";
import type { ReleaseRun } from "@specweave-studio/contracts";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Option from "effect/Option";
import * as Path from "effect/Path";
import { describe, expect } from "vite-plus/test";

import * as ReleaseRuns from "./ReleaseRunService.ts";

/** A record as scripts/release/run_record.py writes it (extra keys included). */
const record = (version: string, runId: string, startedAt: string, overrides = {}) => ({
  schemaVersion: 1,
  kind: "release",
  runId,
  rev: 7,
  version,
  previous: "1.0.189",
  channel: "candidate",
  sha: "a".repeat(40),
  createdAt: startedAt,
  createdBy: "release.sh",
  startedAt,
  updatedAt: startedAt,
  endedAt: null,
  state: "running",
  resumes: 0,
  stages: [
    {
      id: "preflight",
      needs: ["resolve"],
      state: "passed",
      startedAt,
      endedAt: startedAt,
      log: "logs/preflight.log",
      steps: [
        {
          name: "preflight",
          state: "passed",
          startedAt,
          endedAt: startedAt,
          log: "logs/preflight.log",
          attempt: 1,
        },
      ],
      facts: { disk: { m4: { freeGiB: 123, needGiB: 41 } } },
    },
    {
      id: "test.server",
      needs: ["resolve"],
      state: "running",
      startedAt,
      endedAt: null,
      log: null,
      steps: [],
      shards: [{ n: 1, state: "passed" }],
    },
  ],
  hosts: [
    {
      identity: "m3",
      role: "fleet",
      required: true,
      from: "1.0.189",
      to: version,
      state: "not-updated",
      askedAt: startedAt,
      ackedAt: null,
      installedAt: null,
      verifiedAt: null,
      reason: "busy: 3 windows elapsed (claude, node)",
      notUpdatedAt: startedAt,
    },
  ],
  ...overrides,
});

const withRuns = <A, E>(
  files: Record<string, string>,
  use: (directory: string) => Effect.Effect<A, E, FileSystem.FileSystem | Path.Path>,
) =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const base = yield* fs.makeTempDirectoryScoped({ prefix: "release-runs-" });
    const directory = path.join(base, "updates", "runs");
    yield* fs.makeDirectory(directory, { recursive: true });
    for (const [name, text] of Object.entries(files)) {
      yield* fs.writeFileString(path.join(directory, name), text);
    }
    return yield* use(directory);
  }).pipe(Effect.scoped, Effect.provide(NodeServices.layer));

describe("ReleaseRunService", () => {
  it.effect("lists release run records newest first, with their stages and hosts", () =>
    withRuns(
      {
        "release-1.0.189-aaa111.json": JSON.stringify(
          record("1.0.189", "aaa111", "2026-11-03T09:00:00Z", { state: "done" }),
        ),
        "release-1.0.190-bbb222.json": JSON.stringify(
          record("1.0.190", "bbb222", "2026-11-04T09:00:00Z"),
        ),
        // An update run the desktop archived: same folder, not a release.
        "36ede669-6517-4695-9534-ae71e63bd852.json": JSON.stringify({
          schemaVersion: 1,
          runId: "36ede669",
          phase: "verified",
        }),
      },
      (directory) =>
        Effect.gen(function* () {
          const service = yield* ReleaseRuns.makeWithDirectory(directory);
          const snapshot = yield* service.list();
          assert.deepStrictEqual(
            snapshot.runs.map((run) => run.version),
            ["1.0.190", "1.0.189"],
          );
          assert.strictEqual(snapshot.skipped, 0);
          const [latest] = snapshot.runs;
          expect(latest!.stages.map((stage) => [stage.id, stage.state])).toEqual([
            ["preflight", "passed"],
            ["test.server", "running"],
          ]);
          expect(latest!.stages[1]!.shards).toEqual([{ n: 1, state: "passed" }]);
          expect(latest!.hosts[0]).toMatchObject({
            identity: "m3",
            state: "not-updated",
            reason: "busy: 3 windows elapsed (claude, node)",
          });
          assert.strictEqual((yield* service.list(1)).runs.length, 1);
        }),
    ),
  );

  it.effect(
    "skips files that are no release record, and answers an empty list without the folder",
    () =>
      withRuns(
        {
          "release-1.0.190-ok.json": JSON.stringify(
            record("1.0.190", "ok", "2026-11-04T09:00:00Z"),
          ),
          "release-1.0.190-partial.json": '{"schemaVersion": 1, "kind": "rel',
          "release-1.0.190-newer.json": JSON.stringify(
            record("1.0.190", "newer", "2026-11-04T10:00:00Z", { schemaVersion: 2 }),
          ),
          "release-1.0.190-update.json": JSON.stringify({ kind: "update" }),
        },
        (directory) =>
          Effect.gen(function* () {
            const snapshot = yield* (yield* ReleaseRuns.makeWithDirectory(directory)).list();
            assert.deepStrictEqual(
              snapshot.runs.map((run) => run.runId),
              ["ok"],
            );
            assert.strictEqual(snapshot.skipped, 3);
            const missing = yield* (yield* ReleaseRuns.makeWithDirectory(
              `${directory}/does-not-exist`,
            )).list();
            assert.deepStrictEqual(missing, { runs: [], skipped: 0 });
          }),
      ),
  );

  it("parses what run_record.py writes and orders runs that started together by id", () => {
    const parsed = ReleaseRuns.parseReleaseRun(
      JSON.stringify(record("1.0.190", "x", "2026-11-04T09:00:00Z")),
    );
    assert.isTrue(Option.isSome(parsed));
    assert.isTrue(Option.isNone(ReleaseRuns.parseReleaseRun("[]")));
    const at = "2026-11-04T09:00:00Z";
    const runs = ["a", "c", "b"].map(
      (runId) =>
        Option.getOrThrow(
          ReleaseRuns.parseReleaseRun(JSON.stringify(record("1.0.190", runId, at))),
        ) as ReleaseRun,
    );
    assert.deepStrictEqual(
      ReleaseRuns.newestFirst(runs).map((run) => run.runId),
      ["c", "b", "a"],
    );
  });
});
