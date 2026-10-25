/**
 * Command routines and model pinning. A routine with a check runs a shell
 * command first and wakes its thread only when the command exits 0, so a
 * quiet run (most runs of a watch) spends nothing on any AI provider.
 */
import type {
  ProviderInteractionMode,
  RuntimeMode,
  ScheduledTask,
  ScheduledTaskCheck,
} from "@specweave-studio/contracts";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";

import type * as ProcessRunner from "../processRunner.ts";

const DEFAULT_CHECK_TIMEOUT_MS = 60_000;
const CHECK_OUTPUT_BYTES = 64 * 1024;
const CHECK_OUTPUT_CHARS = 4_000;

export type ScheduledTaskCheckResult =
  | { readonly passed: true; readonly output: string }
  | { readonly passed: false };

/** Runs the check with `/bin/sh -c` in `cwd`; fails with a message when it cannot run. */
export const runScheduledTaskCheck = (
  runner: ProcessRunner.ProcessRunner["Service"],
  check: ScheduledTaskCheck,
  cwd: string | undefined,
): Effect.Effect<ScheduledTaskCheckResult, string> =>
  runner
    .run({
      command: "/bin/sh",
      args: ["-c", check.command],
      ...(cwd === undefined ? {} : { cwd }),
      timeout: Duration.millis(check.timeoutMs ?? DEFAULT_CHECK_TIMEOUT_MS),
      maxOutputBytes: CHECK_OUTPUT_BYTES,
      outputMode: "truncate",
    })
    .pipe(
      Effect.mapError((error) => `The check could not run: ${error.message}`),
      Effect.map((output): ScheduledTaskCheckResult => {
        if (Number(output.code) !== 0) return { passed: false };
        const text = [output.stdout.trim(), output.stderr.trim()].filter(Boolean).join("\n");
        return {
          passed: true,
          output:
            text.length > CHECK_OUTPUT_CHARS
              ? `${text.slice(0, CHECK_OUTPUT_CHARS)}\n[output truncated]`
              : text,
        };
      }),
    );

/** The prompt a passed check wakes the thread with: the task's prompt and what the check printed. */
export function checkedPrompt(prompt: string, check: ScheduledTaskCheck, output: string): string {
  const printed = output.length === 0 ? "(no output)" : output;
  return `${prompt}\n\nThe check \`${check.command}\` passed. Its output:\n\`\`\`\n${printed}\n\`\`\``;
}

/**
 * Whether a run must use the task's own model. Only a routine someone set to
 * "Use a specific model" does; every other run follows the project, so one
 * provider running out never stops a routine. The model a routine saved
 * without that choice is just what it happened to be made with.
 */
export function isModelPinned(task: Pick<ScheduledTask, "modelPinned">): boolean {
  return task.modelPinned === true;
}

/**
 * Whether a check may be set under these modes. A check runs its command
 * unattended, with no approval prompt, so every mode must already allow full
 * access outside plan mode.
 */
export function checkAllowedFor(
  modes: ReadonlyArray<{
    readonly runtimeMode: RuntimeMode;
    readonly interactionMode: ProviderInteractionMode;
  }>,
): boolean {
  return modes.every(
    (mode) => mode.runtimeMode === "full-access" && mode.interactionMode !== "plan",
  );
}
