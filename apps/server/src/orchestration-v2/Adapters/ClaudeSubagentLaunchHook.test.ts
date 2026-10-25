import type { HookCallback, HookInput } from "@anthropic-ai/claude-agent-sdk";
import { ThreadId } from "@specweave-studio/contracts";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import { describe, expect, it } from "vite-plus/test";

import { makeSubagentLaunchHooks } from "./ClaudeSubagentLaunchHook.ts";

// The adapter suite cannot load here (pptxgenjs is missing), so the hook the
// adapter installs is tested on its own.
const parent = ThreadId.make("thread:parent");

/** Lets every pending callback run before the next assertion. */
const settle = () => new Promise<void>((resolve) => setImmediate(resolve));

const preToolUse = (toolName: string, toolUseId: string) =>
  ({
    hook_event_name: "PreToolUse",
    session_id: "session",
    transcript_path: "/dev/null",
    cwd: "/",
    tool_name: toolName,
    tool_input: { prompt: "Review the change" },
    tool_use_id: toolUseId,
  }) as unknown as HookInput;

function installed(
  checkpoint: (threadId: ThreadId) => Effect.Effect<void>,
  timeout?: Duration.Duration,
) {
  const hooks = makeSubagentLaunchHooks(checkpoint, timeout)(parent, {
    PreToolUse: [{ matcher: "Bash", hooks: [async () => ({ continue: true })] }],
    SessionStart: [{ hooks: [async () => ({})] }],
  });
  const matcher = hooks.PreToolUse!.at(-1)!;
  const hook = matcher.hooks[0]!;
  const call = (input: HookInput, signal = new AbortController().signal) =>
    hook(input, (input as { tool_use_id?: string }).tool_use_id, { signal });
  return { hooks, matcher, hook: hook as HookCallback, call };
}

describe("Claude subagent launch checkpoint", () => {
  it("waits for the parent's checkpoint before the Agent tool runs, and decides nothing", async () => {
    const order: Array<string> = [];
    const { hooks, matcher, call } = installed((threadId) =>
      Effect.gen(function* () {
        order.push(`checkpoint ${threadId}`);
        yield* Effect.sleep(Duration.millis(20));
        order.push("checkpoint written");
      }),
    );
    expect(matcher.matcher).toBe("Agent");
    // Existing hooks stay in place.
    expect(hooks.PreToolUse).toHaveLength(2);
    expect(hooks.SessionStart).toHaveLength(1);
    const output = await call(preToolUse("Agent", "toolu_1")).then((result) => {
      order.push("tool may run");
      return result;
    });
    expect(order).toEqual(["checkpoint thread:parent", "checkpoint written", "tool may run"]);
    // No permission decision: approval and Stop handling stay as they were.
    expect(output).toEqual({});
  });

  it("checkpoints once per tool use and ignores every other tool", async () => {
    const calls: Array<string> = [];
    const { call } = installed((threadId) => Effect.sync(() => calls.push(threadId)));
    await call(preToolUse("Agent", "toolu_1"));
    await call(preToolUse("Agent", "toolu_1"));
    await Promise.all([call(preToolUse("Agent", "toolu_2")), call(preToolUse("Agent", "toolu_2"))]);
    await call(preToolUse("Bash", "toolu_3"));
    await call({ hook_event_name: "PostToolUse", tool_name: "Agent" } as unknown as HookInput);
    expect(calls).toEqual([parent, parent]);
  });

  it("makes a duplicate call wait for the checkpoint already in flight", async () => {
    let started!: () => void;
    let release!: () => void;
    const running = new Promise<void>((resolve) => (started = resolve));
    const gate = new Promise<void>((resolve) => (release = resolve));
    let written = false;
    const calls: Array<string> = [];
    const { call } = installed((threadId) =>
      Effect.promise(async () => {
        calls.push(threadId);
        started();
        await gate;
        written = true;
      }),
    );
    const first = call(preToolUse("Agent", "toolu_same"));
    await running;
    let duplicateSettled = false;
    const duplicate = call(preToolUse("Agent", "toolu_same")).then((output) => {
      duplicateSettled = true;
      // The duplicate may only let the tool run after the checkpoint wrote.
      expect(written).toBe(true);
      return output;
    });
    await settle();
    expect(duplicateSettled).toBe(false);
    release();
    expect(await Promise.all([first, duplicate])).toEqual([{}, {}]);
    expect(calls).toEqual([parent]);
    // Once written, a later repeat does not checkpoint again.
    expect(await call(preToolUse("Agent", "toolu_same"))).toEqual({});
    expect(calls).toEqual([parent]);
  });

  it("lets a stopped duplicate go without waiting, and keeps in-flight launches remembered", async () => {
    let release!: () => void;
    const gate = new Promise<void>((resolve) => (release = resolve));
    const calls: Array<string> = [];
    const { call } = installed((threadId) =>
      Effect.promise(async () => {
        calls.push(threadId);
        if (calls.length === 1) await gate;
      }),
    );
    const first = call(preToolUse("Agent", "toolu_slow"));
    const stop = new AbortController();
    const stopped = call(preToolUse("Agent", "toolu_slow"), stop.signal);
    stop.abort();
    expect(await stopped).toEqual({});
    // Enough finished launches to overflow the memory; the in-flight one stays.
    for (let index = 0; index < 2_001; index++) await call(preToolUse("Agent", `toolu_${index}`));
    let duplicateSettled = false;
    const duplicate = call(preToolUse("Agent", "toolu_slow")).then((output) => {
      duplicateSettled = true;
      return output;
    });
    await settle();
    expect(duplicateSettled).toBe(false);
    release();
    expect(await Promise.all([first, duplicate])).toEqual([{}, {}]);
    expect(calls).toHaveLength(2_002);
  });

  it("lets the tool run when the checkpoint fails, hangs or the turn is stopped", async () => {
    const failed = installed(() => Effect.die(new Error("disk full")));
    expect(await failed.call(preToolUse("Agent", "toolu_fail"))).toEqual({});

    const hung = installed(() => Effect.never, Duration.millis(20));
    expect(await hung.call(preToolUse("Agent", "toolu_hang"))).toEqual({});

    const stop = new AbortController();
    const stopped = installed(() => Effect.never);
    const pending = stopped.call(preToolUse("Agent", "toolu_stop"), stop.signal);
    stop.abort();
    expect(await pending).toEqual({});
  });
});
