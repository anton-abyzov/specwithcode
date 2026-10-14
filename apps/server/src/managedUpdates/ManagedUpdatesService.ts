import { MAC_SERVICE_UPDATER_FILES } from "../../../../scripts/lib/studio-service-updater.ts";
import {
  ManagedUpdateError,
  ManagedUpdateStatus,
  type EnvironmentId,
  type ManagedUpdateEnrollment,
  type ManagedUpdateMutation,
  type ManagedUpdateTarget,
} from "@specweave-studio/contracts";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";
import * as FileSystem from "effect/FileSystem";
import * as Option from "effect/Option";
import * as Os from "node:os";
import * as Path from "effect/Path";
import type { AuthenticatedSession } from "../auth/EnvironmentAuth.ts";
import type { ProcessRunner } from "../processRunner.ts";
import type { ManagedUpdateAction } from "./ManagedUpdatesAuthority.ts";

export type ManagedUpdateInput =
  | ManagedUpdateTarget
  | ManagedUpdateMutation
  | ManagedUpdateEnrollment;
export type ManagedUpdateController = Pick<AuthenticatedSession, "sessionId" | "subject">;
const HelperResult = Schema.Union([
  Schema.Struct({ ok: Schema.Literal(true), status: ManagedUpdateStatus }),
  Schema.Struct({
    ok: Schema.Literal(false),
    error: Schema.Struct({ code: ManagedUpdateError.fields.code }),
  }),
]);

/** Trusted executable locations only; neither receipts nor RPC payloads select code. */
export const resolveManagedUpdateHelper = (input: {
  home: string;
  uid: number;
  entry: string;
  platform: string;
}) =>
  Effect.gen(function* () {
    if (input.platform !== "darwin" || input.uid <= 0) return null;
    const path = yield* Path.Path;
    const fs = yield* FileSystem.FileSystem;
    if (!path.isAbsolute(input.home) || !path.isAbsolute(input.entry)) return null;
    const candidates = [
      path.join(path.dirname(input.entry), "studio-updater", "managed_updates.py"),
      path.join(input.home, ".local/share/specweave-studio/updater/managed_updates.py"),
    ];
    for (const candidate of candidates) {
      const valid = yield* Effect.gen(function* () {
        for (const name of new Set(["managed_updates.py", ...MAC_SERVICE_UPDATER_FILES])) {
          const sibling = path.join(path.dirname(candidate), name);
          if ((yield* fs.realPath(sibling)) !== sibling) return false;
          const info = yield* fs.stat(sibling);
          if (
            info.type !== "File" ||
            Option.getOrNull(info.uid) !== input.uid ||
            (info.mode & 0o022) !== 0
          )
            return false;
        }
        let cursor = candidate;
        let file = true;
        while (true) {
          const info = yield* fs.stat(cursor);
          const uid = Option.getOrNull(info.uid);
          if (
            (info.mode & 0o022) !== 0 ||
            (uid !== input.uid && uid !== 0) ||
            (file ? info.type !== "File" || uid !== input.uid : info.type !== "Directory")
          )
            return false;
          if (cursor === path.parse(cursor).root) break;
          cursor = path.dirname(cursor);
          file = false;
        }
        return true;
      }).pipe(Effect.catch(() => Effect.succeed(false)));
      if (valid) return candidate;
    }
    return null;
  });

export function makeManagedUpdatesService(deps: {
  stateDir: string;
  environmentId: EnvironmentId;
  helper: Effect.Effect<string | null>;
  run: ProcessRunner["Service"]["run"];
}) {
  return (
    action: ManagedUpdateAction,
    controller: ManagedUpdateController,
    input?: ManagedUpdateInput,
  ) =>
    Effect.gen(function* () {
      if (input && input.environmentId !== deps.environmentId)
        return yield* new ManagedUpdateError({ code: "binding-changed" });
      const helper = yield* deps.helper;
      const unsupported: ManagedUpdateStatus = {
        environmentId: deps.environmentId,
        installationId: null,
        support: "unsupported",
        localAutomation: "unavailable",
        remoteConsent: "not-enrolled",
        revision: 0,
        operation: "idle",
        currentVersion: null,
        availableVersion: null,
        checkedAt: null,
      };
      if (helper === null) {
        if (action === "status") return unsupported;
        return yield* new ManagedUpdateError({ code: "unsupported" });
      }
      const stdin = yield* Schema.encodeEffect(Schema.fromJsonString(Schema.Unknown))({
        action,
        environmentId: deps.environmentId,
        controller,
        ...(input ? { input } : {}),
      }).pipe(Effect.mapError(() => new ManagedUpdateError({ code: "unavailable" })));
      const output = yield* deps
        .run({
          command: "/usr/bin/python3",
          args: ["-B", "-E", "-s", helper, "--state-dir", deps.stateDir],
          stdin,
          timeout: "35 seconds",
          maxOutputBytes: 64 * 1024,
          outputMode: "error",
        })
        .pipe(
          Effect.mapError(
            (error) =>
              new ManagedUpdateError({
                code: error._tag === "ProcessSpawnError" ? "unsupported" : "unavailable",
              }),
          ),
        );
      if (output.timedOut || output.stdoutTruncated || output.stdoutInvalidUtf8)
        return yield* new ManagedUpdateError({ code: "unavailable" });
      const parsed = yield* Schema.decodeUnknownEffect(Schema.fromJsonString(HelperResult))(
        output.stdout,
      ).pipe(Effect.mapError(() => new ManagedUpdateError({ code: "unavailable" })));
      if (!parsed.ok) return yield* new ManagedUpdateError({ code: parsed.error.code });
      if (
        output.code !== 0 ||
        parsed.status.environmentId !== deps.environmentId ||
        (input && parsed.status.installationId !== input.installationId)
      )
        return yield* new ManagedUpdateError({ code: "binding-changed" });
      return parsed.status;
    });
}

export const installedManagedUpdateHelper = Effect.gen(function* () {
  const owner = yield* Effect.try({
    try: () => Os.userInfo(),
    catch: () => new ManagedUpdateError({ code: "unsupported" }),
  }).pipe(Effect.option);
  if (Option.isNone(owner)) return null;
  return yield* resolveManagedUpdateHelper({
    home: owner.value.homedir,
    uid: owner.value.uid,
    entry: process.argv[1] ?? "",
    platform: process.platform,
  });
});
