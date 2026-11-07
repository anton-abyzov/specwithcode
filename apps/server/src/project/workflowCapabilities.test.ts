import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, it } from "@effect/vitest";
import { describe, expect } from "vite-plus/test";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";
import {
  checkWorkflow,
  codexToolInventory,
  explicitlyInvokedSkills,
  hasWorkflowInvocationSyntax,
  parseWorkflowDeclaration,
} from "./workflowCapabilities.ts";
const scope = {
  environmentId: "a",
  instanceId: "codex",
  workspaceRoot: "/repo",
  sessionId: "s",
  providerThreadId: "native-a",
  nativeThreadId: "native-id-a",
  threadId: "t",
};
describe("workflow declarations", () => {
  it("accepts bounded portable dependencies with CRLF and BOM", () => {
    const text =
      "\uFEFF---\r\nname: example\r\nmetadata:\r\n  specwithcode:\r\n    requires:\r\n      binaries: [ffmpeg]\r\n      tools: [mcp__mail__read]\r\n---\r\n";
    expect(parseWorkflowDeclaration(text)).toEqual({
      state: "declared",
      requires: { binaries: ["ffmpeg"], tools: ["mcp__mail__read"] },
    });
    expect(parseWorkflowDeclaration("---\nname: old\n---\n")).toEqual({ state: "undeclared" });
  });
  it("does not accept credentials or probes, or hide malformed declarations", () => {
    for (const requires of [
      "command: echo",
      "env: {TOKEN: secret}",
      'binaries: ["$(echo bad)"]',
      'tools: ["https://example.invalid"]',
    ])
      expect(
        parseWorkflowDeclaration(
          `---\nmetadata:\n  specwithcode:\n    requires:\n      ${requires}\n---\n`,
        ).state,
      ).toBe("invalid");
    expect(parseWorkflowDeclaration("---\nmetadata: [specwithcode\n---\n").state).toBe("invalid");
  });
  it("uses only exact known invocation ids, preserving currency and unrelated text", () => {
    const skills = [{ name: "report", path: "/x", enabled: true }];
    expect(explicitlyInvokedSkills("$report $20 $HOME", skills)).toEqual(skills);
    expect(explicitlyInvokedSkills("/report args", skills)).toEqual(skills);
    expect(explicitlyInvokedSkills("/report-other", skills)).toEqual([]);
    expect(hasWorkflowInvocationSyntax("$20 $20k $1e6")).toBe(false);
    expect(hasWorkflowInvocationSyntax("hello")).toBe(false);
    expect(hasWorkflowInvocationSyntax("$report")).toBe(true);
  });
  it("sanitizes native metadata without exposing credentials or falsely authenticating tools", () => {
    const result = codexToolInventory(scope, [
      {
        data: [
          {
            name: "mail",
            runtimeStatus: "connected",
            tools: { read: { description: "secret" } },
            httpOrigin: "secret",
            authStatus: "oAuth",
          },
          {
            name: "denied",
            runtimeStatus: "authenticationRequired",
            tools: { write: {} },
            toolsError: "token=secret",
          },
        ],
      },
    ]);
    expect(result.tools).toEqual(["mcp__mail__read"]);
    expect(result.servers[1]?.state).toBe("denied");
    expect(JSON.stringify(result)).not.toContain("secret");
    expect(result.complete).toBe(false);
  });
});
it.effect("checks executable access without running a skill's binary", () =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const dir = yield* fs.makeTempDirectoryScoped();
    const skill = path.join(dir, "SKILL.md");
    const binary = path.join(dir, "fixture-tool");
    const marker = path.join(dir, "marker");
    yield* fs.writeFileString(
      skill,
      "---\nmetadata:\n  specwithcode:\n    requires:\n      binaries: [fixture-tool]\n---\n",
    );
    yield* fs.writeFileString(binary, `#!/bin/sh\ntouch '${marker}'\n`);
    yield* fs.chmod(binary, 0o700);
    const input = { scope, skill: { path: skill, enabled: true }, executionPath: dir };
    assert.strictEqual((yield* checkWorkflow(input)).status, "ready");
    assert.strictEqual(yield* fs.exists(marker), false);
    yield* fs.chmod(binary, 0o600);
    assert.strictEqual((yield* checkWorkflow(input)).checks[0]?.state, "denied");
    yield* fs.chmod(binary, 0o700);
    const relativeScope = { ...scope, workspaceRoot: dir };
    assert.strictEqual(
      (yield* checkWorkflow({ ...input, scope: relativeScope, executionPath: "." })).status,
      "ready",
    );
    assert.strictEqual(
      (yield* checkWorkflow({
        ...input,
        executionPath: Array(129).fill("/definitely-absent-workflow-dir").join(":"),
      })).checks[0]?.state,
      "unknown",
    );
    yield* fs.remove(binary);
    assert.strictEqual((yield* checkWorkflow(input)).checks[0]?.state, "missing");
    assert.strictEqual(
      (yield* checkWorkflow({ ...input, executionPath: undefined })).status,
      "unknown",
    );
  }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
);

it.effect("opaque native skills remain runnable with unknown dependencies", () =>
  Effect.gen(function* () {
    for (const path of ["acp://skill/review", "pi:skill:review"]) {
      const result = yield* checkWorkflow({ skill: { path, enabled: true }, scope });
      assert.strictEqual(result.status, "unknown");
      assert.strictEqual(result.declaration.state, "undeclared");
    }
  }).pipe(Effect.provide(NodeServices.layer)),
);
