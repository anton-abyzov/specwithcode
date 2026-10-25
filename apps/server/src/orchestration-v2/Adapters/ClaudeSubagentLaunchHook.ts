import type { HookCallback, Options } from "@anthropic-ai/claude-agent-sdk";
import type { ThreadId } from "@specweave-studio/contracts";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";

/** The longest a launch waits for its checkpoint; past it the child starts anyway. */
export const SUBAGENT_LAUNCH_CHECKPOINT_TIMEOUT = Duration.seconds(20);

/** Launches remembered so each checkpoints once; old finished ones age out. */
const MAX_SEEN_LAUNCHES = 2_000;

type HookOutput = Awaited<ReturnType<HookCallback>>;

/** Resolves `{}` once `signal` aborts, so a stopped caller never waits. */
const untilAborted = (signal: AbortSignal) =>
  new Promise<HookOutput>((resolve) => {
    if (signal.aborted) resolve({});
    else signal.addEventListener("abort", () => resolve({}), { once: true });
  });

/**
 * Checkpoints the parent thread before Claude launches a native child: the
 * Agent tool's PreToolUse hook waits for the checkpoint, once per tool use.
 * A repeated call for the same tool use waits on the same checkpoint. It
 * returns no decision, so approval and Stop work as before. A checkpoint that
 * fails or takes too long is logged and the tool goes ahead.
 */
export function makeSubagentLaunchHooks(
  checkpoint: (threadId: ThreadId) => Effect.Effect<void>,
  timeout: Duration.Duration = SUBAGENT_LAUNCH_CHECKPOINT_TIMEOUT,
) {
  const launches = new Map<string, { readonly wait: Promise<HookOutput>; done: boolean }>();
  const forgetFinished = () => {
    for (const [key, launch] of launches) {
      if (launches.size <= MAX_SEEN_LAUNCHES) return;
      if (launch.done) launches.delete(key);
    }
  };
  const run = (threadId: ThreadId, key: string | undefined, signal: AbortSignal) =>
    Effect.runPromise(
      checkpoint(threadId).pipe(
        Effect.timeout(timeout),
        Effect.catchCause((cause) =>
          Effect.logWarning("Launching a subagent without its handoff checkpoint", {
            threadId,
            toolUseId: key,
            cause,
          }),
        ),
        Effect.as({}),
      ),
      { signal },
    ).catch((): HookOutput => ({}));
  const hook =
    (threadId: ThreadId): HookCallback =>
    (input, toolUseId, { signal }) => {
      if (input.hook_event_name !== "PreToolUse" || input.tool_name !== "Agent")
        return Promise.resolve({});
      const key = input.tool_use_id ?? toolUseId;
      if (key === undefined) return run(threadId, key, signal);
      const known = launches.get(key);
      if (known !== undefined)
        return known.done ? Promise.resolve({}) : Promise.race([known.wait, untilAborted(signal)]);
      const launch = { wait: run(threadId, key, signal), done: false };
      launches.set(key, launch);
      void launch.wait.then(() => {
        launch.done = true;
        forgetFinished();
      });
      return launch.wait;
    };
  return (threadId: ThreadId, existing: Options["hooks"]): NonNullable<Options["hooks"]> => ({
    ...existing,
    PreToolUse: [...(existing?.PreToolUse ?? []), { matcher: "Agent", hooks: [hook(threadId)] }],
  });
}
