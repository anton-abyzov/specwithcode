import {
  ComputerUseAction,
  ComputerUseActionResult,
  ComputerUsePermission,
  ComputerUsePermissions,
} from "@specweave-studio/contracts";
import * as Electron from "electron";
import * as Clock from "effect/Clock";
import * as Data from "effect/Data";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";
import * as Random from "effect/Random";
import * as Schema from "effect/Schema";

import * as DesktopEnvironment from "../../app/DesktopEnvironment.ts";
import * as DesktopLifecycle from "../../app/DesktopLifecycle.ts";
import {
  currentPermissions,
  requestPermission,
  resetPermission,
  runComputerUseAction,
} from "../../computerUse/MacComputerUse.ts";
import type { MacPermission } from "../../permissions/MacPermission.ts";
import * as MacPermissions from "../../permissions/MacPermissions.ts";
import {
  GET_COMPUTER_USE_PERMISSIONS_CHANNEL,
  RELAUNCH_FOR_COMPUTER_USE_CHANNEL,
  REQUEST_COMPUTER_USE_PERMISSION_CHANNEL,
  RESET_COMPUTER_USE_PERMISSION_CHANNEL,
  RUN_COMPUTER_USE_ACTION_CHANNEL,
  SAVE_FIRST_RUN_RESUME_CHANNEL,
  TAKE_FIRST_RUN_RESUME_CHANNEL,
} from "../channels.ts";
import * as DesktopIpc from "../DesktopIpc.ts";

class ComputerUseRunFailed extends Data.TaggedError("ComputerUseRunFailed")<{
  readonly reason: string;
}> {}

/** Results cross IPC as values so the renderer sees the agent-facing message, never an Effect failure. */
const ComputerUseIpcResult = Schema.Union([
  Schema.Struct({ ok: Schema.Literal(true), result: ComputerUseActionResult }),
  Schema.Struct({ ok: Schema.Literal(false), error: Schema.String }),
]);

/** A failed reset reaches the card as a message, so it can offer the button again. */
const ComputerUseResetIpcResult = Schema.Union([
  Schema.Struct({ ok: Schema.Literal(true), permissions: ComputerUsePermissions }),
  Schema.Struct({ ok: Schema.Literal(false), error: Schema.String }),
]);

/** Where first-run setup reopens after Quit & Reopen: kept in the app's user-data folder. */
export const FIRST_RUN_RESUME_FILE = "first-run-resume.json";
/** An older marker is not a reopen any more, and setup starts as usual. */
export const FIRST_RUN_RESUME_MAX_AGE_MS = 10 * 60_000;

export const FirstRunResumeMarker = Schema.Struct({
  step: Schema.String.check(Schema.isMaxLength(32)),
  environmentId: Schema.String.check(Schema.isMaxLength(256)),
  setupIds: Schema.Array(Schema.String.check(Schema.isMaxLength(256))).check(
    Schema.isMaxLength(64),
  ),
  at: Schema.Number,
});
export type FirstRunResumeMarker = typeof FirstRunResumeMarker.Type;
const FirstRunResumeMarkerJson = Schema.fromJsonString(FirstRunResumeMarker);

/** Writes the marker whole (a temporary file renamed over it), so a reader never sees half. */
export const writeFirstRunResume = Effect.fn("desktop.firstRunResume.write")(function* (
  dir: string,
  marker: FirstRunResumeMarker,
) {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const file = path.join(dir, FIRST_RUN_RESUME_FILE);
  const temporary = `${file}.${process.pid}.tmp`;
  yield* fs.makeDirectory(dir, { recursive: true });
  const text = yield* Schema.encodeEffect(FirstRunResumeMarkerJson)(marker);
  yield* fs.writeFileString(temporary, text, { mode: 0o600 });
  yield* fs.rename(temporary, file);
});

/**
 * Claims the marker by renaming the file away before reading it, so of any
 * number of callers, in this process or the next, exactly one gets it. A
 * marker older than ten minutes, from the future, or unreadable is deleted
 * and returns nothing.
 */
export const takeFirstRunResume = Effect.fn("desktop.firstRunResume.take")(function* (
  dir: string,
  now: number,
) {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const file = path.join(dir, FIRST_RUN_RESUME_FILE);
  const claimed = `${file}.${process.pid}-${yield* Random.nextIntBetween(0, 2 ** 31)}.taken`;
  const renamed = yield* fs.rename(file, claimed).pipe(
    Effect.as(true),
    Effect.orElseSucceed(() => false),
  );
  if (!renamed) return null;
  const marker = yield* fs.readFileString(claimed).pipe(
    Effect.flatMap(Schema.decodeEffect(FirstRunResumeMarkerJson)),
    Effect.orElseSucceed(() => null),
  );
  yield* fs.remove(claimed, { force: true }).pipe(Effect.ignore);
  if (marker === null) return null;
  const age = now - marker.at;
  return age >= 0 && age <= FIRST_RUN_RESUME_MAX_AGE_MS ? marker : null;
});

/**
 * Runs agents' computer-use actions in the app's main process: macOS grants
 * Screen Recording and Accessibility to the app, so its child processes may
 * capture the screen and post input where the background service may not.
 */
export const installComputerUse = Effect.fn("desktop.ipc.installComputerUse")(function* () {
  // The preload exposes the bridge on macOS only; other platforms have no runner yet.
  if ((yield* DesktopEnvironment.DesktopEnvironment).platform !== "darwin") return;
  const ipc = yield* DesktopIpc.DesktopIpc;
  const permissions = yield* MacPermissions.MacPermissions;
  const runPromise = Effect.runPromiseWith(yield* Effect.context<never>());
  // The drag-to-allow helper sits next to System Settings while the action waits.
  const showHelper = (permission: MacPermission) =>
    void runPromise(
      permissions.showHelper(permission, null, async () => {
        const current = await currentPermissions();
        return permission === "accessibility" ? current.accessibility : current.screenRecording;
      }),
    );
  yield* ipc.handle(
    DesktopIpc.makeIpcMethod({
      channel: RUN_COMPUTER_USE_ACTION_CHANNEL,
      payload: ComputerUseAction,
      result: ComputerUseIpcResult,
      handler: (action) =>
        Effect.tryPromise({
          try: () => runComputerUseAction(action, showHelper),
          catch: (error) =>
            new ComputerUseRunFailed({
              reason: error instanceof Error ? error.message : String(error),
            }),
        }).pipe(
          Effect.map((result) => ({ ok: true as const, result })),
          Effect.catch((error) =>
            Effect.gen(function* () {
              const message = error.reason;
              yield* Effect.logWarning("Computer use action failed", {
                kind: action.kind,
                message,
              });
              return { ok: false as const, error: message || "The action failed." };
            }),
          ),
        ),
    }),
  );
  yield* ipc.handle(
    DesktopIpc.makeIpcMethod({
      channel: GET_COMPUTER_USE_PERMISSIONS_CHANNEL,
      payload: Schema.Undefined,
      result: ComputerUsePermissions,
      handler: () => Effect.promise(currentPermissions),
    }),
  );
  yield* ipc.handle(
    DesktopIpc.makeIpcMethod({
      channel: REQUEST_COMPUTER_USE_PERMISSION_CHANNEL,
      payload: ComputerUsePermission,
      result: ComputerUsePermissions,
      handler: (permission) =>
        Effect.promise(() => requestPermission(permission, showHelper)).pipe(
          Effect.catchCause(() => Effect.promise(currentPermissions)),
        ),
    }),
  );
  yield* ipc.handle(
    DesktopIpc.makeIpcMethod({
      channel: RESET_COMPUTER_USE_PERMISSION_CHANNEL,
      payload: ComputerUsePermission,
      result: ComputerUseResetIpcResult,
      handler: (permission) =>
        Effect.tryPromise({
          try: () => resetPermission(permission, showHelper),
          catch: (error) =>
            new ComputerUseRunFailed({
              reason: error instanceof Error ? error.message : String(error),
            }),
        }).pipe(
          Effect.map((permissions) => ({ ok: true as const, permissions })),
          Effect.catch((error) =>
            Effect.logWarning("Computer use permission reset failed", {
              permission,
              message: error.reason,
            }).pipe(Effect.as({ ok: false as const, error: error.reason || "The reset failed." })),
          ),
        ),
    }),
  );
  // First run's Quit & Reopen: the marker is written, and waited for, before the relaunch.
  const services = yield* Effect.context<FileSystem.FileSystem | Path.Path>();
  const userData = () => Electron.app.getPath("userData");
  yield* ipc.handle(
    DesktopIpc.makeIpcMethod({
      channel: SAVE_FIRST_RUN_RESUME_CHANNEL,
      payload: FirstRunResumeMarker,
      result: Schema.Void,
      handler: (marker) =>
        writeFirstRunResume(userData(), marker).pipe(
          Effect.provide(services),
          Effect.catch((error) =>
            Effect.logWarning("First-run resume marker not written", { error: String(error) }),
          ),
        ),
    }),
  );
  yield* ipc.handle(
    DesktopIpc.makeIpcMethod({
      channel: TAKE_FIRST_RUN_RESUME_CHANNEL,
      payload: Schema.Undefined,
      result: Schema.NullOr(FirstRunResumeMarker),
      handler: () =>
        Clock.currentTimeMillis.pipe(
          Effect.flatMap((now) => takeFirstRunResume(userData(), now)),
          Effect.provide(services),
        ),
    }),
  );
  yield* ipc.handle(
    DesktopIpc.makeIpcMethod({
      channel: RELAUNCH_FOR_COMPUTER_USE_CHANNEL,
      payload: Schema.Undefined,
      result: Schema.Void,
      // macOS applies a new Screen Recording grant only to a freshly started app.
      handler: Effect.fn("desktop.ipc.relaunchForComputerUse")(function* () {
        const lifecycle = yield* DesktopLifecycle.DesktopLifecycle;
        yield* lifecycle.relaunch("computer-use-permission");
      }),
    }),
  );
});
