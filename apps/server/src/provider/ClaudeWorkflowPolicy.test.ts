import { assert, describe, it } from "@effect/vitest";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { OrchestrationV2PendingBackgroundTask } from "@specweave-studio/contracts";
import * as Schema from "effect/Schema";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";

import {
  claudeHumanMessageOrigin,
  ClaudeSubagentPromptFileError,
  compileClaudeWorkflowPolicy,
  mergeClaudeWorkflowSettings,
  readClaudeInChromeDefault,
  readClaudeSubagentPromptFile,
} from "./ClaudeWorkflowPolicy.ts";
import { STUDIO_HEADLESS_INSTRUCTIONS } from "./RuntimeInstructions.ts";

const decodePendingTask = Schema.decodeSync(OrchestrationV2PendingBackgroundTask);

describe("Claude workflow policy", () => {
  it("preserves inline and file worker additions in one conflict-free append", () => {
    const extraArgs = {
      "append-subagent-system-prompt": "Existing inline worker rules",
      "append-subagent-system-prompt-file": "worker rules.txt",
    };
    const policy = compileClaudeWorkflowPolicy({
      agentInstructions: "Global and project rules",
      extraArgs,
      subagentPromptFileContents: "Existing file worker rules",
      environment: {},
    });
    assert.include(policy.instructions, "Existing inline worker rules");
    assert.include(policy.instructions, "Existing file worker rules");
    assert.include(policy.instructions, "Global and project rules");
    assert.include(policy.instructions, STUDIO_HEADLESS_INSTRUCTIONS);
    assert.equal(policy.extraArgs["append-subagent-system-prompt"], policy.instructions);
    assert.notProperty(policy.extraArgs, "append-subagent-system-prompt-file");
    assert.equal(extraArgs["append-subagent-system-prompt-file"], "worker rules.txt");
    assert.throws(
      () => compileClaudeWorkflowPolicy({ extraArgs, environment: {} }),
      "must be resolved before compiling",
    );
  });

  it.effect("reads the Claude in Chrome default from the Claude Code config", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const home = yield* fs.makeTempDirectoryScoped({ prefix: "studio-claude-home-" });
      assert.isFalse(yield* readClaudeInChromeDefault({ configDir: undefined, homeDir: home }));
      yield* fs.writeFileString(
        path.join(home, ".claude.json"),
        '{"numStartups": 3, "claudeInChromeDefaultEnabled": true}',
      );
      assert.isTrue(yield* readClaudeInChromeDefault({ configDir: undefined, homeDir: home }));
      const configDir = path.join(home, "alt");
      yield* fs.makeDirectory(configDir);
      yield* fs.writeFileString(
        path.join(configDir, ".claude.json"),
        '{"claudeInChromeDefaultEnabled": false}',
      );
      assert.isFalse(yield* readClaudeInChromeDefault({ configDir, homeDir: home }));
    }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
  );

  it.effect("reads a relative worker instruction file at the query boundary", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const cwd = yield* fs.makeTempDirectoryScoped({ prefix: "studio-worker-instructions-" });
      yield* fs.writeFileString(path.join(cwd, "worker rules.txt"), "Existing worker file rules\n");
      assert.equal(
        yield* readClaudeSubagentPromptFile({
          cwd,
          launchArgs: '--append-subagent-system-prompt-file "worker rules.txt"',
        }),
        "Existing worker file rules\n",
      );
    }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
  );

  it.effect(
    "bounds worker files and reports unreadable files without exposing paths or contents",
    () =>
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const path = yield* Path.Path;
        const cwd = yield* fs.makeTempDirectoryScoped({ prefix: "studio-worker-instructions-" });
        yield* fs.writeFileString(path.join(cwd, "large.txt"), "x".repeat(256 * 1024 + 1));
        for (const [file, reason] of [
          ["large.txt", "too_large"],
          ["private-missing.txt", "unreadable"],
        ] as const) {
          const error = yield* readClaudeSubagentPromptFile({
            cwd,
            launchArgs: `--append-subagent-system-prompt-file ${file}`,
          }).pipe(
            Effect.catchTags({ ClaudeSubagentPromptFileError: (error) => Effect.succeed(error) }),
          );
          assert.instanceOf(error, ClaudeSubagentPromptFileError);
          if (error === undefined || typeof error === "string")
            throw new Error("Expected bounded file error");
          assert.equal(error.reason, reason);
          assert.notInclude(error.message, cwd);
          assert.notInclude(error.message, file);
        }
      }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
  );

  it("workflow roster schema preserves native progress and legacy tasks remain readable", () => {
    assert.deepEqual(decodePendingTask({ taskId: "legacy" }), {
      taskId: "legacy",
      kind: "background_task",
    });
    assert.deepEqual(
      decodePendingTask({
        taskId: "workflow",
        kind: "workflow",
        description: "Audit",
        progress: "Verify: first",
      }),
      { taskId: "workflow", kind: "workflow", description: "Audit", progress: "Verify: first" },
    );
  });
  it("preserves native settings while overriding workflow policy", () => {
    assert.deepEqual(
      mergeClaudeWorkflowSettings('{"alwaysThinkingEnabled":false,"ultracode":true}', {
        enableWorkflows: true,
        ultracode: false,
      }),
      { alwaysThinkingEnabled: false, enableWorkflows: true, ultracode: false },
    );
    assert.throws(
      () => mergeClaudeWorkflowSettings("/settings.json", { ultracode: true }),
      "requires settings as an object or JSON object",
    );
  });
  it("propagates shared and mandatory instructions through the native worker flag", () => {
    const policy = compileClaudeWorkflowPolicy({
      agentInstructions: "Environment rules\nProject rules",
      orchestrationInstructions: "Studio orchestration rules",
      environment: {},
    });
    assert.include(policy.instructions, "Environment rules\nProject rules");
    assert.include(policy.instructions, STUDIO_HEADLESS_INSTRUCTIONS);
    assert.include(policy.instructions, "Studio orchestration rules");
    assert.equal(policy.extraArgs["append-subagent-system-prompt"], policy.instructions);
  });

  it("gives leads and workflow workers the chosen response style", () => {
    const concise = compileClaudeWorkflowPolicy({ environment: {} });
    assert.include(concise.instructions, '<response_style mode="concise">');
    assert.include(
      concise.extraArgs["append-subagent-system-prompt"],
      "a few plain sentences and the path or link that proves it",
    );
    const detailed = compileClaudeWorkflowPolicy({ responseStyle: "detailed", environment: {} });
    assert.include(detailed.instructions, '<response_style mode="detailed">');
    assert.notInclude(detailed.instructions, '<response_style mode="concise">');
  });

  it("disabled blocks workflow even when raw flags request ultracode or allow it", () => {
    const policy = compileClaudeWorkflowPolicy({
      mode: "disabled",
      extraArgs: { effort: "ultracode", "append-subagent-system-prompt": "replace runtime rules" },
      allowedTools: ["Read", "Workflow", "Workflow(research)"],
      disallowedTools: ["Bash"],
      environment: { CLAUDE_CODE_DISABLE_WORKFLOWS: "0", OTHER_SETTING: "keep" },
    });
    assert.deepEqual(policy.settings, { enableWorkflows: false, ultracode: false });
    assert.deepEqual(policy.allowedTools, ["Read"]);
    assert.deepEqual(policy.disallowedTools, ["Bash", "Workflow"]);
    assert.equal(policy.environment.CLAUDE_CODE_DISABLE_WORKFLOWS, "1");
    assert.equal(policy.environment.OTHER_SETTING, "keep");
    assert.equal(policy.extraArgs.effort, "xhigh");
    assert.include(policy.extraArgs["append-subagent-system-prompt"], STUDIO_HEADLESS_INSTRUCTIONS);
  });

  it("automatic enables native ultracode without selecting a reasoning effort or preapproving runs", () => {
    const policy = compileClaudeWorkflowPolicy({ mode: "automatic", environment: {} });
    assert.deepEqual(policy.settings, { enableWorkflows: true, ultracode: true });
    assert.isUndefined(policy.extraArgs.effort);
    assert.isUndefined(policy.allowedTools);
  });

  it("lets the thread toggle choose ultracode unless workflows are disabled", () => {
    const ultracode = (
      mode: "disabled" | "on-request" | "automatic",
      toggle: boolean | undefined,
    ) =>
      compileClaudeWorkflowPolicy({ mode, ultracode: toggle, environment: {} }).settings.ultracode;
    assert.deepEqual(
      (["disabled", "on-request", "automatic"] as const).map((mode) => [
        ultracode(mode, undefined),
        ultracode(mode, true),
        ultracode(mode, false),
      ]),
      [
        [false, false, false],
        [false, true, false],
        [true, true, false],
      ],
    );
    assert.isTrue(
      compileClaudeWorkflowPolicy({ extraArgs: { effort: "ultracode" }, environment: {} }).settings
        .ultracode,
    );
  });

  it("on-request disables automatic orchestration and preserves native permissions", () => {
    const policy = compileClaudeWorkflowPolicy({
      mode: "on-request",
      allowedTools: ["Read"],
      disallowedTools: ["Workflow(research)"],
      environment: { CLAUDE_CODE_DISABLE_WORKFLOWS: "1" },
    });
    assert.deepEqual(policy.settings, { enableWorkflows: true, ultracode: false });
    assert.deepEqual(policy.allowedTools, ["Read"]);
    assert.deepEqual(policy.disallowedTools, ["Workflow(research)"]);
    assert.equal(policy.environment.CLAUDE_CODE_DISABLE_WORKFLOWS, "1");
  });
});

describe("Claude human origin", () => {
  it.each(["web", "mobile"])("attributes an actual %s user prompt", (creationSource) => {
    assert.deepEqual(claudeHumanMessageOrigin({ createdBy: "user", creationSource }), {
      kind: "human",
    });
  });
  it.each([
    { createdBy: "agent", creationSource: "web" },
    { createdBy: "system", creationSource: "server" },
    { createdBy: "user", creationSource: "mcp" },
    { createdBy: "user", creationSource: "provider" },
    { createdBy: "user", creationSource: "server" },
    { createdBy: "user", creationSource: "web", scheduledTaskId: "schedule" },
    { createdBy: "user", creationSource: "web", senderThreadId: "peer" },
  ])("does not promote delivered text to human origin: %j", (message) => {
    assert.isUndefined(claudeHumanMessageOrigin(message));
  });
});
