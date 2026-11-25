// @effect-diagnostics nodeBuiltinImport:off - locates the mock ACP agent script beside the sources.
import * as NodePath from "node:path";
import * as NodeURL from "node:url";

import * as NodeServices from "@effect/platform-node/NodeServices";
import { it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import { ChildProcess, ChildProcessSpawner } from "effect/process";
import { describe, expect } from "vite-plus/test";

import * as AcpSessionRuntime from "./AcpSessionRuntime.ts";

const __dirname = NodePath.dirname(NodeURL.fileURLToPath(import.meta.url));
const mockAgentPath = NodePath.join(__dirname, "../../../scripts/acp-mock-agent.ts");

describe("AcpSessionRuntime environment", () => {
  // Every ACP provider (registry agents, Copilot, Devin, Grok, Antigravity)
  // starts through this runtime, so this is where the policy is applied.
  it.effect("starts the agent with the headless browser environment", () =>
    Effect.gen(function* () {
      const nodeSpawner = yield* ChildProcessSpawner.ChildProcessSpawner;
      const spawned: Array<{
        readonly env: Record<string, string | undefined> | undefined;
        readonly extendEnv: boolean | undefined;
      }> = [];
      const recordingSpawner = ChildProcessSpawner.make((command) => {
        if (ChildProcess.isStandardCommand(command)) {
          spawned.push({ env: command.options.env, extendEnv: command.options.extendEnv });
        }
        return nodeSpawner.spawn(command);
      });

      for (const env of [undefined, { KEEP: "1", PWDEBUG: "1", PLAYWRIGHT_HTML_OPEN: "always" }]) {
        yield* Effect.scoped(
          Effect.gen(function* () {
            const runtime = yield* AcpSessionRuntime.make({
              spawn: {
                command: "node",
                args: [mockAgentPath],
                ...(env === undefined ? {} : { env }),
              },
              cwd: process.cwd(),
              clientInfo: { name: "studio-test", version: "0.0.0" },
              authMethodId: "test",
            });
            yield* runtime.start();
          }),
        ).pipe(Effect.provideService(ChildProcessSpawner.ChildProcessSpawner, recordingSpawner));
      }

      expect(spawned).toEqual([
        // No environment of its own: the agent still inherits the server's.
        { env: { PWDEBUG: "0", PLAYWRIGHT_HTML_OPEN: "never" }, extendEnv: true },
        { env: { KEEP: "1", PWDEBUG: "0", PLAYWRIGHT_HTML_OPEN: "never" }, extendEnv: true },
      ]);
    }).pipe(Effect.provide(NodeServices.layer)),
  );

  it.effect("an agent on the Linux AppImage build gets none of its runtime environment", () =>
    Effect.gen(function* () {
      const nodeSpawner = yield* ChildProcessSpawner.ChildProcessSpawner;
      const appImage = {
        APPIMAGE: "/home/a/SpecWithCode.AppImage",
        APPDIR: "/tmp/.mount_Spec1",
        ARGV0: "SpecWithCode",
        OWD: "/home/a",
        LD_LIBRARY_PATH: "/tmp/.mount_Spec1/usr/lib",
        XDG_DATA_DIRS: "/tmp/.mount_Spec1/usr/share:/usr/share",
      };
      const saved = Object.fromEntries(Object.keys(appImage).map((key) => [key, process.env[key]]));
      yield* Effect.acquireRelease(
        Effect.sync(() => Object.assign(process.env, appImage)),
        () =>
          Effect.sync(() => {
            for (const [key, value] of Object.entries(saved)) {
              if (value === undefined) delete process.env[key];
              else process.env[key] = value;
            }
          }),
      );
      // What the agent process really gets: Node adds the server's own
      // environment under `env` when `extendEnv` is on.
      const effective: Array<Record<string, string | undefined>> = [];
      const recordingSpawner = ChildProcessSpawner.make((command) => {
        if (ChildProcess.isStandardCommand(command)) {
          const { env, extendEnv } = command.options;
          effective.push(extendEnv === false ? { ...env } : { ...process.env, ...env });
        }
        return nodeSpawner.spawn(command);
      });

      // No env, a partial env, a complete copy of the server's env, and a
      // complete env that replaces the server's.
      const spawns: ReadonlyArray<Pick<AcpSessionRuntime.AcpSpawnInput, "env" | "extendEnv">> = [
        {},
        { env: { GROK_OAUTH2_REFERRER: "studio" } },
        { env: { ...process.env, KEEP: "1" } },
        { env: { ...process.env, KEEP: "1" }, extendEnv: false },
      ];
      for (const spawn of spawns) {
        yield* Effect.scoped(
          Effect.gen(function* () {
            const runtime = yield* AcpSessionRuntime.make({
              spawn: { command: "node", args: [mockAgentPath], ...spawn },
              cwd: process.cwd(),
              clientInfo: { name: "studio-test", version: "0.0.0" },
              authMethodId: "test",
            });
            yield* runtime.start();
          }),
        ).pipe(Effect.provideService(ChildProcessSpawner.ChildProcessSpawner, recordingSpawner));
      }

      expect(effective).toHaveLength(4);
      for (const env of effective) {
        expect(env.APPIMAGE).toBeUndefined();
        expect(env.APPDIR).toBeUndefined();
        expect(env.ARGV0).toBeUndefined();
        expect(env.OWD).toBeUndefined();
        expect(env.LD_LIBRARY_PATH).toBeUndefined();
        expect(env.XDG_DATA_DIRS).toBe("/usr/share");
        expect(env.PATH).toBe(process.env.PATH);
        expect(env.PWDEBUG).toBe("0");
      }
      expect(effective[1]?.GROK_OAUTH2_REFERRER).toBe("studio");
      expect(effective[2]?.KEEP).toBe("1");
      expect(effective[3]?.KEEP).toBe("1");
    }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
  );
});
