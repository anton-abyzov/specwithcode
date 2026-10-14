import { describe, expect, it } from "@effect/vitest";
import { AuthSessionId, EnvironmentId, ManagedUpdateStatus } from "@specweave-studio/contracts";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Option from "effect/Option";
import * as Path from "effect/Path";
import { makeManagedUpdatesService, resolveManagedUpdateHelper } from "./ManagedUpdatesService.ts";
import type { ProcessRunInput, ProcessRunOutput } from "../processRunner.ts";

const environmentId = EnvironmentId.make("destination");
const controller = { sessionId: AuthSessionId.make("trusted-session"), subject: "client" };
const status: ManagedUpdateStatus = {
  environmentId,
  installationId: "desk",
  support: "supported",
  localAutomation: "enabled",
  remoteConsent: "not-enrolled",
  revision: 0,
  operation: "idle",
  currentVersion: "1.0.17",
  availableVersion: null,
  checkedAt: null,
};
const output = (body: unknown, code = 0): ProcessRunOutput => ({
  stdout: JSON.stringify(body),
  stderr: "sensitive detail must never reach client",
  code: code as ProcessRunOutput["code"],
  timedOut: false,
  stdoutTruncated: false,
  stderrTruncated: false,
  stdoutInvalidUtf8: false,
  stderrInvalidUtf8: false,
});

describe("managed update helper boundary", () => {
  it.effect(
    "passes only the authenticated controller and destination identity to a fixed helper",
    () =>
      Effect.gen(function* () {
        let called: ProcessRunInput | undefined;
        const call = makeManagedUpdatesService({
          stateDir: "/owner/.specweave-studio/desk/user",
          environmentId,
          helper: Effect.succeed("/trusted/managed_updates.py"),
          run: (input) => {
            called = input;
            return Effect.succeed(output({ ok: true, status }));
          },
        });
        expect(yield* call("status", controller)).toEqual(status);
        expect(called?.args).toEqual([
          "-B",
          "-E",
          "-s",
          "/trusted/managed_updates.py",
          "--state-dir",
          "/owner/.specweave-studio/desk/user",
        ]);
        expect(called?.command).toBe("/usr/bin/python3");
        expect(JSON.parse(called!.stdin!)).toEqual({ action: "status", environmentId, controller });
        expect(called?.maxOutputBytes).toBe(65536);
      }),
  );
  it.effect("reports missing prerequisites as unsupported without executing", () =>
    Effect.gen(function* () {
      let calls = 0;
      const call = makeManagedUpdatesService({
        stateDir: "/owned",
        environmentId,
        helper: Effect.succeed(null),
        run: () => {
          calls++;
          return Effect.succeed(output({ ok: true, status }));
        },
      });
      expect((yield* call("status", controller)).support).toBe("unsupported");
      expect(
        (yield* call("enroll", controller, {
          environmentId,
          installationId: "desk",
          expectedRevision: 0,
          consent: true,
        }).pipe(Effect.flip)).code,
      ).toBe("unsupported");
      expect(calls).toBe(0);
    }),
  );
  it.effect("refuses wrong destination before executing and mismatched helper readback", () =>
    Effect.gen(function* () {
      let calls = 0;
      const call = makeManagedUpdatesService({
        stateDir: "/owned",
        environmentId,
        helper: Effect.succeed("/trusted/helper"),
        run: () => {
          calls++;
          return Effect.succeed(
            output({ ok: true, status: { ...status, environmentId: "other" } }),
          );
        },
      });
      expect(
        (yield* call("check", controller, {
          environmentId: EnvironmentId.make("other"),
          installationId: "desk",
        }).pipe(Effect.flip)).code,
      ).toBe("binding-changed");
      expect(calls).toBe(0);
      expect((yield* call("status", controller).pipe(Effect.flip)).code).toBe("binding-changed");
    }),
  );
  it.effect("sanitizes helper failures and refuses malformed output", () =>
    Effect.gen(function* () {
      for (const result of [
        output({ unexpected: "secret" }),
        output({ ok: true, status }, 1),
        { ...output({ ok: true, status }), stdoutInvalidUtf8: true },
      ]) {
        const call = makeManagedUpdatesService({
          stateDir: "/owned",
          environmentId,
          helper: Effect.succeed("/trusted/helper"),
          run: () => Effect.succeed(result),
        });
        const error = yield* call("status", controller).pipe(Effect.flip);
        expect(JSON.stringify(error)).not.toContain("secret");
      }
      const call = makeManagedUpdatesService({
        stateDir: "/owned",
        environmentId,
        helper: Effect.succeed("/trusted/helper"),
        run: () => Effect.succeed(output({ ok: false, error: { code: "revoked" } }, 1)),
      });
      expect(
        (yield* call("check", controller, { environmentId, installationId: "desk" }).pipe(
          Effect.flip,
        )).code,
      ).toBe("revoked");
    }),
  );
  it.effect("rejects aliased and writable executable paths and root execution", () =>
    Effect.gen(function* () {
      const base = {
        home: "/Users/owner",
        uid: 501,
        entry: "/Users/owner/runtime/bin.mjs",
        platform: "darwin",
      };
      const run = (alias = false, writable = false, uid = 501) =>
        resolveManagedUpdateHelper({ ...base, uid }).pipe(
          Effect.provide(Path.layer),
          Effect.provideService(
            FileSystem.FileSystem,
            FileSystem.makeNoop({
              realPath: (path) => Effect.succeed(alias ? "/alias/managed_updates.py" : path),
              stat: (path) =>
                Effect.succeed({
                  uid: Option.some(path === "/" || path === "/Users" ? 0 : 501),
                  mode: writable ? 0o777 : 0o700,
                  type: path.endsWith(".py") ? "File" : "Directory",
                } as FileSystem.File.Info),
            }),
          ),
        );
      expect(yield* run()).toBe("/Users/owner/runtime/studio-updater/managed_updates.py");
      expect(yield* run(true)).toBeNull();
      expect(yield* run(false, true)).toBeNull();
      expect(yield* run(false, false, 0)).toBeNull();
    }),
  );
});
