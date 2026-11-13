// @effect-diagnostics nodeBuiltinImport:off -- The fixture project folder is laid out with node:fs.
import * as NodeFS from "node:fs";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";

import { afterAll, expect, it } from "@effect/vitest";
import {
  EnvironmentId,
  ProjectLibraryError,
  ProviderInstanceId,
  ThreadId,
} from "@specweave-studio/contracts";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Stream from "effect/Stream";

import * as Threads from "../../../orchestration-v2/ThreadManagementService.ts";
import { ProjectLibraryProblem } from "../../../project/ProjectLibrary.ts";
import * as ThreadReportService from "../../../project/ThreadReportService.ts";
import { saveReport } from "../../../project/ThreadReports.ts";
import * as Context from "../../McpInvocationContext.ts";
import * as Access from "../../McpToolAccess.ts";
import { liveThreadShell } from "../../McpToolAccess.testkit.ts";
import * as Handlers from "./handlers.ts";
import { reportLink } from "./handlers.ts";
import { ReportToolkit } from "./tools.ts";

const root = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "report-mcp-"));
const home = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "report-mcp-home-"));
afterAll(() => {
  NodeFS.rmSync(root, { recursive: true, force: true });
  NodeFS.rmSync(home, { recursive: true, force: true });
});
NodeFS.mkdirSync(NodePath.join(root, ".specweave/increments/1320-own-reports"), {
  recursive: true,
});

const caller = liveThreadShell(ThreadId.make("report-worker"));
const scope: Context.McpInvocationScope = {
  environmentId: EnvironmentId.make("fixture"),
  requestNamespace: "fixture",
  thread: {
    threadId: caller.id,
    providerSessionId: "fixture",
    providerInstanceId: ProviderInstanceId.make("codex"),
  },
  client: undefined,
  issuedAt: 0,
  capabilities: new Set(["orchestration" as const]),
};

const SAVED_AT = DateTime.toDateUtc(DateTime.makeUnsafe("2026-11-13T19:00:00.000Z"));

/** The real file writer behind the service, over the fixture project. */
const reports = Layer.mock(ThreadReportService.ThreadReportService)({
  saveForThread: (input) =>
    Effect.tryPromise({
      try: () =>
        saveReport(
          root,
          { threadId: input.threadId, title: "Imports", branch: null, home },
          input.text,
          SAVED_AT,
          input.options,
        ),
      catch: (error) =>
        new ProjectLibraryError({
          projectId: input.projectId,
          code: error instanceof ProjectLibraryProblem ? error.code : "operation_failed",
          detail: error instanceof Error ? error.message : "failed",
        }),
    }),
});
const layerFor = (
  invocation: Context.McpInvocationScope,
  shell: ReturnType<typeof liveThreadShell> = caller,
) =>
  Access.HandlersLayer.layer(Handlers.layer).pipe(
    Layer.provideMerge(
      Layer.mergeAll(
        reports,
        Layer.mock(Threads.ThreadManagementService)({
          getThreadShell: () => Effect.succeed(shell),
        }),
        Layer.succeed(Context.McpInvocationContext, invocation),
      ),
    ),
  );

const save = (input: Record<string, unknown>) =>
  Effect.gen(function* () {
    const toolkit = yield* ReportToolkit;
    return yield* toolkit.handle("studio_report_save", input as never).pipe(
      Stream.unwrap,
      Stream.runCollect,
      Effect.map((parts) => parts.at(-1)?.result as Record<string, unknown>),
    );
  });

const ORIGINAL = "https://claude.ai/artifact/Xq7Lm2Rt9Vb4Nc8Pd3Kf6H";
const DOC = "# Release checklist\n\n## Your calls\n\nNine decisions are yours.";

it.effect("imports another tool's document and returns a link to the saved file", () =>
  Effect.gen(function* () {
    const saved = yield* save({
      markdown: DOC,
      increment: "none",
      source: "Claude desktop",
      original: ORIGINAL,
    });
    expect(saved).toMatchObject({
      title: "Release checklist",
      increment: null,
      alreadySaved: false,
    });
    const path = saved.path as string;
    expect(path.startsWith(NodePath.join(root, ".specweave/reports/threads/"))).toBe(true);
    expect(saved.link).toBe(`[Release checklist](${path})`);
    expect(saved.link).not.toContain("claude.ai");
    const content = NodeFS.readFileSync(path, "utf8");
    expect(content).toContain(`original: "${ORIGINAL}"`);
    expect(content).toContain('source: "Claude desktop"');

    const again = yield* save({
      markdown: DOC,
      increment: "none",
      source: "Claude desktop",
      original: ORIGINAL,
    });
    expect(again).toMatchObject({ path, alreadySaved: true });
  }).pipe(Effect.provide(layerFor(scope))),
);

it.effect("files a report in the increment it names", () =>
  Effect.gen(function* () {
    const saved = yield* save({ markdown: "# Review\n\nAll green.", increment: "1320" });
    expect(saved).toMatchObject({ increment: "1320-own-reports", title: "Review" });
    expect(saved.relativePath).toMatch(/^\.specweave\/increments\/1320-own-reports\/reports\//);
  }).pipe(Effect.provide(layerFor(scope))),
);

it.effect("asks for the source of an original link and refuses a plain-http one", () =>
  Effect.gen(function* () {
    expect(yield* save({ markdown: DOC, original: ORIGINAL })).toMatchObject({
      code: "invalid_request",
      message: 'Name the tool that made the document in source, such as "Claude desktop".',
    });
    expect(
      yield* save({ markdown: DOC, source: "Claude desktop", original: "http://claude.ai/x" }),
    ).toMatchObject({ code: "invalid_request" });
    expect(yield* save({ markdown: DOC, increment: "4242" })).toMatchObject({
      code: "invalid_request",
      message: "No increment 4242 in this project.",
    });
  }).pipe(Effect.provide(layerFor(scope))),
);

it.effect("refuses a thread that plans or asks before it edits files", () =>
  Effect.gen(function* () {
    const refused = {
      code: "capability_denied",
      message:
        "This thread asks before it changes files. Write the report as Markdown in the increment's reports/ folder with your file tools, so the person can approve it.",
    };
    for (const modes of [
      { runtimeMode: "approval-required" as const },
      { runtimeMode: "full-access" as const, interactionMode: "plan" as const },
    ]) {
      const shell = liveThreadShell(caller.id, modes);
      expect(
        yield* save({ markdown: "# Plan\n\nNot yet." }).pipe(
          Effect.provide(layerFor(scope, shell)),
        ),
      ).toMatchObject(refused);
    }
    // Auto-accepted edits may save.
    const auto = liveThreadShell(caller.id, { runtimeMode: "auto-accept-edits" });
    expect(
      yield* save({ markdown: "# Auto\n\nSaved." }).pipe(Effect.provide(layerFor(scope, auto))),
    ).toMatchObject({ alreadySaved: false, title: "Auto" });
  }),
);

it.effect("refuses an MCP client outside a thread", () =>
  Effect.gen(function* () {
    expect(yield* save({ markdown: DOC })).toMatchObject({ code: "thread_credential_required" });
  }).pipe(Effect.provide(layerFor({ ...scope, thread: undefined }))),
);

it("builds a link that survives brackets in the title and spaces in the path", () => {
  expect(reportLink("Plan [draft]", "/a/b.md")).toBe("[Plan \\[draft\\]](/a/b.md)");
  expect(reportLink("Plan", "/Volumes/My Drive/b.md")).toBe("[Plan](</Volumes/My Drive/b.md>)");
});
