import { assert, it } from "@effect/vitest";
import * as Effect from "effect/Effect";

import { runInteractiveSession } from "./triage.ts";

it.effect("starts the triage agent with the headless browser environment", () =>
  Effect.acquireUseRelease(
    Effect.sync(() => {
      const previous = {
        PWDEBUG: process.env.PWDEBUG,
        PLAYWRIGHT_HTML_OPEN: process.env.PLAYWRIGHT_HTML_OPEN,
      };
      // An inspector setting in the user's shell must not reach the agent.
      process.env.PWDEBUG = "1";
      process.env.PLAYWRIGHT_HTML_OPEN = "always";
      return previous;
    }),
    () =>
      Effect.gen(function* () {
        // The child exits 0 only when it sees the headless values and PATH.
        const exitCode = yield* runInteractiveSession({
          command: process.execPath,
          args: [
            "-e",
            'process.exit(process.env.PWDEBUG === "0" && process.env.PLAYWRIGHT_HTML_OPEN === "never" && typeof process.env.PATH === "string" ? 0 : 3)',
          ],
          shell: false,
          cwd: process.cwd(),
        });
        assert.equal(exitCode, 0);
      }),
    (previous) =>
      Effect.sync(() => {
        for (const [key, value] of Object.entries(previous)) {
          if (value === undefined) delete process.env[key];
          else process.env[key] = value;
        }
      }),
  ),
);
