// @effect-diagnostics nodeBuiltinImport:off globalTimers:off globalDate:off - disposable state folders and a source on a fake clock.
import * as NodeFS from "node:fs";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { afterEach, describe, expect, it } from "@effect/vitest";
import { ProjectId } from "@specweave-studio/contracts";
import * as Clock from "effect/Clock";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Logger from "effect/Logger";

import * as FolderWork from "./folderWork.ts";
import { SourceTransfers } from "./sourceService.ts";

const folders: Array<string> = [];
afterEach(() => {
  for (const folder of folders.splice(0)) NodeFS.rmSync(folder, { recursive: true, force: true });
});
const operationId = "00000000-0000-4000-8000-000000000993";

const tempState = () => {
  const base = NodeFS.realpathSync(
    NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "swc-folder-work-")),
  );
  folders.push(base);
  const folder = NodePath.join(base, "project");
  NodeFS.mkdirSync(folder);
  NodeFS.writeFileSync(NodePath.join(folder, "notes.txt"), "notes\n");
  return { base, folder, state: NodePath.join(base, "state") };
};

describe("which source copies hold an update back", () => {
  it("counts measuring and pulling, never an offer nobody pulls or a held copy's keepalive", async () => {
    const { folder, state } = tempState();
    let clock = 1_000_000;
    const sources = new SourceTransfers(state, { now: () => clock });
    const offered = await sources.offer({
      operationId,
      projectId: ProjectId.make("source-project"),
      folder,
      mode: "copy-only",
      destinationEnvironmentId: "destination",
    });
    const active = () => sources.activeOperations(FolderWork.SOURCE_RECENT_MS);
    // Measuring counts while it runs.
    expect(active()).toEqual([{ operationId, state: "scanning" }]);
    for (let attempt = 0; attempt < 400; attempt += 1) {
      if ((await sources.read(operationId))?.state === "scanned" && active().length === 0) break;
      await new Promise((resolve) => setTimeout(resolve, 5));
    }
    // Measured, and no destination asked for it yet: nothing to wait for.
    expect((await sources.read(operationId))?.state).toBe("scanned");
    expect(active()).toEqual([]);
    // A destination pulling it.
    await sources.authorize(operationId, offered.token);
    expect(active()).toEqual([{ operationId, state: "scanned" }]);
    clock += FolderWork.SOURCE_RECENT_MS - 1_000;
    expect(active()).toHaveLength(1);
    // Abandoned: no pull since, so it no longer counts whatever its state says.
    clock += 2_000;
    expect(active()).toEqual([]);
    // A held copy's hourly keepalive is not a pull.
    await sources.authorize(operationId, offered.token, "hello");
    expect(active()).toEqual([]);
    // Ended copies never count, however recently pulled.
    await sources.authorize(operationId, offered.token);
    await sources.cancel(operationId, "stopped");
    expect(active()).toEqual([]);
    await sources.close();
  });
});

describe("folder work in flight", () => {
  it.effect("lists what each handoff service registered, until its scope closes", () =>
    Effect.gen(function* () {
      const activity = yield* FolderWork.make;
      const items: Array<FolderWork.FolderWorkItem> = [
        { operationId: "a", role: "destination", state: "transferring" },
      ];
      yield* Effect.scoped(
        Effect.gen(function* () {
          yield* activity.register(Effect.sync(() => items));
          yield* activity.register(
            Effect.succeed([{ operationId: "a", role: "move" as const, state: "transferring" }]),
          );
          const inFlight = yield* activity.inFlight;
          expect(inFlight).toHaveLength(2);
          // One operation, whichever sides of it run here.
          expect(FolderWork.countOperations(inFlight)).toBe(1);
        }),
      );
      expect(yield* activity.inFlight).toEqual([]);
    }),
  );

  it("counts a coordinator fence only for a live copy or for a while after it was written", () => {
    const now = Date.parse("2026-10-29T12:00:00.000Z");
    const fenced = [
      { operationId: "live", updatedAt: "2026-10-28T09:00:00.000Z" },
      { operationId: "recent", updatedAt: "2026-10-29T11:55:00.000Z" },
      // Left behind by a crash a day ago, with no copy behind it.
      { operationId: "stale", updatedAt: "2026-10-28T09:00:00.000Z" },
      { operationId: "undated", updatedAt: null },
      { operationId: null, updatedAt: "2026-10-29T11:59:00.000Z" },
    ];
    expect(
      FolderWork.liveMoves(fenced, new Set(["live"]), now).map((item) => item.operationId),
    ).toEqual(["live", "recent"]);
  });

  it.effect(
    "probes both halves and the fences, and reads a failed destination list as nothing",
    () =>
      Effect.gen(function* () {
        const items = yield* FolderWork.handoffProbe({
          sources: { activeOperations: () => [{ operationId: "s1", state: "ready" }] },
          destinations: { activeOperations: () => Promise.reject(new Error("unreadable")) },
          fenced: Effect.succeed([{ operationId: "s1", updatedAt: null }]),
        });
        expect(items).toEqual([
          { operationId: "s1", role: "source", state: "ready" },
          { operationId: "s1", role: "move", state: "transferring" },
        ]);
      }),
  );

  it.live("keeps the helper's file while copies run and removes it once none do", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const { base } = tempState();
      const file = NodePath.join(base, "updates", FolderWork.HEARTBEAT_FILE);
      NodeFS.mkdirSync(NodePath.dirname(file));
      // Left by an earlier process.
      NodeFS.writeFileSync(file, "{}");
      const activity = yield* FolderWork.make;
      const items: Array<FolderWork.FolderWorkItem> = [];
      yield* activity.register(Effect.sync(() => items));
      const waitFor = (present: boolean) =>
        Effect.gen(function* () {
          for (let attempt = 0; attempt < 200; attempt += 1) {
            if ((yield* fs.exists(file)) === present) return;
            yield* Effect.sleep("5 millis");
          }
          throw new Error(`the heartbeat file never became ${present ? "present" : "absent"}`);
        });
      yield* Effect.scoped(
        Effect.gen(function* () {
          yield* FolderWork.keepHeartbeat(activity, file, 10);
          yield* waitFor(false);
          items.push({ operationId: "a", role: "source", state: "ready" });
          yield* waitFor(true);
          const written = JSON.parse(NodeFS.readFileSync(file, "utf8"));
          expect(written).toMatchObject({ schemaVersion: 1, operations: 1 });
          expect(Date.parse(written.until) - Date.parse(written.at)).toBe(
            FolderWork.HEARTBEAT_TTL_MS,
          );
          items.length = 0;
          yield* waitFor(false);
          items.push({ operationId: "a", role: "source", state: "ready" });
          yield* waitFor(true);
        }),
      );
      // A service that stops removes it.
      expect(yield* fs.exists(file)).toBe(false);
    }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
  );

  it.live("writes a copy that starts at the next look, not at the next refresh", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const { base } = tempState();
      const file = NodePath.join(base, "updates", FolderWork.HEARTBEAT_FILE);
      const activity = yield* FolderWork.make;
      const items: Array<FolderWork.FolderWorkItem> = [];
      yield* activity.register(Effect.sync(() => items));
      const operations = (count: number) =>
        Effect.gen(function* () {
          for (let attempt = 0; attempt < 200; attempt += 1) {
            const text = yield* fs.readFileString(file).pipe(Effect.orElseSucceed(() => ""));
            if (FolderWork.heartbeatOperations(text, yield* Clock.currentTimeMillis) === count)
              return;
            yield* Effect.sleep("5 millis");
          }
          throw new Error(`the heartbeat never reported ${count} operations`);
        });
      // Refreshed every minute, looked at every 10 ms: an install that reads the file right
      // after a copy began must not find it missing for up to a refresh.
      yield* FolderWork.keepHeartbeat(activity, file, 60_000, 10);
      yield* Effect.sleep("30 millis");
      items.push({ operationId: "a", role: "destination", state: "transferring" });
      yield* operations(1);
      items.push({ operationId: "b", role: "source", state: "ready" });
      yield* operations(2);
      items.length = 0;
      yield* operations(0);
      expect(yield* fs.exists(file)).toBe(false);
    }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
  );

  it.live("warns once when the heartbeat cannot be written, and again after it recovers", () =>
    Effect.gen(function* () {
      const { base } = tempState();
      // Its folder is a file, so no write can succeed.
      const blocker = NodePath.join(base, "updates");
      NodeFS.writeFileSync(blocker, "");
      const file = NodePath.join(blocker, FolderWork.HEARTBEAT_FILE);
      const activity = yield* FolderWork.make;
      yield* activity.register(
        Effect.succeed([{ operationId: "a", role: "source", state: "ready" } as const]),
      );
      const warnings: Array<string> = [];
      const logger = Logger.make<unknown, void>(({ message }) => warnings.push(String(message)));
      const warned = () =>
        warnings.filter((warning) => warning.includes("heartbeat could not be written")).length;
      const waitUntil = (done: () => boolean) =>
        Effect.gen(function* () {
          for (let attempt = 0; attempt < 200 && !done(); attempt += 1) {
            yield* Effect.sleep("5 millis");
          }
        });
      yield* Effect.scoped(
        Effect.gen(function* () {
          yield* FolderWork.keepHeartbeat(activity, file, 10, 5);
          yield* waitUntil(() => warned() > 0);
          // Many failed looks, one warning.
          yield* Effect.sleep("60 millis");
          expect(warned()).toBe(1);
          NodeFS.rmSync(blocker);
          yield* waitUntil(() => NodeFS.existsSync(file));
          expect(NodeFS.existsSync(file)).toBe(true);
          NodeFS.rmSync(blocker, { recursive: true });
          NodeFS.writeFileSync(blocker, "");
          yield* waitUntil(() => warned() > 1);
          expect(warned()).toBe(2);
        }),
      ).pipe(Effect.provideService(Logger.CurrentLoggers, new Set([logger])));
    }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
  );

  it("reads the heartbeat as the macOS helper does", () => {
    const now = Date.parse("2026-10-29T10:00:00.000Z");
    const text = (operations: unknown, until: string, schemaVersion = 1) =>
      JSON.stringify({ schemaVersion, operations, until });
    expect(FolderWork.heartbeatOperations(text(2, "2026-10-29T10:00:50.000Z"), now)).toBe(2);
    expect(
      FolderWork.heartbeatOperations(
        `${JSON.stringify(FolderWork.heartbeatOf(3, now - 5_000))}\n`,
        now,
      ),
    ).toBe(3);
    // Its service stopped writing it, it is dated further ahead than one write lasts, or it is unreadable.
    for (const stale of [
      text(2, "2026-10-29T09:59:59.000Z"),
      text(2, "2026-10-29T10:10:00.000Z"),
      text(0, "2026-10-29T10:00:50.000Z"),
      text(1.5, "2026-10-29T10:00:50.000Z"),
      text(2, "2026-10-29T10:00:50.000Z", 2),
      text(2, "soon"),
      '{"schemaVersion": 1, "operat',
      "null",
    ])
      expect(FolderWork.heartbeatOperations(stale, now)).toBe(0);
  });
});
