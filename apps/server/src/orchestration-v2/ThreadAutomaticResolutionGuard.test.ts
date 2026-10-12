import { describe, expect, it } from "@effect/vitest";
import {
  DEFAULT_SERVER_SETTINGS,
  ProjectId,
  ServerSettingsError,
} from "@specweave-studio/contracts";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Ref from "effect/Ref";
import * as ServerSettings from "../serverSettings.ts";
import {
  makeAutomaticResolutionGuard,
  canAutomaticallyResolve,
} from "./ThreadAutomaticResolutionGuard.ts";

const now = DateTime.makeUnsafe("2026-10-08T12:00:00Z");
const thread = {
  projectId: ProjectId.make("project"),
  updatedAt: now,
  settledOverride: null,
  archivedAt: null,
  deletedAt: null,
  pinnedAt: null,
  autoSettleDisabledAt: null,
};
const input = { thread, snapshotAt: now, snapshotSequence: 10, currentSequence: 10 };

describe("automatic resolution command guard", () => {
  it("compares event versions even when timestamps are identical", () => {
    expect(canAutomaticallyResolve(input)).toBe(true);
    expect(canAutomaticallyResolve({ ...input, currentSequence: 11 })).toBe(false);
    expect(
      canAutomaticallyResolve({
        ...input,
        snapshotAt: DateTime.makeUnsafe(DateTime.toEpochMillis(now) - 1),
      }),
    ).toBe(false);
  });
  it.each([undefined, -1, Number.NaN, Number.POSITIVE_INFINITY, 1.5])(
    "fails closed for a missing or invalid sequence %s",
    (sequence) => {
      expect(canAutomaticallyResolve({ ...input, snapshotSequence: sequence as number })).toBe(
        false,
      );
    },
  );
  it.each([
    { pinnedAt: now },
    { autoSettleDisabledAt: now },
    { archivedAt: now },
    { deletedAt: now },
    { settledOverride: "active" as const },
    { settledOverride: "settled" as const },
  ])("honors current user state independently of the timestamp: %j", (patch) => {
    expect(canAutomaticallyResolve({ ...input, thread: { ...thread, ...patch } })).toBe(false);
  });
  it.effect("honors the current effective project preference", () =>
    Effect.gen(function* () {
      const allowed = (settings: typeof DEFAULT_SERVER_SETTINGS) =>
        makeAutomaticResolutionGuard.pipe(
          Effect.flatMap((guard) => guard(input)),
          Effect.provide(
            Layer.mock(ServerSettings.ServerSettingsService)({
              getSettings: Effect.succeed(settings),
            }),
          ),
        );
      expect(yield* allowed(DEFAULT_SERVER_SETTINGS)).toBe(true);
      expect(yield* allowed({ ...DEFAULT_SERVER_SETTINGS, sidebarAutoSettleOnMerge: false })).toBe(
        false,
      );
      expect(
        yield* allowed({
          ...DEFAULT_SERVER_SETTINGS,
          projectSettingsOverrides: { [thread.projectId]: { sidebarAutoSettleOnMerge: false } },
        }),
      ).toBe(false);
      expect(
        yield* allowed({
          ...DEFAULT_SERVER_SETTINGS,
          sidebarAutoSettleOnMerge: false,
          projectSettingsOverrides: { [thread.projectId]: { sidebarAutoSettleOnMerge: true } },
        }),
      ).toBe(true);
    }),
  );
  it.effect("reads preference changes after construction and fails closed on read errors", () =>
    Effect.gen(function* () {
      const settings = yield* Ref.make(DEFAULT_SERVER_SETTINGS);
      const guard = yield* makeAutomaticResolutionGuard.pipe(
        Effect.provide(
          Layer.mock(ServerSettings.ServerSettingsService)({
            getSettings: Ref.get(settings),
          }),
        ),
      );
      expect(yield* guard(input)).toBe(true);
      yield* Ref.set(settings, { ...DEFAULT_SERVER_SETTINGS, sidebarAutoSettleOnMerge: false });
      expect(yield* guard(input)).toBe(false);
      const unavailable = yield* makeAutomaticResolutionGuard.pipe(
        Effect.provide(
          Layer.mock(ServerSettings.ServerSettingsService)({
            getSettings: Effect.fail(
              new ServerSettingsError({
                settingsPath: "/test/settings.json",
                operation: "read-file",
              }),
            ),
          }),
        ),
      );
      expect(yield* unavailable(input)).toBe(false);
      expect(yield* guard({ ...input, currentSequence: 11 })).toBe(false);
    }),
  );
});
