import * as NodeOS from "node:os";

import { assert, describe, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Context from "effect/Context";
import * as Layer from "effect/Layer";
import * as Logger from "effect/Logger";
import * as Option from "effect/Option";
import * as TestClock from "effect/testing/TestClock";

import * as ServerConfig from "../config.ts";
import * as DiskSpaceMonitor from "./DiskSpaceMonitor.ts";

const GIB = 1024 ** 3;
const TOTAL = 994 * GIB;

const layerConfig = Layer.succeed(
  ServerConfig.ServerConfig,
  // The monitor reads only where the app keeps its data.
  { stateDir: "/studio/userdata" } as unknown as ServerConfig.ServerConfig["Service"],
);

/** Builds the monitor over `readings`, one per check; the last one repeats. */
const buildMonitor = (readings: Array<number | "fail">, paths: Array<string> = []) => {
  const next = () => (readings.length > 1 ? readings.shift()! : readings[0]!);
  return Layer.build(
    DiskSpaceMonitor.layerWith((path) => {
      paths.push(path);
      const reading = next();
      return reading === "fail"
        ? Effect.fail(new DiskSpaceMonitor.DiskSpaceReadError({ path, cause: "EIO" }))
        : Effect.succeed({ freeBytes: reading, totalBytes: TOTAL });
    }).pipe(Layer.provide(layerConfig)),
  ).pipe(Effect.map((context) => Context.get(context, DiskSpaceMonitor.DiskSpaceMonitor)));
};

const levelOf = (monitor: DiskSpaceMonitor.DiskSpaceMonitor["Service"]) =>
  monitor.current.pipe(Effect.map(Option.map((status) => status.level)));

describe("DiskSpaceMonitor", () => {
  it.effect("checks the data folder at start and every minute, with one log per change", () => {
    const logs: Array<{ level: string; message: string }> = [];
    const logger = Logger.make(({ logLevel, message }) => {
      logs.push({ level: logLevel, message: String(message) });
    });
    return Effect.gen(function* () {
      const paths: Array<string> = [];
      const monitor = yield* buildMonitor(
        [20 * GIB, 4 * GIB, 3.5 * GIB, 0.5 * GIB, 5.5 * GIB, 7 * GIB],
        paths,
      );
      // The first check lands before the layer finishes building.
      assert.deepStrictEqual(yield* levelOf(monitor), Option.some("ok" as const));
      const first = Option.getOrThrow(yield* monitor.current);
      assert.strictEqual(first.freeBytes, 20 * GIB);
      assert.strictEqual(first.totalBytes, TOTAL);
      assert.strictEqual(first.checkedAt, "1970-01-01T00:00:00.000Z");

      const levels: Array<string> = [];
      for (let minute = 0; minute < 5; minute += 1) {
        yield* TestClock.adjust("60 seconds");
        levels.push(Option.getOrThrow(yield* levelOf(monitor)));
      }
      // 5.5 GiB is above the low line but not above the clearing line.
      assert.deepStrictEqual(levels, ["low", "low", "critical", "low", "ok"]);
      assert.deepStrictEqual(
        paths,
        Array.from({ length: 6 }, () => "/studio/userdata"),
      );
      assert.deepStrictEqual(logs, [
        { level: "Warn", message: "disk space is low: 4.3 GB free" },
        { level: "Warn", message: "disk space is critical: 537 MB free" },
        { level: "Warn", message: "disk space is low: 5.9 GB free" },
        { level: "Info", message: "disk space recovered: 7.5 GB free" },
      ]);
    }).pipe(Effect.scoped, Effect.provide(Logger.layer([logger], { mergeWithExisting: false })));
  });

  it.effect("keeps the last status when a check fails", () =>
    Effect.gen(function* () {
      const monitor = yield* buildMonitor([3 * GIB, "fail", 4 * GIB]);
      assert.deepStrictEqual(yield* levelOf(monitor), Option.some("low" as const));
      yield* TestClock.adjust("60 seconds");
      const status = Option.getOrThrow(yield* monitor.current);
      assert.strictEqual(status.level, "low");
      assert.strictEqual(status.freeBytes, 3 * GIB);
      yield* TestClock.adjust("60 seconds");
      assert.strictEqual(Option.getOrThrow(yield* monitor.current).freeBytes, 4 * GIB);
    }).pipe(Effect.scoped),
  );

  it.effect("reports nothing until a check succeeds", () =>
    Effect.gen(function* () {
      const monitor = yield* buildMonitor(["fail", 2 * GIB]);
      assert.deepStrictEqual(yield* monitor.current, Option.none());
      yield* TestClock.adjust("60 seconds");
      assert.deepStrictEqual(yield* levelOf(monitor), Option.some("low" as const));
    }).pipe(Effect.scoped),
  );

  it.effect("reads this machine's disk through statfs", () =>
    Effect.gen(function* () {
      const context = yield* Layer.build(
        DiskSpaceMonitor.layer.pipe(
          Layer.provide(
            Layer.succeed(ServerConfig.ServerConfig, {
              stateDir: NodeOS.tmpdir(),
            } as unknown as ServerConfig.ServerConfig["Service"]),
          ),
        ),
      );
      const status = Option.getOrThrow(
        yield* Context.get(context, DiskSpaceMonitor.DiskSpaceMonitor).current,
      );
      assert.isAbove(status.totalBytes, 0);
      assert.isAtMost(status.freeBytes, status.totalBytes);
    }).pipe(Effect.scoped),
  );

  // Decimal units, as the banner shows them.
  it("raises under 5 GB and 1 GB, and clears to ok only above 6 GB", () => {
    assert.strictEqual(DiskSpaceMonitor.storageLevel("ok", 5.5e9), "ok");
    assert.strictEqual(DiskSpaceMonitor.storageLevel("low", 5.5e9), "low");
    assert.strictEqual(DiskSpaceMonitor.storageLevel("critical", 5.5e9), "low");
    assert.strictEqual(DiskSpaceMonitor.storageLevel("low", 6e9 + 1), "ok");
    assert.strictEqual(DiskSpaceMonitor.storageLevel("ok", 5e9), "ok");
    assert.strictEqual(DiskSpaceMonitor.storageLevel("ok", 5e9 - 1), "low");
    assert.strictEqual(DiskSpaceMonitor.storageLevel("ok", 1e9), "low");
    assert.strictEqual(DiskSpaceMonitor.storageLevel("ok", 1e9 - 1), "critical");
  });

  it("clears critical only above 1.5 GB, so a disk hovering at 1 GB stays critical", () => {
    const hovering = [0.98e9, 1.02e9, 0.99e9, 1.1e9, 1.49e9, 1.5e9];
    const levels: Array<string> = [];
    let level: "ok" | "low" | "critical" = "low";
    for (const freeBytes of hovering) {
      level = DiskSpaceMonitor.storageLevel(level, freeBytes);
      levels.push(level);
    }
    assert.deepStrictEqual(
      levels,
      Array.from(hovering, () => "critical"),
    );
    assert.strictEqual(DiskSpaceMonitor.storageLevel("critical", 1.5e9 + 1), "low");
    assert.strictEqual(DiskSpaceMonitor.storageLevel("low", 1.2e9), "low");
  });

  it("caps statfs readings past 2^53 so the config still encodes", () => {
    const reading = DiskSpaceMonitor.readingFromStatfs({
      bavail: 2n ** 51n,
      blocks: 2n ** 52n,
      bsize: 4_096n,
    });
    assert.strictEqual(reading.freeBytes, Number.MAX_SAFE_INTEGER);
    assert.strictEqual(reading.totalBytes, Number.MAX_SAFE_INTEGER);
    assert.deepStrictEqual(
      DiskSpaceMonitor.readingFromStatfs({ bavail: 1_000n, blocks: 4_000n, bsize: 4_096n }),
      { freeBytes: 4_096_000, totalBytes: 16_384_000 },
    );
  });

  it("treats checks that read the same to a person as the same report", () => {
    const status = (level: "ok" | "low", freeBytes: number) => ({
      level,
      freeBytes,
      totalBytes: TOTAL,
      checkedAt: "2026-10-18T12:00:00.000Z",
    });
    assert.isTrue(
      DiskSpaceMonitor.sameStorageReport(status("ok", 80 * GIB), status("ok", 60 * GIB)),
    );
    assert.isTrue(
      DiskSpaceMonitor.sameStorageReport(
        status("low", 3_210_000_000),
        status("low", 3_240_000_000),
      ),
    );
    assert.isFalse(
      DiskSpaceMonitor.sameStorageReport(
        status("low", 3_210_000_000),
        status("low", 3_100_000_000),
      ),
    );
    assert.isFalse(
      DiskSpaceMonitor.sameStorageReport(status("ok", 5.5 * GIB), status("low", 5.5 * GIB)),
    );
    // Under 1 GB the shown figure moves by the megabyte; a resend needs 50 MB.
    assert.isTrue(
      DiskSpaceMonitor.sameStorageReport(status("low", 640_000_000), status("low", 601_000_000)),
    );
    assert.isFalse(
      DiskSpaceMonitor.sameStorageReport(status("low", 640_000_000), status("low", 589_000_000)),
    );
  });
});
