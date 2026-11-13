import { assert, it } from "@effect/vitest";
import {
  ProjectId,
  ProviderInstanceId,
  ProviderThreadId,
  RunId,
  ThreadId,
  ProviderDriverKind,
} from "@specweave-studio/contracts";
import * as Effect from "effect/Effect";
import {
  ProviderAdapterTurnStartError,
  type ProviderAdapterV2SessionRuntime,
  type ProviderAdapterV2TurnInput,
} from "../orchestration-v2/ProviderAdapter.ts";
import { withProjectContext } from "./ProjectContextRuntime.ts";
import { makeProjectContextHooks } from "./ProjectContextHooks.ts";

const turn = (text = "Please implement the change."): ProviderAdapterV2TurnInput =>
  ({
    appThread: { projectId: ProjectId.make("project") },
    threadId: ThreadId.make("thread"),
    runId: RunId.make("run"),
    modelSelection: { instanceId: ProviderInstanceId.make("claude-account"), model: "model-a" },
    providerThread: {
      id: ProviderThreadId.make("provider-thread"),
      nativeThreadRef: { nativeId: "native" },
    },
    message: { text, attachments: [], createdBy: "user", creationSource: "web" },
  }) as unknown as ProviderAdapterV2TurnInput;

it.effect(
  "delivers exactly one prepared snapshot to the adapter and waits for explicit native acceptance",
  () =>
    Effect.gen(function* () {
      let accepted = 0;
      const received: ProviderAdapterV2TurnInput[] = [];
      const native = {
        driver: ProviderDriverKind.make("claude"),
        startTurn: (input: ProviderAdapterV2TurnInput) =>
          Effect.sync(() => {
            received.push(input);
          }),
      } as unknown as ProviderAdapterV2SessionRuntime;
      const runtime = withProjectContext(native, {
        prepare: () =>
          Effect.succeed({
            text: "CURRENT SNAPSHOT",
            accepted: Effect.sync(() => {
              accepted++;
            }),
          }),
        restore: () => Effect.succeed("restored"),
      });
      yield* runtime.startTurn(turn());
      assert.equal(
        received[0]?.message.text,
        "CURRENT SNAPSHOT\n\nCurrent user message:\nPlease implement the change.",
      );
      assert.equal(accepted, 0);
      yield* received[0]!.projectContext!.accepted;
      assert.equal(accepted, 1);
    }),
);

it.effect("preserves native compact and wake semantics without acknowledging a new prompt", () =>
  Effect.gen(function* () {
    let prepared = 0;
    let restored = 0;
    const received: ProviderAdapterV2TurnInput[] = [];
    const start = (input: ProviderAdapterV2TurnInput) =>
      Effect.sync(() => {
        received.push(input);
      });
    const native = {
      driver: ProviderDriverKind.make("claude"),
      startTurn: start,
      compactThread: start,
    } as unknown as ProviderAdapterV2SessionRuntime;
    const runtime = withProjectContext(native, {
      prepare: () =>
        Effect.sync(() => {
          prepared++;
          return { text: "snapshot", accepted: Effect.die("must not acknowledge a native wake") };
        }),
      restore: () =>
        Effect.sync(() => {
          restored++;
          return "fresh memory";
        }),
    });
    yield* runtime.compactThread!(turn("/compact"));
    yield* runtime.startTurn({
      ...turn("native continuation"),
      restartContinuationOfRunId: RunId.make("prior"),
    });
    assert.deepEqual(
      received.map((input) => input.message.text),
      ["/compact", "native continuation"],
    );
    assert.equal(prepared, 0);
    for (const input of received) {
      yield* input.projectContext!.accepted;
      assert.equal(yield* input.projectContext!.restore, "fresh memory");
    }
    assert.equal(restored, 2);
  }),
);

it.effect("preserves goal parsing while supplying project context separately", () =>
  Effect.gen(function* () {
    let received: ProviderAdapterV2TurnInput | undefined;
    const native = {
      driver: ProviderDriverKind.make("codex"),
      startTurn: (input: ProviderAdapterV2TurnInput) =>
        Effect.sync(() => {
          received = input;
        }),
    } as unknown as ProviderAdapterV2SessionRuntime;
    const runtime = withProjectContext(native, {
      prepare: () => Effect.succeed({ text: "project goal and memory", accepted: Effect.void }),
      restore: () => Effect.succeed("current"),
    });
    yield* runtime.startTurn(turn("/goal Build the release"));
    assert.equal(received?.message.text, "/goal Build the release");
    assert.equal(received?.projectContext?.nativeCommandText, "project goal and memory");
  }),
);

it.effect(
  "never acknowledges failed dispatch or retries a user message just because receipt persistence failed",
  () =>
    Effect.gen(function* () {
      let sent = 0;
      let ack = 0;
      let failDispatch = true;
      const native = {
        driver: ProviderDriverKind.make("codex"),
        startTurn: (input: ProviderAdapterV2TurnInput) =>
          Effect.gen(function* () {
            sent++;
            if (failDispatch)
              return yield* Effect.fail(
                new ProviderAdapterTurnStartError({
                  driver: ProviderDriverKind.make("codex"),
                  threadId: input.threadId,
                  runId: input.runId,
                  providerThreadId: input.providerThread.id,
                  cause: "rejected before acceptance",
                }),
              );
            yield* input.projectContext!.accepted;
          }),
      } as unknown as ProviderAdapterV2SessionRuntime;
      const runtime = withProjectContext(native, {
        prepare: () =>
          Effect.succeed({
            text: "context",
            accepted: Effect.sync(() => {
              ack++;
            }).pipe(Effect.andThen(Effect.die("receipt storage unavailable"))),
          }),
        restore: () => Effect.succeed(""),
      });
      yield* runtime.startTurn(turn()).pipe(Effect.flip);
      assert.equal(ack, 0);
      assert.equal(sent, 1);
      failDispatch = false;
      yield* runtime.startTurn({
        ...turn("second explicit user message"),
        runId: RunId.make("second"),
      });
      assert.equal(sent, 2);
      assert.equal(ack, 1);
    }),
);

it.effect("keeps mixed-provider native identity independent from model settings", () =>
  Effect.gen(function* () {
    const identities: unknown[] = [];
    const native = {
      driver: ProviderDriverKind.make("claude"),
      startTurn: () => Effect.void,
    } as unknown as ProviderAdapterV2SessionRuntime;
    const runtime = withProjectContext(native, {
      prepare: (identity) =>
        Effect.sync(() => {
          identities.push(identity);
          return { text: "", accepted: Effect.void };
        }),
      restore: () => Effect.succeed(""),
    });
    yield* runtime.startTurn(turn());
    yield* runtime.startTurn({
      ...turn(),
      modelSelection: { ...turn().modelSelection, model: "model-b" },
    });
    assert.deepEqual(identities[0], identities[1]);
  }),
);

it("Claude hooks avoid startup duplication and reload memory after compaction", async () => {
  const context = makeProjectContextHooks();
  let current = "memory A";
  const input = {
    ...turn(),
    projectContext: { accepted: Effect.void, restore: Effect.sync(() => current) },
  };
  context.register("native", input);
  const hooks = context.hooks("native", undefined)!;
  const call = hooks.SessionStart!.at(-1)!.hooks[0]!;
  const base = { session_id: "native", transcript_path: "/tmp/fake", cwd: "/tmp" };
  assert.deepEqual(
    await call({ ...base, hook_event_name: "SessionStart", source: "startup" }, undefined, {
      signal: new AbortController().signal,
    }),
    {},
  );
  current = "memory B";
  assert.deepEqual(
    await call({ ...base, hook_event_name: "SessionStart", source: "compact" }, undefined, {
      signal: new AbortController().signal,
    }),
    { hookSpecificOutput: { hookEventName: "SessionStart", additionalContext: "memory B" } },
  );
});

it("Claude first goal gets context before native work, while cached-query goals require the matching prompt hook", async () => {
  const hooks = makeProjectContextHooks();
  const context = {
    accepted: Effect.void,
    restore: Effect.succeed("restore"),
    nativeCommandText: "project snapshot",
  };
  hooks.register("native", { ...turn("/goal Build"), projectContext: context });
  const callbacks = hooks.hooks("native", undefined)!;
  const base = { session_id: "native", transcript_path: "/tmp/fake", cwd: "/tmp" };
  const signal = { signal: new AbortController().signal };
  assert.isFalse(hooks.canAcknowledge(context));
  assert.deepEqual(
    await callbacks.SessionStart!.at(-1)!.hooks[0]!(
      { ...base, hook_event_name: "SessionStart", source: "startup" },
      undefined,
      signal,
    ),
    {
      hookSpecificOutput: { hookEventName: "SessionStart", additionalContext: "project snapshot" },
    },
  );
  assert.isTrue(hooks.canAcknowledge(context));
  assert.deepEqual(
    await callbacks.UserPromptSubmit!.at(-1)!.hooks[0]!(
      { ...base, hook_event_name: "UserPromptSubmit", prompt: "/goal Build" },
      undefined,
      signal,
    ),
    {},
  );
  const next = { ...context, nativeCommandText: "changed memory" };
  hooks.register("native", { ...turn("/goal Build again"), projectContext: next });
  assert.deepEqual(
    await callbacks.UserPromptSubmit!.at(-1)!.hooks[0]!(
      { ...base, hook_event_name: "UserPromptSubmit", prompt: "/goal Unrelated" },
      undefined,
      signal,
    ),
    {},
  );
  assert.isFalse(hooks.canAcknowledge(next));
  assert.deepEqual(
    await callbacks.UserPromptSubmit!.at(-1)!.hooks[0]!(
      { ...base, hook_event_name: "UserPromptSubmit", prompt: "/goal Build again" },
      undefined,
      signal,
    ),
    {
      hookSpecificOutput: {
        hookEventName: "UserPromptSubmit",
        additionalContext: "changed memory",
      },
    },
  );
  assert.isTrue(hooks.canAcknowledge(next));
});
