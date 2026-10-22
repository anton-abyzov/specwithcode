import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, it } from "@effect/vitest";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";

import {
  codexSessionDayHints,
  findClaudeSessionFile,
  findCodexSessionFile,
} from "./nativeSessionFiles.ts";

// A real Codex thread id: UUIDv7 minted on October 20, 2026 at 3:32 PM in New York.
const CODEX_ID = "01a15acc-ee93-7c13-b157-8b7c6635575c";
const newYork = DateTime.zoneMakeNamedUnsafe("America/New_York");

const home = Effect.gen(function* () {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const root = yield* fs.makeTempDirectoryScoped({ prefix: "studio-native-sessions-" });
  const write = Effect.fnUntraced(function* (relative: string) {
    const file = path.join(root, relative);
    yield* fs.makeDirectory(path.dirname(file), { recursive: true });
    yield* fs.writeFileString(file, '{"type":"session_meta"}\n');
    return file;
  });
  return { root, write };
});

it("names the local day a UUIDv7 Codex thread was created, then its neighbours", () => {
  assert.deepEqual(codexSessionDayHints(CODEX_ID, newYork), [
    "2026/10/20",
    "2026/10/19",
    "2026/10/21",
  ]);
  assert.deepEqual(codexSessionDayHints("0b878647-0b05-4925-8073-e844050d7cf4", newYork), []);
  assert.deepEqual(codexSessionDayHints("not-a-uuid", newYork), []);
});

it.effect("finds a Codex rollout by thread id on its creation day", () =>
  Effect.gen(function* () {
    const { root, write } = yield* home;
    yield* write("sessions/2026/10/22/rollout-2026-10-22T09-00-00-other.jsonl");
    const file = yield* write(`sessions/2026/10/20/rollout-2026-10-20T15-32-22-${CODEX_ID}.jsonl`);
    assert.equal(yield* findCodexSessionFile({ home: root, sessionId: CODEX_ID }), file);
  }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
);

it.effect("walks the other days for ids that carry no date, and refuses unsafe ids", () =>
  Effect.gen(function* () {
    const { root, write } = yield* home;
    const file = yield* write("sessions/2025/01/02/rollout-2025-01-02T00-00-00-legacy-id.jsonl");
    assert.equal(yield* findCodexSessionFile({ home: root, sessionId: "legacy-id" }), file);
    assert.equal(yield* findCodexSessionFile({ home: root, sessionId: "missing-id" }), null);
    assert.equal(yield* findCodexSessionFile({ home: root, sessionId: "../legacy-id" }), null);
    assert.equal(
      yield* findCodexSessionFile({ home: `${root}/absent`, sessionId: CODEX_ID }),
      null,
    );
  }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
);

it.effect("finds an archived Codex rollout, compressed or not", () =>
  Effect.gen(function* () {
    const { root, write } = yield* home;
    const file = yield* write(
      `archived_sessions/rollout-2026-02-26T00-55-42-${CODEX_ID}.jsonl.zst`,
    );
    assert.equal(yield* findCodexSessionFile({ home: root, sessionId: CODEX_ID }), file);
  }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
);

it.effect("finds a Claude Code transcript in any project folder of the home", () =>
  Effect.gen(function* () {
    const { root, write } = yield* home;
    const file = yield* write("projects/-Users-anton-sw-easychamp/0b878647.jsonl");
    assert.equal(yield* findClaudeSessionFile({ home: root, sessionId: "0b878647" }), file);
    assert.equal(yield* findClaudeSessionFile({ home: root, sessionId: "absent" }), null);
  }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
);
