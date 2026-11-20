/**
 * The wake hold keeps worker threads the intent named, not only coordinators
 * (1267 #13): the gate refuses them with their own text, and releasing them
 * leaves the coordinators held. A hold file that does not read holds
 * everything until it reads or a person runs the work here anyway (1390 AC-36).
 */
import * as NodeCrypto from "@effect/platform-node/NodeCrypto";
import {
  AWAY_FORCE_LOCAL_AFTER_MS,
  AWAY_INTENT_CANCEL_PATH,
  AWAY_INTENT_STATUS_PATH,
  type AwayConfig,
  EnvironmentId,
} from "@specweave-studio/contracts";
import { describe, expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Path from "effect/Path";
import * as TestClock from "effect/testing/TestClock";

import * as ServerConfig from "../config.ts";
import type { AwayPeerPost } from "./awayPeerCall.ts";
import { makeAwaySleep, memorySleepStore } from "./awaySleepRoute.ts";
import {
  AWAY_THREAD_HOLD_REFUSAL,
  awayHoldRefusal,
  COORDINATOR_AWAY_HOLD_REFUSAL,
  heldThread,
  makeFileWakeHoldStore,
  releaseProjects,
  releaseThreads,
  type AwayWakeHoldRecord,
} from "./AwayWakeHold.ts";

const hold: AwayWakeHoldRecord = {
  version: 1,
  targetEnvironmentId: "ministorm",
  since: "2026-11-09T22:00:00.000Z",
  projects: [{ projectId: "p1", threadIds: ["project-coordinator:p1"] }],
  threads: ["t1", "t2"],
};

describe("the wake hold for worker threads (#13)", () => {
  it("refuses held workers with their own text, coordinators with theirs", () => {
    expect(awayHoldRefusal(hold, "project-coordinator:p1")).toBe(COORDINATOR_AWAY_HOLD_REFUSAL);
    expect(awayHoldRefusal(hold, "t1")).toBe(AWAY_THREAD_HOLD_REFUSAL);
    expect(awayHoldRefusal(hold, "t9")).toBeNull();
    expect(heldThread(hold, "t2")).toBe(true);
  });

  it("releases threads and projects apart; null only once nothing is held", () => {
    const noThreads = releaseThreads(hold, ["t1", "t2"]);
    expect(noThreads).toMatchObject({ projects: hold.projects });
    expect(noThreads?.threads).toBeUndefined();
    expect(releaseProjects(noThreads, ["p1"])).toBeNull();
    const onlyThreads = releaseProjects(hold, ["p1"]);
    expect(onlyThreads).toMatchObject({ projects: [], threads: ["t1", "t2"] });
    expect(releaseThreads(onlyThreads, ["t1"])).toMatchObject({ threads: ["t2"] });
    expect(releaseThreads(onlyThreads, ["t1", "t2"])).toBeNull();
  });
});

const HOLD_FILE = "/state/away-wake-hold.json";

/** The live hold store over `contents`, the hold file a lid close left. */
const fileHold = (contents: string) =>
  Effect.gen(function* () {
    const files = new Map<string, string>([[HOLD_FILE, contents]]);
    const store = yield* makeFileWakeHoldStore.pipe(
      Effect.provide(
        Layer.mergeAll(
          FileSystem.layerNoop({
            exists: (path) => Effect.sync(() => files.has(path)),
            readFileString: (path) => Effect.sync(() => files.get(path) ?? ""),
            writeFileString: (path, data) => Effect.sync(() => void files.set(path, data)),
            rename: (from, to) =>
              Effect.sync(() => {
                files.set(to, files.get(from) ?? "");
                files.delete(from);
              }),
            remove: (path) => Effect.sync(() => void files.delete(path)),
            makeDirectory: () => Effect.void,
          }),
          Path.layer,
          NodeCrypto.layer,
          Layer.succeed(ServerConfig.ServerConfig, {
            stateDir: "/state",
          } as unknown as ServerConfig.ServerConfig["Service"]),
        ),
      ),
    );
    return { store, file: () => files.get(HOLD_FILE) };
  });

describe("a hold file that does not read", () => {
  it.effect("holds every thread, and the wake check neither asks nor lets anything go", () =>
    Effect.gen(function* () {
      const T0 = Date.parse("2026-11-09T22:00:00.000Z");
      yield* TestClock.setTime(T0);
      const cut = '{"version":1,"targetEnvironmentId":"ministorm","since":';
      const f = yield* fileHold(cut);
      // Read first on a restart: which work it names is unknown, so nothing starts a turn.
      const read = yield* f.store.read;
      expect(awayHoldRefusal(read, "project-coordinator:p1")).not.toBeNull();
      expect(awayHoldRefusal(read, "thread-reel")).not.toBeNull();
      // The target answers that it acted and holds nothing of this machine's.
      const sent: string[] = [];
      const post: AwayPeerPost = (_target, path) =>
        Effect.sync(() => {
          sent.push(path);
          return {
            status: 200,
            json:
              path === AWAY_INTENT_CANCEL_PATH
                ? { cancelled: 0, state: "done", takenOver: [] }
                : path === AWAY_INTENT_STATUS_PATH
                  ? { intentState: "done", projects: [], receivedAt: "2026-11-09T22:10:00.000Z" }
                  : {},
          };
        });
      const session = memorySleepStore({
        state: "pending-intent",
        targetEnvironmentId: EnvironmentId.make("ministorm"),
        graceMinutes: 2,
        projectIds: [],
        threadIds: [],
        sentAt: "2026-11-09T21:50:00.000Z",
        dueAt: "2026-11-09T21:52:00.000Z",
      });
      const away = yield* makeAwaySleep({
        self: EnvironmentId.make("m4"),
        store: session,
        hold: f.store,
        config: Effect.succeed<AwayConfig>({
          target: EnvironmentId.make("ministorm"),
          sleepTrigger: "off",
          graceMinutes: 2,
          bringBack: "prompt",
          coordinatorScope: "live",
        }),
        post,
      });
      expect(yield* away.wake({ onBattery: true })).toEqual({ outcome: "none" });
      // The file stays as it was, so the hold stays; the session waits for an answer.
      expect(f.file()).toBe(cut);
      expect(sent).toEqual([]);
      expect(session.current()?.state).toBe("pending-intent");
      expect(awayHoldRefusal(yield* f.store.read, "thread-reel")).not.toBeNull();
      // A person can still run the work here once the wait for an answer ran out.
      yield* TestClock.adjust(AWAY_FORCE_LOCAL_AFTER_MS + 60_000);
      expect(yield* away.forceLocal).toMatchObject({ ok: true });
      expect(f.file()).toBeUndefined();
      expect(yield* f.store.read).toBeNull();
    }),
  );

  it.effect("a lid close the target refused is not settled over it: the hold stays", () =>
    Effect.gen(function* () {
      yield* TestClock.setTime(Date.parse("2026-11-09T22:00:00.000Z"));
      const cut = '{"version":1,"targetEnvironmentId":"ministorm","since":';
      const f = yield* fileHold(cut);
      const sent: string[] = [];
      const post: AwayPeerPost = (_target, path) =>
        Effect.sync(() => {
          sent.push(path);
          return { status: 200, json: {} };
        });
      // The refusal proves only that this intent moved nothing, not what the hold names.
      const session = memorySleepStore({
        state: "send-failed",
        targetEnvironmentId: EnvironmentId.make("ministorm"),
        graceMinutes: 2,
        projectIds: [],
        threadIds: [],
        sentAt: "2026-11-09T21:50:00.000Z",
        dueAt: "2026-11-09T21:52:00.000Z",
        detail: "Work stayed here: Ministorm refused the request.",
      });
      const away = yield* makeAwaySleep({
        self: EnvironmentId.make("m4"),
        store: session,
        hold: f.store,
        config: Effect.succeed<AwayConfig>({
          target: EnvironmentId.make("ministorm"),
          sleepTrigger: "off",
          graceMinutes: 2,
          bringBack: "prompt",
          coordinatorScope: "live",
        }),
        post,
      });
      expect(yield* away.wake({ onBattery: true })).toEqual({ outcome: "none" });
      expect(f.file()).toBe(cut);
      expect(sent).toEqual([]);
      expect(session.current()?.state).toBe("send-failed");
      expect(awayHoldRefusal(yield* f.store.read, "thread-reel")).not.toBeNull();
      // The retry leaves it as it is too; a person can still run the work here.
      expect(yield* away.retry).toBe("unresolved");
      expect(f.file()).toBe(cut);
      yield* TestClock.adjust(AWAY_FORCE_LOCAL_AFTER_MS + 60_000);
      expect(yield* away.forceLocal).toMatchObject({ ok: true });
      expect(f.file()).toBeUndefined();
    }),
  );
});
