// @effect-diagnostics nodeBuiltinImport:off - locates the mock ACP agent script beside the sources.
import * as NodePath from "node:path";
import * as NodeURL from "node:url";

import * as NodeServices from "@effect/platform-node/NodeServices";
import { it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import { ChildProcessSpawner } from "effect/process";
import { describe, expect } from "vite-plus/test";

import { ProviderProcessSupervisor, make } from "../../process/ProviderProcessSupervisor.ts";
import * as AcpSessionRuntime from "./AcpSessionRuntime.ts";

const __dirname = NodePath.dirname(NodeURL.fileURLToPath(import.meta.url));
const mockAgentPath = NodePath.join(__dirname, "../../../scripts/acp-mock-agent.ts");

describe("AcpSessionRuntime provider process supervision", () => {
  // Every ACP provider (Copilot, Grok, Devin, registry agents) starts here, so this is
  // where its priority is lowered and its leftover tool processes are reaped.
  it.effect("supervises the spawned agent and reaps only after the agent's own teardown", () =>
    Effect.gen(function* () {
      const nodeSpawner = yield* ChildProcessSpawner.ChildProcessSpawner;
      const handles: Array<ChildProcessSpawner.ChildProcessHandle> = [];
      const recordingSpawner = ChildProcessSpawner.make((command) =>
        nodeSpawner
          .spawn(command)
          .pipe(Effect.tap((handle) => Effect.sync(() => handles.push(handle)))),
      );
      const supervised: Array<number> = [];
      const agentRunningAtReap: Array<boolean> = [];
      // The real supervisor over a fake host: the table it reads at teardown tells whether
      // the agent had already exited, and holds nothing for it to signal.
      const supervisor = yield* make(
        {
          platform: "darwin",
          serverPid: process.pid,
          readTable: Effect.gen(function* () {
            const agent = handles.find((handle) => Number(handle.pid) === supervised[0]);
            if (agent !== undefined) agentRunningAtReap.push(yield* agent.isRunning);
            return [];
          }).pipe(Effect.orElseSucceed(() => [])),
          signal: () => undefined,
          setNice: (pid) => {
            supervised.push(pid);
          },
        },
        { sampleInterval: "1 hour" },
      );

      yield* Effect.scoped(
        Effect.gen(function* () {
          const runtime = yield* AcpSessionRuntime.make({
            spawn: { command: "node", args: [mockAgentPath] },
            cwd: process.cwd(),
            clientInfo: { name: "studio-test", version: "0.0.0" },
            authMethodId: "test",
          });
          yield* runtime.start();
        }),
      ).pipe(
        Effect.provide(
          Layer.mergeAll(
            Layer.succeed(ChildProcessSpawner.ChildProcessSpawner, recordingSpawner),
            Layer.succeed(ProviderProcessSupervisor, supervisor),
          ),
        ),
      );

      expect(handles.length).toBeGreaterThan(0);
      expect(supervised).toEqual([Number(handles[0]?.pid)]);
      // The teardown's sample is read after the agent itself has exited.
      expect(agentRunningAtReap.at(-1)).toBe(false);
    }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
  );
});
