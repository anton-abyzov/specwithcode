import { assert, describe, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as PlatformError from "effect/PlatformError";
import { ChildProcessSpawner } from "effect/process";

import * as CodexError from "../errors.ts";
import { appendStderrTail, makeTerminationError, summarizeStderr } from "./stdio.ts";

describe("Codex App Server child process termination", () => {
  it.effect("retains the process identifier with the exit code", () =>
    Effect.gen(function* () {
      const error = yield* makeTerminationError({
        pid: ChildProcessSpawner.ProcessId(51),
        exitCode: Effect.succeed(ChildProcessSpawner.ExitCode(9)),
      });

      assert.instanceOf(error, CodexError.CodexAppServerProcessExitedError);
      assert.equal(error.pid, 51);
      assert.equal(error.code, 9);
      assert.equal(error.message, "Codex App Server process exited with code 9");
    }),
  );

  it.effect("retains the process identifier and exact exit-status cause", () =>
    Effect.gen(function* () {
      const rootCause = new Error("private process diagnostics");
      const cause = PlatformError.systemError({
        _tag: "Unknown",
        module: "ChildProcess",
        method: "exitCode",
        cause: rootCause,
      });
      const error = yield* makeTerminationError({
        pid: ChildProcessSpawner.ProcessId(52),
        exitCode: Effect.fail(cause),
      });

      assert.instanceOf(error, CodexError.CodexAppServerTransportError);
      assert.equal(error.pid, 52);
      assert.strictEqual(error.cause, cause);
      assert.equal(
        error.message,
        "Codex App Server transport operation 'read-process-exit-status' failed.",
      );
      assert.notInclude(error.message, rootCause.message);
    }),
  );
});

describe("Codex App Server exit reason", () => {
  const missingDependency = [
    "file:///home/u/.local/share/fnm/node-versions/v24/installation/lib/node_modules/@openai/codex/bin/codex.js:108",
    "  throw new Error(",
    "        ^",
    "",
    "Error: Missing optional dependency @openai/codex-linux-x64. Reinstall Codex: npm install -g @openai/codex@latest",
    "    at findCodexExecutable (file:///x/codex.js:108:9)",
    "    at ModuleJob.run (node:internal/modules/esm/module_job:561:25)",
    "",
    "Node.js v24.22.0",
  ].join("\n");

  it("names the error line, not the stack or Node's banner", () => {
    assert.equal(
      summarizeStderr(missingDependency),
      "Error: Missing optional dependency @openai/codex-linux-x64. Reinstall Codex: npm install -g @openai/codex@latest",
    );
  });

  it("masks token-like text and falls back to the last line", () => {
    assert.equal(
      summarizeStderr("starting\nrefresh failed for sk-abcdefghijklmnop\n"),
      "refresh failed for [hidden]",
    );
    assert.equal(summarizeStderr("  \n"), undefined);
  });

  it("keeps only the tail of long output", () => {
    const tail = appendStderrTail("x".repeat(10_000), "end");
    assert.equal(tail.length, 8_192);
    assert.isTrue(tail.endsWith("end"));
  });

  it.effect("puts the reason on a failed exit", () =>
    Effect.gen(function* () {
      const error = yield* makeTerminationError(
        {
          pid: ChildProcessSpawner.ProcessId(53),
          exitCode: Effect.succeed(ChildProcessSpawner.ExitCode(1)),
        },
        Effect.succeed(missingDependency),
      );
      assert.instanceOf(error, CodexError.CodexAppServerProcessExitedError);
      assert.equal(
        error.message,
        "Codex App Server process exited with code 1: Error: Missing optional dependency @openai/codex-linux-x64. Reinstall Codex: npm install -g @openai/codex@latest",
      );
    }),
  );

  it.effect("says nothing more for a clean exit", () =>
    Effect.gen(function* () {
      const error = yield* makeTerminationError(
        {
          pid: ChildProcessSpawner.ProcessId(54),
          exitCode: Effect.succeed(ChildProcessSpawner.ExitCode(0)),
        },
        Effect.succeed("Error: unrelated"),
      );
      assert.equal(error.message, "Codex App Server process exited with code 0");
    }),
  );
});
