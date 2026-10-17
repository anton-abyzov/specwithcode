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
});
