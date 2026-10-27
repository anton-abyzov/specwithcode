import * as NodeFileSystem from "@effect/platform-node/NodeFileSystem";
import * as FileSystem from "effect/FileSystem";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vite-plus/test";
import { join } from "../../nodePath.ts";
import * as Effect from "effect/Effect";
import * as Stream from "effect/Stream";
import * as Fiber from "effect/Fiber";
import * as Deferred from "effect/Deferred";
import { EXPECTED_SCHEMA_FINGERPRINT } from "@muse-code/sdk";
import { makeMuseRuntime } from "./MuseRuntime.ts";
import { connectMuse, museCheckFailure } from "./MuseConnection.ts";
import type { AcpSessionRuntimeEvent } from "../acp/AcpSessionRuntime.ts";
import type * as Acp from "@specweave-studio/effect-acp/compat";
import { museRequireHumanReviewer } from "./MuseRequests.ts";
const fs = Effect.runSync(Effect.provide(FileSystem.FileSystem, NodeFileSystem.layer));

const dirs: string[] = [];
afterEach(async () => {
  await Promise.all(
    dirs
      .splice(0)
      .map((path) => Effect.runPromise(fs.remove(path, { recursive: true, force: true }))),
  );
});
async function fixture(env: Record<string, string> = {}) {
  const cwd = await Effect.runPromise(fs.makeTempDirectory({ prefix: "studio-muse-test-" }));
  dirs.push(cwd);
  await Effect.runPromise(
    fs.copyFile(
      fileURLToPath(new URL("./fixtures/serve.cjs", import.meta.url)),
      join(cwd, "serve"),
    ),
  );
  await Effect.runPromise(
    fs.copyFile(
      fileURLToPath(new URL("./fixtures/muse-1.4.13-turn.json", import.meta.url)),
      join(cwd, "muse-1.4.13-turn.json"),
    ),
  );
  return {
    cwd,
    settings: { enabled: true, binaryPath: process.execPath },
    environment: { ...process.env, MUSE_TEST_FINGERPRINT: EXPECTED_SCHEMA_FINGERPRINT, ...env },
  };
}
const run = <A, E>(effect: Effect.Effect<A, E, import("effect/Scope").Scope>) =>
  Effect.runPromise(Effect.scoped(effect));
/** What SpecWithCode's ACP adapter receives: it projects turn items only from these. */
const listen = (runtime: Effect.Success<ReturnType<typeof makeMuseRuntime>>) => {
  const updates: Acp.SessionUpdate[] = [];
  return runtime
    .handleSessionUpdate((notification) =>
      Effect.sync(() => {
        updates.push(notification.update);
      }),
    )
    .pipe(Effect.as(updates));
};
const requests = async (cwd: string) =>
  (await Effect.runPromise(fs.readFileString(join(cwd, "requests.jsonl"))))
    .trim()
    .split("\n")
    .map((line) => JSON.parse(line) as { method: string; params: Record<string, unknown> });
describe("Muse native MSP runtime", () => {
  it("streams text once, confirms model selection, and applies native reasoning effort", async () => {
    const input = await fixture();
    const events: AcpSessionRuntimeEvent[] = [];
    await run(
      Effect.gen(function* () {
        const runtime = yield* makeMuseRuntime(input);
        yield* runtime.start();
        yield* listen(runtime);
        yield* runtime.getEvents().pipe(
          Stream.runForEach((event) =>
            event._tag === "EventStreamBarrier"
              ? Deferred.succeed(event.acknowledge, undefined)
              : Effect.sync(() => {
                  events.push(event);
                }),
          ),
          Effect.forkScoped,
        );
        yield* runtime.setModel("muse-wonder-full");
        yield* runtime.setConfigOption("reasoningEffort", "max");
        expect(
          (yield* runtime.prompt({
            prompt: [{ type: "text", text: "hello" }],
          })).stopReason,
        ).toBe("end_turn");
        yield* runtime.drainEvents;
      }),
    );
    expect(
      events
        .filter((e) => e._tag === "ContentDelta")
        .map((e) => e.text)
        .join(""),
    ).toBe("Hello Muse");
    const calls = await Effect.runPromise(fs.readFileString(join(input.cwd, "requests.jsonl")));
    expect(calls).toContain("session/setReasoningEffort");
    expect(calls).toContain("muse-wonder-full");
  });
  it("surfaces only native once-scoped approval choices", async () => {
    const input = await fixture();
    await run(
      Effect.gen(function* () {
        const runtime = yield* makeMuseRuntime(input);
        yield* runtime.start();
        yield* listen(runtime);
        yield* runtime.handleRequestPermission((request) =>
          Effect.sync(() => {
            expect(request.options.map((o) => o.optionId)).toEqual(["once", "deny"]);
            return { outcome: { outcome: "selected" as const, optionId: "once" } };
          }),
        );
        expect(
          (yield* runtime.prompt({
            prompt: [{ type: "text", text: "approve" }],
          })).stopReason,
        ).toBe("end_turn");
      }),
    );
  });
  it("recovers an approval replayed before resume returns exactly once", async () => {
    const input = await fixture({ MUSE_TEST_RESUME: "1" });
    let count = 0;
    await run(
      Effect.gen(function* () {
        const r = yield* makeMuseRuntime({ ...input, resumeSessionId: "native-muse-session" });
        const asked = yield* Deferred.make<void>();
        yield* r.handleRequestPermission(() =>
          Effect.gen(function* () {
            count++;
            yield* Deferred.succeed(asked, undefined);
            return { outcome: { outcome: "selected" as const, optionId: "deny" } };
          }),
        );
        yield* r.start();
        yield* Deferred.await(asked);
      }),
    );
    expect(count).toBe(1);
  });
  it("declines unsupported live questions instead of leaving a turn parked", async () => {
    const input = await fixture();
    await run(
      Effect.gen(function* () {
        const r = yield* makeMuseRuntime(input);
        yield* r.handleRequestPermission(() =>
          Effect.succeed({ outcome: { outcome: "cancelled" as const } }),
        );
        yield* r.start();
        expect((yield* r.prompt({ prompt: [{ type: "text", text: "question" }] })).stopReason).toBe(
          "cancelled",
        );
      }),
    );
    expect(await Effect.runPromise(fs.readFileString(join(input.cwd, "requests.jsonl")))).toContain(
      "userInput/cancel",
    );
  });
  it("cancels a running native turn", async () => {
    const input = await fixture();
    await run(
      Effect.gen(function* () {
        const runtime = yield* makeMuseRuntime(input);
        yield* runtime.start();
        const dispatched = yield* Deferred.make<void>();
        const fiber = yield* runtime
          .prompt({ prompt: [{ type: "text", text: "wait" }] }, { dispatched })
          .pipe(Effect.forkScoped);
        yield* Deferred.await(dispatched);
        yield* runtime.cancel;
        expect((yield* Fiber.join(fiber)).stopReason).toBe("cancelled");
      }),
    );
  });
  it.each([
    ["MUSE_TEST_WRONG_CWD", "workspace"],
    ["MUSE_TEST_MODEL_REFUSAL", "confirm"],
  ])("rejects invalid readback %s", async (key, message) => {
    const input = await fixture({ [key]: "1" });
    await expect(
      run(
        Effect.gen(function* () {
          const r = yield* makeMuseRuntime(input);
          yield* r.start();
          yield* r.setModel("muse-wonder-full");
        }),
      ),
    ).rejects.toMatchObject({ detail: expect.stringContaining(message) });
  });
  it("rejects invented models, API-key Full, and failed native turns", async () => {
    const input = await fixture({ META_API_KEY: "fixture-not-a-real-key" });
    await run(
      Effect.gen(function* () {
        const r = yield* makeMuseRuntime(input);
        yield* r.start();
        expect((yield* Effect.result(r.setModel("muse-wonder-full")))._tag).toBe("Failure");
        expect((yield* Effect.result(r.setModel("invented")))._tag).toBe("Failure");
        expect(
          (yield* Effect.result(
            r.prompt({
              prompt: [{ type: "text", text: "fail" }],
            }),
          ))._tag,
        ).toBe("Failure");
      }),
    );
  });
  it("connects to a newer Muse whose schema fingerprint moved within the same envelope", async () => {
    const input = await fixture({ MUSE_TEST_FINGERPRINT: `sha256:${"0".repeat(64)}` });
    const { host, client } = await connectMuse(input.settings, input.environment, input.cwd);
    try {
      expect(host.fingerprintWarning?.kind).toBe("schemaFingerprintMismatch");
      expect(host.initializeResult.serverInfo.version).toBe("1.0.0");
    } finally {
      await client.close();
    }
  });
  it("names a protocol mismatch instead of asking to install Muse", async () => {
    const input = await fixture({
      MUSE_TEST_FINGERPRINT: `sha256:${"0".repeat(64)}`,
      MUSE_TEST_SCHEMA_VERSION: "2",
    });
    const failure = await connectMuse(input.settings, input.environment, input.cwd).then(
      () => undefined,
      (error: unknown) => error,
    );
    expect(museCheckFailure(failure)).toBe(
      "Muse Code 1.0.0 speaks a protocol this SpecWithCode build does not support. Update SpecWithCode, then refresh Providers.",
    );
    expect(museCheckFailure(new Error("spawn muse ENOENT"))).toMatch(
      /Install the official muse CLI/,
    );
  });
});

describe("Muse 1.4.13 turns", () => {
  const toolItem = "01a1796a-bca3-7ae2-b997-2e832ff1a850";
  const text = (
    updates: Acp.SessionUpdate[],
    kind: "agent_message_chunk" | "agent_thought_chunk",
  ) =>
    updates
      .flatMap((u) =>
        (u.sessionUpdate === "agent_message_chunk" || u.sessionUpdate === "agent_thought_chunk") &&
        u.sessionUpdate === kind &&
        u.content.type === "text"
          ? [u.content.text]
          : [],
      )
      .join("");

  it("shows the reply, the command and its output, and asks the person first", async () => {
    const input = await fixture();
    const permissions: Acp.RequestPermissionRequest[] = [];
    const acknowledged: string[] = [];
    let updates: Acp.SessionUpdate[] = [];
    await run(
      Effect.gen(function* () {
        const runtime = yield* makeMuseRuntime({
          ...input,
          runtimeMode: "approval-required",
          onOutgoingResponse: (id) => Effect.sync(() => void acknowledged.push(id)),
        });
        yield* runtime.start();
        updates = yield* listen(runtime);
        yield* runtime.handleRequestPermission((request) =>
          Effect.sync(() => {
            permissions.push(request);
            return { outcome: { outcome: "selected" as const, optionId: "allow_once" } };
          }),
        );
        expect(
          (yield* runtime.prompt({ prompt: [{ type: "text", text: "recorded" }] })).stopReason,
        ).toBe("end_turn");
      }),
    );
    expect(text(updates, "agent_message_chunk")).toBe("MUSE_TURN_OKMUSE_APPROVAL_OK\n");
    expect(text(updates, "agent_thought_chunk")).toContain("Evaluating a conflicting instruction");
    const calls = updates.filter(
      (u): u is Extract<Acp.SessionUpdate, { toolCallId: string }> =>
        (u.sessionUpdate === "tool_call" || u.sessionUpdate === "tool_call_update") &&
        u.toolCallId === toolItem,
    );
    expect(calls[0]).toMatchObject({
      sessionUpdate: "tool_call",
      kind: "execute",
      title: "echo MUSE_APPROVAL_OK",
      rawInput: { command: "echo MUSE_APPROVAL_OK" },
    });
    expect(calls.at(-1)).toMatchObject({
      sessionUpdate: "tool_call_update",
      status: "completed",
      rawOutput: { exit_code: 0, output: "MUSE_APPROVAL_OK\n" },
    });
    // Muse's background reminder agents are not part of the reply.
    expect(JSON.stringify(updates)).not.toContain("Reminder child session");
    expect(permissions).toHaveLength(1);
    expect(permissions[0]!.toolCall).toMatchObject({
      toolCallId: toolItem,
      kind: "execute",
      title: "echo MUSE_APPROVAL_OK",
    });
    expect(permissions[0]!.options.map((o) => o.optionId)).toEqual(["allow_once", "abort"]);
    expect(acknowledged).toEqual([`${toolItem}:0`]);
    const sent = await requests(input.cwd);
    expect(sent.find((r) => r.method === "session/start")?.params).toMatchObject({
      approvalMode: "promptUnmatched",
      permissionProfile: ":ask-me",
    });
    expect(sent.find((r) => r.method === "approval/decide")?.params).toMatchObject({
      choiceId: "allow_once",
    });
  });

  it("stops the turn when the person rejects the command", async () => {
    const input = await fixture();
    await run(
      Effect.gen(function* () {
        const runtime = yield* makeMuseRuntime({ ...input, runtimeMode: "approval-required" });
        yield* runtime.start();
        yield* listen(runtime);
        yield* runtime.handleRequestPermission(() =>
          Effect.succeed({ outcome: { outcome: "selected" as const, optionId: "abort" } }),
        );
        expect(
          (yield* runtime.prompt({ prompt: [{ type: "text", text: "recorded" }] })).stopReason,
        ).toBe("cancelled");
      }),
    );
  });

  it("keeps Muse's own approval policy in full access", async () => {
    const input = await fixture();
    await run(
      Effect.gen(function* () {
        const runtime = yield* makeMuseRuntime({ ...input, runtimeMode: "full-access" });
        yield* runtime.start();
      }),
    );
    const start = (await requests(input.cwd)).find((r) => r.method === "session/start");
    expect(start?.params.approvalMode).toBe("allowAll");
    expect(start?.params).not.toHaveProperty("permissionProfile");
  });

  it("fails a completed turn that produced nothing SpecWithCode can show", async () => {
    const input = await fixture();
    const result = await run(
      Effect.gen(function* () {
        const runtime = yield* makeMuseRuntime(input);
        yield* runtime.start();
        yield* listen(runtime);
        return yield* Effect.result(
          runtime.prompt({ prompt: [{ type: "text", text: "recorded-hidden" }] }),
        );
      }),
    );
    expect(result._tag).toBe("Failure");
    expect(JSON.stringify(result)).toContain("without a reply or tool call");
  });

  it("fails instead of dropping output when nothing listens for it", async () => {
    const input = await fixture();
    const result = await run(
      Effect.gen(function* () {
        const runtime = yield* makeMuseRuntime(input);
        yield* runtime.start();
        return yield* Effect.result(runtime.prompt({ prompt: [{ type: "text", text: "hello" }] }));
      }),
    );
    expect(result._tag).toBe("Failure");
    expect(JSON.stringify(result)).toContain("not listening for Muse Code output");
  });

  it("refuses a session whose committed reviewer is not the person", () => {
    expect(() =>
      museRequireHumanReviewer({ permissionState: { reviewerAuthority: "autoReview" } }),
    ).toThrow(/automated reviewer/);
    expect(() =>
      museRequireHumanReviewer({ permissionState: { reviewerAuthority: "human" } }),
    ).not.toThrow();
    expect(() => museRequireHumanReviewer({ workspaceRoot: "/w" })).not.toThrow();
  });
});
