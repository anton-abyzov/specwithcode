// @effect-diagnostics nodeBuiltinImport:off -- The fixture project folder is laid out with node:fs.
import * as NodeFS from "node:fs";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";

import * as NodeServices from "@effect/platform-node/NodeServices";
import { afterAll, expect, it } from "@effect/vitest";
import { EnvironmentId, ProviderInstanceId, ThreadId } from "@specweave-studio/contracts";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Stream from "effect/Stream";

import * as ServerConfig from "../../../config.ts";
import * as Threads from "../../../orchestration-v2/ThreadManagementService.ts";
import * as OfficeArtifactService from "../../../project/OfficeArtifactService.ts";
import * as Context from "../../McpInvocationContext.ts";
import * as Access from "../../McpToolAccess.ts";
import { liveThreadShell } from "../../McpToolAccess.testkit.ts";
import * as Document from "./document.ts";

const root = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "office-doc-mcp-"));
afterAll(() => NodeFS.rmSync(root, { recursive: true, force: true }));
NodeFS.mkdirSync(NodePath.join(root, ".specweave"), { recursive: true });

const caller = liveThreadShell(ThreadId.make("doc-worker"));
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

const layer = Access.HandlersLayer.layer(Document.layer).pipe(
  Layer.provideMerge(
    Layer.mergeAll(
      Layer.mock(OfficeArtifactService.OfficeArtifactService)({
        projectFolder: () => Effect.succeed(root),
      }),
      Layer.mock(Threads.ThreadManagementService)({
        getThreadShell: () => Effect.succeed(caller),
      }),
      Layer.succeed(Context.McpInvocationContext, scope),
      ServerConfig.ServerConfig.layerTest(process.cwd(), { prefix: "office-doc-mcp-config-" }),
    ),
  ),
  Layer.provideMerge(NodeServices.layer),
);

const call = (tool: "doc_write" | "doc_read", input: Record<string, unknown>) =>
  Effect.gen(function* () {
    const toolkit = yield* Document.DocumentToolkit;
    return yield* toolkit.handle(tool, input as never).pipe(
      Stream.unwrap,
      Stream.runCollect,
      Effect.map((parts) => parts.at(-1)?.result as Record<string, unknown>),
    );
  });

it.effect("writes a .docx from Markdown and reads it back as structured text", () =>
  Effect.gen(function* () {
    const saved = yield* call("doc_write", {
      title: "Launch Brief",
      markdown: "## Goals\n\n- Ship **fast**\n- Stay safe\n\n| Item | Owner |\n|---|---|\n| Docs | Ann |\n",
    });
    const path = NodePath.join(root, ".specweave/artifacts/launch-brief.docx");
    expect(saved).toMatchObject({
      name: "launch-brief",
      path,
      relativePath: ".specweave/artifacts/launch-brief.docx",
      created: true,
      headings: ["Launch Brief", "Goals"],
    });
    expect(NodeFS.readFileSync(path).subarray(0, 2).toString()).toBe("PK");

    const read = yield* call("doc_read", { name: "launch-brief" });
    expect(read).toMatchObject({
      revision: saved.revision,
      outline: [
        { level: 1, text: "Launch Brief" },
        { level: 2, text: "Goals" },
      ],
      notKept: [],
      notice: Document.DOC_READ_NOTICE,
    });
    expect(read.markdown).toContain("- Ship **fast**");
    expect(read.blocks).toContainEqual({ type: "table", rows: [["Item", "Owner"], ["Docs", "Ann"]] });

    // A stale revision is refused; the current one replaces the content.
    const replaced = yield* call("doc_write", {
      name: "launch-brief",
      blocks: [{ type: "paragraph", runs: [{ text: "Replaced" }] }],
      expectedRevision: saved.revision,
    });
    expect(replaced.created).toBe(false);
    const stale = yield* call("doc_write", {
      name: "launch-brief",
      markdown: "Late",
      expectedRevision: saved.revision,
    });
    expect(String(stale.message)).toContain("changed on disk");
    const byPath = yield* call("doc_read", { path: ".specweave/artifacts/launch-brief.docx" });
    expect(byPath.markdown).toBe("Replaced\n");
  }).pipe(Effect.provide(layer)),
);

it.effect("refuses paths outside the project and bad names", () =>
  Effect.gen(function* () {
    const outside = yield* call("doc_read", { path: "../elsewhere.docx" });
    expect(outside.code).toBe("invalid_request");
    const badName = yield* call("doc_write", { name: "Bad Name!", markdown: "x" });
    expect(badName.code).toBe("invalid_request");
    const both = yield* call("doc_write", { title: "x", markdown: "x", blocks: [] });
    expect(both.code).toBe("invalid_request");
  }).pipe(Effect.provide(layer)),
);
