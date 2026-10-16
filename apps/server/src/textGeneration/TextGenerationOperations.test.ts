import { it } from "@effect/vitest";
import { ProviderInstanceId } from "@specweave-studio/contracts";
import { createModelSelection } from "@specweave-studio/shared/model";
import * as Effect from "effect/Effect";
import { describe, expect } from "vite-plus/test";

import { fromRunner, type Operation, type Runner } from "./TextGenerationOperations.ts";

const modelSelection = createModelSelection(ProviderInstanceId.make("codex"), "gpt-5.4");

const CREDITS = [
  "Co-Authored-By: Claude <noreply@anthropic.com>",
  "Claude-Session: https://claude.ai/code/session_01ExampleSessionId",
  "",
  "\u{1F916} Generated with [Claude Code](https://claude.com/claude-code)",
].join("\n");

function serviceReplying(replies: Partial<Record<Operation, unknown>>) {
  // A fake provider that answers each operation with a fixed, already decoded reply.
  const run: Runner = (request) => Effect.succeed(replies[request.operation] as never);
  return fromRunner("TestTextGeneration", run);
}

describe("fromRunner output cleanup", () => {
  it.effect("strips agent credits and normalises dashes in commit messages", () =>
    Effect.gen(function* () {
      const service = serviceReplying({
        generateCommitMessage: {
          subject: "Stop the login loop — retry at most 3 times.",
          body: `- Keep the “retry” counter per session\n\n${CREDITS}`,
        },
      });
      expect(
        yield* service.generateCommitMessage({
          cwd: "/repo",
          branch: "main",
          stagedSummary: "M login.ts",
          stagedPatch: "diff",
          modelSelection,
        }),
      ).toEqual({
        subject: "Stop the login loop, retry at most 3 times",
        body: '- Keep the "retry" counter per session',
      });
    }),
  );

  it.effect("strips agent credits from pull request titles and bodies", () =>
    Effect.gen(function* () {
      const service = serviceReplying({
        generatePrContent: {
          title: "\u{1F916} Stop the login loop – retry limit",
          body: `## Summary\n- Retry at most 3 times.\n\n## Testing\n- \`pnpm test\`\n\nI hope this helps!\n\n${CREDITS}`,
        },
      });
      expect(
        yield* service.generatePrContent({
          cwd: "/repo",
          baseBranch: "main",
          headBranch: "fix/login-loop",
          commitSummary: "Stop the login loop",
          diffSummary: "1 file changed",
          diffPatch: "diff",
          modelSelection,
        }),
      ).toEqual({
        title: "Stop the login loop, retry limit",
        body: "## Summary\n- Retry at most 3 times.\n\n## Testing\n- `pnpm test`",
      });
    }),
  );

  it.effect("normalises dashes and quotes in thread titles", () =>
    Effect.gen(function* () {
      const service = serviceReplying({
        generateThreadTitle: { title: "“Login loop — Safari”" },
      });
      expect(
        yield* service.generateThreadTitle({
          cwd: "/repo",
          message: "Safari keeps looping on login",
          modelSelection,
        }),
      ).toEqual({ title: "Login loop, Safari" });
    }),
  );
});
