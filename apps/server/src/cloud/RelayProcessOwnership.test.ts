import * as NodeServices from "@effect/platform-node/NodeServices";
import { HostProcessPlatform } from "@specweave-studio/shared/hostProcess";
import { describe, expect, it } from "@effect/vitest";
import { vi } from "vite-plus/test";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Path from "effect/Path";
import * as ServerConfig from "../config.ts";
import * as ProcessRunner from "../processRunner.ts";
import * as RelayProcessOwnership from "./RelayProcessOwnership.ts";

const fixture = vi.hoisted(() => ({
  helper: "/trusted/studio-updater/managed_updates.py" as string | null,
}));
vi.mock("../managedUpdates/ManagedUpdatesService.ts", async () => {
  const E = await import("effect/Effect");
  return { installedManagedUpdateHelper: E.sync(() => fixture.helper) };
});

const output = (code: number): ProcessRunner.ProcessRunOutput => ({
  code: code as ProcessRunner.ProcessRunOutput["code"],
  stdout: "",
  stderr: "",
  timedOut: false,
  stdoutTruncated: false,
  stderrTruncated: false,
  stdoutInvalidUtf8: false,
  stderrInvalidUtf8: false,
});

const build = (calls: ProcessRunner.ProcessRunInput[], code = 0) =>
  RelayProcessOwnership.layer.pipe(
    Layer.provide(
      Layer.mergeAll(
        NodeServices.layer,
        Layer.succeed(HostProcessPlatform, "darwin"),
        Layer.succeed(ServerConfig.ServerConfig, {
          baseDir: "/owned/desk",
        } as ServerConfig.ServerConfig["Service"]),
        Layer.succeed(ProcessRunner.ProcessRunner, {
          run: (input) => {
            calls.push(input);
            return Effect.succeed(output(code));
          },
        }),
      ),
    ),
  );

describe("runtime relay ownership helper", () => {
  it.effect("uses bounded fixed local helper arguments and generation-bound cleanup", () =>
    Effect.gen(function* () {
      fixture.helper = "/trusted/studio-updater/managed_updates.py";
      const calls: ProcessRunner.ProcessRunInput[] = [];
      yield* Effect.gen(function* () {
        const ownership = yield* RelayProcessOwnership.RelayProcessOwnership;
        const first = yield* ownership.publish(400, "/opt/homebrew/bin/cloudflared");
        const second = yield* ownership.publish(401, "/custom/cloudflared");
        expect(first).not.toBe(second);
        yield* ownership.clear(400, first);
        yield* ownership.clear(401, null);
        expect(calls).toHaveLength(3);
        // The layer under test joins with the host Node path service (NodeServices), so the
        // expectation uses that same service: backslashes on Windows, slashes elsewhere.
        const path = yield* Path.Path;
        expect(calls[0]?.args).toEqual([
          "-B",
          "-E",
          "-s",
          path.join("/trusted/studio-updater", "relay_ownership.py"),
          "publish",
          "/owned/desk",
          String(process.pid),
          "400",
          first,
          "/opt/homebrew/bin/cloudflared",
        ]);
        expect(calls[2]?.args?.slice(4)).toEqual([
          "clear",
          "/owned/desk",
          String(process.pid),
          "400",
          first,
        ]);
        expect(
          calls.every(
            (call) => call.command === "/usr/bin/python3" && call.timeout === "3 seconds",
          ),
        ).toBe(true);
        expect(calls.every((call) => call.stdin === undefined && call.env === undefined)).toBe(
          true,
        );
      }).pipe(Effect.provide(Layer.merge(build(calls), NodeServices.layer)));
    }),
  );

  it.effect("fails closed without failing the connector when helper fails or is absent", () =>
    Effect.gen(function* () {
      fixture.helper = "/trusted/studio-updater/managed_updates.py";
      const calls: ProcessRunner.ProcessRunInput[] = [];
      yield* Effect.gen(function* () {
        const ownership = yield* RelayProcessOwnership.RelayProcessOwnership;
        expect(yield* ownership.publish(400, "/custom/cloudflared")).toBeNull();
        fixture.helper = null;
        expect(yield* ownership.publish(401, "/custom/cloudflared")).toBeNull();
        expect(calls).toHaveLength(1);
      }).pipe(Effect.provide(build(calls, 1)));
    }),
  );
});
