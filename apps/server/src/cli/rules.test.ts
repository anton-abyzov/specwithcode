// @effect-diagnostics nodeBuiltinImport:off - CLI integration reads candidate files from a temporary folder.
import * as NodeFS from "node:fs";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";

import * as NodeServices from "@effect/platform-node/NodeServices";
import * as NetService from "@specweave-studio/shared/Net";
import { assert, describe, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Layer from "effect/Layer";
import * as TestConsole from "effect/testing/TestConsole";
import { Command } from "effect/cli";

import { cli } from "../binCli.ts";

const runCli = (args: ReadonlyArray<string>) =>
  Command.runWith(cli, { version: "0.0.0" })(args).pipe(
    Effect.provide(Layer.mergeAll(NodeServices.layer, NetService.layer, TestConsole.layer)),
  );

const withFile = <A, E, R>(body: string, use: (path: string) => Effect.Effect<A, E, R>) =>
  Effect.acquireUseRelease(
    Effect.sync(() => {
      const folder = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "studio-rules-cli-"));
      const path = NodePath.join(folder, "team-rules.json");
      NodeFS.writeFileSync(path, body);
      return path;
    }),
    use,
    (path) => Effect.sync(() => NodeFS.rmSync(NodePath.dirname(path), { recursive: true })),
  );

const RULES = JSON.stringify({
  version: 1,
  owner: "Acme Engineering",
  contact: "https://it.acme.example/ai",
  agents: { ceiling: "auto-accept-edits", routines: "approval-required" },
  ai: { providers: ["claudeAgent"], models: ["claude-*"] },
  zones: [{ remote: "github.com/acme/payments*" }],
});

const output = TestConsole.logLines.pipe(Effect.map((lines) => lines.join("\n")));

describe("specweave-studio rules", () => {
  it.effect("check passes a valid candidate and exits non-zero on an invalid one", () =>
    Effect.gen(function* () {
      yield* withFile(RULES, (path) => runCli(["rules", "check", "--file", path]));
      assert.include(yield* output, "is valid. Set by Acme Engineering");
      const invalid = yield* withFile('{"version":1,"owner":"A","agentz":{}}', (path) =>
        Effect.exit(runCli(["rules", "check", "--file", path])),
      );
      assert.isTrue(Exit.isFailure(invalid));
      assert.include(String(Exit.isFailure(invalid) ? invalid.cause : ""), "agentz");
      const missing = yield* Effect.exit(
        runCli(["rules", "check", "--file", "/nonexistent/team-rules.json"]),
      );
      assert.isTrue(Exit.isFailure(missing));
    }),
  );

  it.effect("show prints the rules, what is not enforced and what they cannot do", () =>
    withFile(RULES, (path) =>
      Effect.gen(function* () {
        yield* runCli(["rules", "show", "--file", path]);
        const text = yield* output;
        assert.include(text, "Broadest permission: Auto-accept edits");
        assert.include(text, "Broadest for routines: Supervised");
        assert.include(text, "Declared, not enforced yet: zones");
        assert.include(text, "It is not a sandbox.");
      }),
    ),
  );

  it.effect("show --json prints the client summary", () =>
    withFile(RULES, (path) =>
      Effect.gen(function* () {
        yield* runCli(["rules", "show", "--json", "--file", path]);
        const parsed = JSON.parse(yield* output) as { status: string; ceiling: string };
        assert.strictEqual(parsed.status, "active");
        assert.strictEqual(parsed.ceiling, "auto-accept-edits");
      }),
    ),
  );

  it.effect("explain judges a mode, a routine, a provider and a model", () =>
    withFile(RULES, (path) =>
      Effect.gen(function* () {
        yield* runCli(["rules", "explain", "--file", path, "--mode", "full-access"]);
        yield* runCli(["rules", "explain", "--file", path, "--mode", "auto-accept-edits"]);
        yield* runCli([
          "rules",
          "explain",
          "--file",
          path,
          "--routine",
          "--mode",
          "auto-accept-edits",
        ]);
        yield* runCli(["rules", "explain", "--file", path, "--provider", "codex"]);
        yield* runCli([
          "rules",
          "explain",
          "--file",
          path,
          "--provider",
          "claudeAgent",
          "--model",
          "gpt-5.5",
        ]);
        yield* runCli(["rules", "explain", "--file", path, "--provider", "claudeAgent"]);
        const text = yield* output;
        assert.include(text, "Refused: Acme Engineering's rules allow up to Auto-accept edits");
        assert.include(text, "Allowed: Auto-accept edits is within");
        assert.include(text, "allow routines up to Supervised");
        assert.include(text, "do not approve the provider codex");
        assert.include(text, "do not approve the model gpt-5.5");
        assert.include(text, "Allowed: claudeAgent is within");
      }),
    ),
  );
});
