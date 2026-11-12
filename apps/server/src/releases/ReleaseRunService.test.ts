import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, it } from "@effect/vitest";
import type { ReleaseRun } from "@specweave-studio/contracts";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as FileSystem from "effect/FileSystem";
import * as Option from "effect/Option";
import * as Path from "effect/Path";
import * as Scope from "effect/Scope";
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
  use: (directory: string) => Effect.Effect<A, E, FileSystem.FileSystem | Path.Path | Scope.Scope>,
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
            assert.deepStrictEqual(missing, { runs: [], skipped: 0, timings: [] });
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

  it.effect("answers the timings of more runs than it sends whole", () =>
    withRuns(
      Object.fromEntries(
        Array.from({ length: 12 }, (_, index) => {
          const version = `1.0.${200 + index}`;
          const startedAt = `2026-11-${String(index + 1).padStart(2, "0")}T09:00:00Z`;
          const stages = [
            {
              id: "test.server",
              needs: [],
              state: "passed",
              startedAt,
              endedAt: `2026-11-${String(index + 1).padStart(2, "0")}T09:10:00Z`,
              log: null,
              steps: [],
            },
          ];
          return [
            `release-${version}-r${index}.json`,
            JSON.stringify(record(version, `r${index}`, startedAt, { state: "done", stages })),
          ];
        }),
      ),
      (directory) =>
        Effect.gen(function* () {
          const snapshot = yield* (yield* ReleaseRuns.makeWithDirectory(directory)).list();
          assert.strictEqual(snapshot.runs.length, ReleaseRuns.RELEASE_RUNS_LIMIT);
          assert.strictEqual(snapshot.timings?.length, 12);
          expect(snapshot.timings![0]).toMatchObject({
            version: "1.0.211",
            state: "done",
            totalSeconds: 600,
            stages: [{ id: "test.server", state: "passed", seconds: 600 }],
          });
          assert.isFalse("installs" in snapshot);
        }),
    ),
  );
});

/** A receipt as update.py writes it, with the keys this reads among many it does not. */
const receipt = (phase: string, timings: Record<string, number>, verifiedAt?: string) =>
  JSON.stringify({
    phase,
    before: { rows: { threads: 12 } },
    backup: "owned-updates/x",
    ...(verifiedAt ? { verifiedAt } : {}),
    timings,
  });

const withReceipts = <A, E>(
  receipts: Record<string, string>,
  use: (
    files: ReleaseRuns.InstallTimingFiles & { readonly runs: string },
  ) => Effect.Effect<A, E, FileSystem.FileSystem | Path.Path | Scope.Scope>,
) =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const updates = path.join(
      yield* fs.makeTempDirectoryScoped({ prefix: "installs-" }),
      "updates",
    );
    const receiptsDirectory = path.join(updates, "receipts");
    yield* fs.makeDirectory(receiptsDirectory, { recursive: true });
    for (const [name, text] of Object.entries(receipts)) {
      yield* fs.writeFileString(path.join(receiptsDirectory, name), text);
    }
    return yield* use({
      runs: path.join(updates, "runs"),
      receiptsDirectory,
      historyFile: path.join(updates, ReleaseRuns.INSTALL_HISTORY_FILE),
    });
  }).pipe(Effect.scoped, Effect.provide(NodeServices.layer));

describe("install timings", () => {
  it.effect("reads verified installs from the receipts and keeps them after a receipt goes", () =>
    withReceipts(
      {
        "update-1.0.201-20261110T101500123456Z.json": receipt(
          "verified",
          { beforeRead: 1000, serviceStop: 3000, readiness: 6000, total: 21500 },
          "2026-11-10T10:15:21.500000+00:00",
        ),
        "update-1.0.202-20261111T090000000001Z.json": receipt("verified", {
          serviceStop: 2000,
          total: 18000,
        }),
        // Still installing, a refusal, a failure, and the prestate copy beside each attempt.
        "update-1.0.203-20261112T090000000001Z.json": receipt("restart-requested", {
          beforeRead: 900,
        }),
        "update-1.0.203-20261112T080000000001Z.json": receipt("preflight", { total: 400 }),
        "update-1.0.203-20261112T070000000001Z.json": JSON.stringify({
          phase: "prepared",
          result: "update-failed",
          timings: { untilFailure: 5000 },
        }),
        "prestate-1.0.202-20261111T090000000001Z.json": receipt("verified", { total: 1 }),
        "update-1.0.204-20261112T110000000001Z.json": "{ not json",
      },
      (files) =>
        Effect.gen(function* () {
          const fs = yield* FileSystem.FileSystem;
          const path = yield* Path.Path;
          const service = yield* ReleaseRuns.makeWithDirectory(files.runs, files);
          // The receipts are read in the background, never while a request waits.
          expect((yield* service.list()).installs).toEqual([]);
          yield* service.refreshInstalls;
          const first = yield* service.list();
          expect(first.installs).toEqual([
            {
              version: "1.0.202",
              installedAt: "2026-11-11T09:00:00.000Z",
              totalMs: 18000,
              phases: { serviceStop: 2000 },
            },
            {
              version: "1.0.201",
              installedAt: "2026-11-10T10:15:21.500Z",
              totalMs: 21500,
              phases: { beforeRead: 1000, serviceStop: 3000, readiness: 6000 },
            },
          ]);
          // The update pruned 1.0.201's receipt; a restarted service still has it.
          yield* fs.remove(
            path.join(files.receiptsDirectory, "update-1.0.201-20261110T101500123456Z.json"),
          );
          const restarted = yield* ReleaseRuns.makeWithDirectory(files.runs, files);
          const second = yield* restarted.list();
          expect(second.installs?.map((install) => install.version)).toEqual([
            "1.0.202",
            "1.0.201",
          ]);
          yield* service.awaitBackgroundScan;
          yield* restarted.awaitBackgroundScan;
          const kept = yield* fs.readFileString(files.historyFile);
          expect(kept).toContain('"schemaVersion":1');
          expect(kept).not.toContain("owned-updates");
          expect(kept).not.toContain("threads");
        }),
    ),
  );

  it.effect("answers none without receipts, and trims the history to its limit", () =>
    withReceipts({}, (files) =>
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const service = yield* ReleaseRuns.makeWithDirectory(files.runs, files);
        assert.deepStrictEqual((yield* service.list()).installs, []);
        yield* service.awaitBackgroundScan;
        assert.isFalse(yield* fs.exists(files.historyFile));
        const many = Array.from({ length: ReleaseRuns.INSTALL_HISTORY_LIMIT + 5 }, (_, index) => ({
          version: `1.0.${index}`,
          installedAt: `2026-10-${String(index + 1).padStart(2, "0")}T00:00:00.000Z`,
          totalMs: 1000 + index,
        }));
        const merged = ReleaseRuns.mergeInstalls(many.slice(0, 20), many.slice(15));
        assert.strictEqual(merged.length, ReleaseRuns.INSTALL_HISTORY_LIMIT);
        assert.strictEqual(merged[0]!.version, `1.0.${ReleaseRuns.INSTALL_HISTORY_LIMIT + 4}`);
      }),
    ),
  );

  it.effect("never parses a receipt the history holds again, after a restart too", () =>
    withReceipts(
      {
        "update-1.0.99-20261111T090000000001Z.json": receipt("verified", { total: 18000 }),
      },
      (files) =>
        Effect.gen(function* () {
          const fs = yield* FileSystem.FileSystem;
          const path = yield* Path.Path;
          yield* (yield* ReleaseRuns.makeWithDirectory(files.runs, files)).refreshInstalls;
          expect(yield* fs.readFileString(files.historyFile)).toContain(
            "update-1.0.99-20261111T090000000001Z.json",
          );
          // A changed receipt under a name already read is not read again.
          yield* fs.writeFileString(
            path.join(files.receiptsDirectory, "update-1.0.99-20261111T090000000001Z.json"),
            receipt("verified", { total: 99000 }),
          );
          const restarted = yield* ReleaseRuns.makeWithDirectory(files.runs, files);
          expect((yield* restarted.refreshInstalls).map((install) => install.totalMs)).toEqual([
            18000,
          ]);
        }),
    ),
  );

  it.effect("keeps a newer service's history as it is, and replaces a damaged one", () =>
    withReceipts(
      { "update-1.0.9-20261111T090000000001Z.json": receipt("verified", { total: 5000 }) },
      (files) =>
        Effect.gen(function* () {
          const fs = yield* FileSystem.FileSystem;
          const newer = '{"schemaVersion":2,"installs":[],"runs":[]}\n';
          yield* fs.writeFileString(files.historyFile, newer);
          const read = yield* (yield* ReleaseRuns.makeWithDirectory(files.runs, files))
            .refreshInstalls;
          expect(read.map((install) => install.version)).toEqual(["1.0.9"]);
          assert.strictEqual(yield* fs.readFileString(files.historyFile), newer);
          yield* fs.writeFileString(files.historyFile, '{"schemaVersion":1,"inst');
          yield* (yield* ReleaseRuns.makeWithDirectory(files.runs, files)).refreshInstalls;
          expect(yield* fs.readFileString(files.historyFile)).toContain('"version":"1.0.9"');
          assert.isFalse(yield* fs.exists(`${files.historyFile}.tmp`));
        }),
    ),
  );

  it.live("stops every receipt read when the service's scope closes", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      for (let round = 0; round < 6; round++) {
        const base = yield* fs.makeTempDirectory({ prefix: "installs-close-" });
        const updates = path.join(base, "updates");
        const files = {
          runs: path.join(updates, "runs"),
          receiptsDirectory: path.join(updates, "receipts"),
          historyFile: path.join(updates, ReleaseRuns.INSTALL_HISTORY_FILE),
        };
        yield* fs.makeDirectory(files.receiptsDirectory, { recursive: true });
        yield* Effect.forEach(
          Array.from({ length: 200 }, (_, index) => index),
          (index) =>
            fs.writeFileString(
              path.join(
                files.receiptsDirectory,
                `update-1.0.${index}-202611${String((index % 28) + 1).padStart(2, "0")}T${String(index).padStart(6, "0")}Z.json`,
              ),
              receipt("verified", { total: 1000 + index }),
            ),
          { concurrency: 16, discard: true },
        );
        const scope = yield* Scope.make();
        const service = yield* ReleaseRuns.makeWithDirectory(files.runs, files).pipe(
          Scope.provide(scope),
        );
        assert.deepStrictEqual((yield* service.list()).installs, []);
        yield* Scope.close(scope, Exit.void);
        // Closing the scope already waited for the read: nothing is left running, so the
        // wait ends at once instead of on a read still going through the receipts.
        const settled = yield* service.awaitBackgroundScan.pipe(Effect.timeoutOption("0 millis"));
        assert.isTrue(Option.isSome(settled));
        assert.isFalse(yield* fs.exists(`${files.historyFile}.tmp`));
        yield* fs.remove(base, { recursive: true });
        assert.isFalse(yield* fs.exists(base));
      }
    }).pipe(Effect.provide(NodeServices.layer)),
  );

  it("orders receipts by their time, not by the version in the name", () => {
    expect(
      ReleaseRuns.newestReceiptsFirst([
        "update-1.0.99-20261101T090000Z.json",
        "update-1.0.258-20261112T090000123456Z.json",
        "update-1.0.100-20261105T090000Z.json",
      ]),
    ).toEqual([
      "update-1.0.258-20261112T090000123456Z.json",
      "update-1.0.100-20261105T090000Z.json",
      "update-1.0.99-20261101T090000Z.json",
    ]);
  });

  it("parses only update receipts of verified installs", () => {
    const verified = receipt("verified", { total: 5000, odd: -1, alsoOdd: 1.5 });
    assert.isTrue(
      Option.isSome(
        ReleaseRuns.parseInstallReceipt("update-1.0.9-20261110T101500Z.json", verified),
      ),
    );
    expect(
      Option.getOrThrow(
        ReleaseRuns.parseInstallReceipt("update-1.0.9-rc.1-20261110T101500Z.json", verified),
      ),
    ).toEqual({ version: "1.0.9-rc.1", installedAt: "2026-11-10T10:15:00.000Z", totalMs: 5000 });
    assert.isTrue(Option.isNone(ReleaseRuns.parseInstallReceipt("update-1.0.9.json", verified)));
    assert.isTrue(
      Option.isNone(
        ReleaseRuns.parseInstallReceipt(
          "update-1.0.9-20261110T101500Z.json",
          receipt("verified", { total: 0 }),
        ),
      ),
    );
  });
});
