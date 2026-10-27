import * as NodeFileSystem from "@effect/platform-node/NodeFileSystem";
import * as FileSystem from "effect/FileSystem";
import { afterEach, describe, it, expect } from "vite-plus/test";
import { join } from "../../nodePath.ts";
import * as Effect from "effect/Effect";
import * as Stream from "effect/Stream";
import * as Deferred from "effect/Deferred";
import { makeMuseRuntime } from "./MuseRuntime.ts";

const fs = Effect.runSync(Effect.provide(FileSystem.FileSystem, NodeFileSystem.layer));

const directories: string[] = [];
afterEach(async () => {
  await Promise.all(
    directories
      .splice(0)
      .map((path) => Effect.runPromise(fs.remove(path, { recursive: true, force: true }))),
  );
});

// Opt-in: an official native binary, isolated XDG state and the offline echo provider.
// This does not establish subscription entitlement or exercise paid inference.
describe.skipIf(!process.env.STUDIO_MUSE_NATIVE_BINARY)("official Muse native runtime", () => {
  it("streams a real native turn and reconnects to its durable session", async () => {
    const cwd = await Effect.runPromise(fs.makeTempDirectory({ prefix: "studio-muse-native-" }));
    directories.push(cwd);
    const bin = process.env.STUDIO_MUSE_NATIVE_BINARY!;
    const wrapper = join(cwd, "muse-echo");
    await Effect.runPromise(
      fs.writeFileString(
        wrapper,
        `#!/bin/sh\nexec '${bin.replaceAll("'", "'\\''")}' "$@" --provider echo --contributor-mode off\n`,
        { mode: 0o700 },
      ),
    );
    for (const name of ["config", "data", "cache"])
      await Effect.runPromise(fs.makeDirectory(join(cwd, name)));
    const input = {
      cwd,
      settings: { enabled: true, binaryPath: wrapper },
      environment: {
        PATH: process.env.PATH,
        XDG_CONFIG_HOME: join(cwd, "config"),
        XDG_DATA_HOME: join(cwd, "data"),
        XDG_CACHE_HOME: join(cwd, "cache"),
        MUSE_AUTH_PATH: join(cwd, "auth.json"),
      },
    };
    let id = "";
    let text = "";
    let projected = "";
    await Effect.runPromise(
      Effect.scoped(
        Effect.gen(function* () {
          const runtime = yield* makeMuseRuntime(input);
          id = (yield* runtime.start()).sessionId;
          yield* runtime.handleSessionUpdate((notification) =>
            Effect.sync(() => {
              const update = notification.update;
              if (update.sessionUpdate === "agent_message_chunk" && update.content.type === "text")
                projected += update.content.text;
            }),
          );
          yield* runtime.getEvents().pipe(
            Stream.runForEach((event) =>
              event._tag === "EventStreamBarrier"
                ? Deferred.succeed(event.acknowledge, undefined)
                : Effect.sync(() => {
                    if (event._tag === "ContentDelta") text += event.text;
                  }),
            ),
            Effect.forkScoped,
          );
          expect(
            (yield* runtime.prompt({ prompt: [{ type: "text", text: "native validation hello" }] }))
              .stopReason,
          ).toBe("end_turn");
          yield* runtime.drainEvents;
        }),
      ),
    );
    expect(id).not.toBe("");
    expect(text).toContain("native validation hello");
    expect(projected).toBe(text);
    await Effect.runPromise(
      Effect.scoped(
        Effect.gen(function* () {
          const runtime = yield* makeMuseRuntime({ ...input, resumeSessionId: id });
          expect((yield* runtime.start()).sessionId).toBe(id);
        }),
      ),
    );
  }, 30000);
});
