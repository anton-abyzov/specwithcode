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
import type { AcpSessionRuntimeEvent } from "../acp/AcpSessionRuntime.ts";
const fs = Effect.runSync(Effect.provide(FileSystem.FileSystem, NodeFileSystem.layer));

const dirs: string[] = [];
afterEach(async () => {
  await Promise.all(dirs.splice(0).map((path) => Effect.runPromise(fs.remove(path, { recursive: true, force: true }))));
});
async function fixture(env: Record<string, string> = {}) {
  const cwd = await Effect.runPromise(fs.makeTempDirectory({ prefix: "studio-muse-test-" }));
  dirs.push(cwd);
  await Effect.runPromise(
    fs.copyFile(
      fileURLToPath(new URL("./fixtures/serve.cjs", import.meta.url)), join(cwd, "serve"),
    ));
  return {
    cwd,
    settings: { enabled: true, binaryPath: process.execPath },
    environment: { ...process.env, MUSE_TEST_FINGERPRINT: EXPECTED_SCHEMA_FINGERPRINT, ...env },
  };
}
const run = <A, E>(effect: Effect.Effect<A, E, import("effect/Scope").Scope>) =>
  Effect.runPromise(Effect.scoped(effect));
describe("Muse native MSP runtime", () => {
  it("streams text once, confirms model selection, and applies native reasoning effort", async () => {
    const input = await fixture();
    const events: AcpSessionRuntimeEvent[] = [];
    await run(
      Effect.gen(function* () {
        const runtime = yield* makeMuseRuntime(input);
        yield* runtime.start();
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
    expect(await Effect.runPromise(fs.readFileString(join(input.cwd, "requests.jsonl")))).toContain("userInput/cancel");
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
});
