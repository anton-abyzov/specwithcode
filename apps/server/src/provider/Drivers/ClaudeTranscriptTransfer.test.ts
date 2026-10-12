import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";

import {
  claudeHomeFromContinuationKey,
  claudeHomesDiffer,
  findClaudeTranscript,
  transferClaudeTranscript,
} from "./ClaudeTranscriptTransfer.ts";

const SLUG = "-Users-anton-repo";

const homes = Effect.gen(function* () {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const root = yield* fs.makeTempDirectoryScoped({ prefix: "studio-claude-homes-" });
  const fromHome = path.join(root, "a");
  const toHome = path.join(root, "b");
  const project = path.join(fromHome, "projects", SLUG);
  yield* fs.makeDirectory(path.join(project, "sess-1", "sub"), { recursive: true });
  yield* fs.writeFileString(path.join(project, "sess-1.jsonl"), '{"type":"user"}\n');
  yield* fs.writeFileString(path.join(project, "sess-1", "sub", "agent.jsonl"), "{}\n");
  yield* fs.makeDirectory(path.join(toHome, "projects"), { recursive: true });
  return { fs, path, fromHome, toHome };
});

it("reads the home from a Claude continuation key only", () => {
  assert.equal(claudeHomeFromContinuationKey("claude:home:/Users/a/.claude"), "/Users/a/.claude");
  assert.equal(claudeHomeFromContinuationKey("claude:home:"), null);
  assert.equal(claudeHomeFromContinuationKey("codex:account:one"), null);
  assert.ok(claudeHomesDiffer("claude:home:/a", "claude:home:/b"));
  assert.ok(!claudeHomesDiffer("claude:home:/a", "claude:home:/a/"));
  assert.ok(!claudeHomesDiffer("claude:home:/a", "codex:instance:x"));
});

it.effect("copies the transcript and its subagent folder into the other home", () =>
  Effect.gen(function* () {
    const { fs, path, fromHome, toHome } = yield* homes;
    const result = yield* transferClaudeTranscript({ fromHome, toHome, sessionId: "sess-1" });
    const target = path.join(toHome, "projects", SLUG, "sess-1.jsonl");
    assert.deepEqual(result, { status: "copied", file: target });
    assert.equal(yield* fs.readFileString(target), '{"type":"user"}\n');
    assert.equal(
      yield* fs.readFileString(path.join(toHome, "projects", SLUG, "sess-1", "sub", "agent.jsonl")),
      "{}\n",
    );
    assert.ok(!(yield* fs.exists(`${target}.${process.pid}.partial`)));
    const found = yield* findClaudeTranscript({ home: toHome, sessionId: "sess-1" });
    assert.equal(found?.projectSlug, SLUG);
    // The target is now at least as new: a second move in the same direction writes nothing.
    const again = yield* transferClaudeTranscript({ fromHome, toHome, sessionId: "sess-1" });
    assert.equal(again.status, "current");
  }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
);

it.effect("moves the newer transcript back after the other home ran the session", () =>
  Effect.gen(function* () {
    const { fs, path, fromHome, toHome } = yield* homes;
    yield* transferClaudeTranscript({ fromHome, toHome, sessionId: "sess-1" });
    const inB = path.join(toHome, "projects", SLUG, "sess-1.jsonl");
    yield* fs.writeFileString(inB, '{"type":"user"}\n{"type":"assistant"}\n');
    const later = new Date(Date.now() + 5_000);
    yield* fs.utimes(inB, later, later);
    const back = yield* transferClaudeTranscript({ fromHome: toHome, toHome: fromHome, sessionId: "sess-1" });
    assert.equal(back.status, "copied");
    assert.equal(
      yield* fs.readFileString(path.join(fromHome, "projects", SLUG, "sess-1.jsonl")),
      '{"type":"user"}\n{"type":"assistant"}\n',
    );
  }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
);

it.effect("reports a missing transcript and refuses unsafe session ids", () =>
  Effect.gen(function* () {
    const { fromHome, toHome } = yield* homes;
    assert.deepEqual(
      yield* transferClaudeTranscript({ fromHome, toHome, sessionId: "sess-2" }),
      { status: "missing" },
    );
    assert.equal(yield* findClaudeTranscript({ home: fromHome, sessionId: "../sess-1" }), null);
  }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
);
