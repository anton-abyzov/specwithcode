import {
  ProviderDriverKind,
  ProviderSessionId,
  RuntimeRequestId,
  type OrchestrationV2ThreadProjection,
} from "@specweave-studio/contracts";
import { derivePendingThreadRequests } from "@specweave-studio/client-runtime/state/thread-requests";
import { turnItemNeedsDetailFetch } from "@specweave-studio/client-runtime/work-log/item-detail";
import { TRANSPORT_TRUNCATION_MARKER } from "@specweave-studio/shared/toolOutput";
import * as DateTime from "effect/DateTime";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vite-plus/test";

import { ComposerPendingApprovalPanel } from "./ComposerPendingApprovalPanel";

describe("ComposerPendingApprovalPanel", () => {
  it("keeps the complete command readable in the compact row", () => {
    const detail = `bun run release -- ${"x".repeat(500)}\nsecond line`;
    const markup = renderToStaticMarkup(
      <ComposerPendingApprovalPanel
        approval={{
          requestId: RuntimeRequestId.make("approval-1"),
          requestKind: "command",
          createdAt: "2026-07-18T00:00:00.000Z",
          detail,
          responseCapability: "live",
        }}
        pendingCount={1}
      />,
    );

    expect(markup).toContain(detail);
    expect(markup).not.toContain("Command approval requested");
  });

  it("falls back to the approval kind when the provider sends an empty detail", () => {
    const markup = renderToStaticMarkup(
      <ComposerPendingApprovalPanel
        approval={{
          requestId: RuntimeRequestId.make("approval-2"),
          requestKind: "file-read",
          responseCapability: "live" as const,
          createdAt: "2026-07-18T00:00:00.000Z",
          detail: "",
        }}
        pendingCount={1}
      />,
    );

    expect(markup).toContain("File read approval");
  });

  it("shows the app name and message for an MCP access request", () => {
    const markup = renderToStaticMarkup(
      <ComposerPendingApprovalPanel
        approval={{
          requestId: RuntimeRequestId.make("approval-safari"),
          requestKind: "mcp-elicitation",
          responseCapability: "live" as const,
          createdAt: "2026-08-24T00:00:00.000Z",
          appName: "Safari",
          detail: "Allow ChatGPT to use Safari?",
        }}
        pendingCount={1}
      />,
    );

    expect(markup).toContain(">Safari<");
    expect(markup).toContain("Allow ChatGPT to use Safari?");
  });

  it("preserves the full app name and approval message", () => {
    const appName = "A".repeat(200);
    const detail = "Allow ChatGPT to access the selected application?";
    const markup = renderToStaticMarkup(
      <ComposerPendingApprovalPanel
        approval={{
          requestId: RuntimeRequestId.make("approval-long-app-name"),
          requestKind: "mcp-elicitation",
          responseCapability: "live" as const,
          createdAt: "2026-08-24T00:00:00.000Z",
          appName,
          detail,
        }}
        pendingCount={1}
      />,
    );

    expect(markup).toContain(appName);
    expect(markup).toContain(detail);
  });
});

describe("file approval details", () => {
  const approval = {
    requestId: RuntimeRequestId.make("edit-request"),
    requestKind: "file-change" as const,
    createdAt: "2026-10-14T00:00:00Z",
    responseCapability: "live" as const,
    detail: "Changed files",
    fileChange: { fileName: `/workspace/${"deep folder/".repeat(20)}value.cjs` },
  };
  it("shows the full path and honest missing-preview state without guessing a native exit", () => {
    const markup = renderToStaticMarkup(
      <ComposerPendingApprovalPanel approval={approval} pendingCount={1} />,
    );
    expect(markup).toContain(approval.fileChange.fileName);
    expect(markup).toContain("Preview unavailable");
    expect(markup).not.toContain("Provider process is gone");
    expect(markup).toContain('aria-label="File path"');
    expect(markup).toContain('tabindex="0"');
  });
  it("renders only actual supplied patch text, escaping markup", () => {
    const markup = renderToStaticMarkup(
      <ComposerPendingApprovalPanel
        approval={{
          ...approval,
          fileChange: { ...approval.fileChange, diffStr: "-old\n+<script>bad</script>" },
        }}
        pendingCount={1}
      />,
    );
    expect(markup).toContain("-old\n+&lt;script&gt;bad&lt;/script&gt;");
    expect(markup).not.toContain("Preview unavailable");
    expect(markup).toContain('aria-label="Supplied patch"');
  });
  it("keeps structured paths and their supplied patches paired", () => {
    const markup = renderToStaticMarkup(
      <ComposerPendingApprovalPanel
        approval={{
          ...approval,
          fileChange: {
            fileName: "2 files",
            changes: [
              {
                operation: "move",
                path: "/workspace/new.cjs",
                oldPath: "/workspace/old.cjs",
                diffStr: "-before\n+after",
              },
              { operation: "update", path: "/workspace/next.cjs" },
            ],
          },
        }}
        pendingCount={1}
      />,
    );
    expect(markup).toContain("/workspace/old.cjs");
    expect(markup).toContain("/workspace/new.cjs");
    expect(markup).toContain("/workspace/next.cjs");
    expect(markup).toContain("-before\n+after");
    expect(markup.match(/Preview unavailable/g)).toHaveLength(1);
  });
  it("retains the original prompt and missing preview when details cannot be correlated", () => {
    const { fileChange: _, ...withoutFile } = approval;
    const markup = renderToStaticMarkup(
      <ComposerPendingApprovalPanel approval={withoutFile} pendingCount={1} />,
    );
    expect(markup).toContain("Changed files");
    expect(markup).toContain("Preview unavailable");
  });
});

describe("Codex approval previews from the timeline item", () => {
  type Projection = Parameters<typeof derivePendingThreadRequests>[0];
  type Item = OrchestrationV2ThreadProjection["turnItems"][number];
  const codex = ProviderDriverKind.make("codex");
  const now = DateTime.makeUnsafe("2026-10-24T12:00:00.000Z");
  const requestId = RuntimeRequestId.make("codex-patch-approval");
  const base = {
    threadId: "thread-1",
    runId: "run-1",
    nodeId: "node-1",
    providerThreadId: "codex-thread",
    providerTurnId: "codex-turn",
    parentItemId: null,
    ordinal: 0,
    status: "waiting",
    title: null,
    startedAt: now,
    completedAt: null,
    updatedAt: now,
  };
  const largePatch = `--- a/src/large.ts\n+++ b/src/large.ts\n@@ -1,4000 +1,4000 @@\n${"-old line\n+new line\n".repeat(4_000)}`;
  // Each change's patch stays on the wire, cut at 32 KiB with the transport marker.
  const wireChanges = [
    {
      operation: "update",
      path: "/workspace/src/small.ts",
      diffStr: "--- a/src/small.ts\n+++ b/src/small.ts\n@@ -1 +1 @@\n-a\n+b\n",
    },
    {
      operation: "update",
      path: "/workspace/src/large.ts",
      diffStr: `${largePatch.slice(0, 32 * 1024)}${TRANSPORT_TRUNCATION_MARKER}`,
      additions: 4_000,
      deletions: 4_000,
    },
    {
      operation: "add",
      path: "/workspace/src/new.ts",
      diffStr: "--- /dev/null\n+++ b/src/new.ts\n@@ -0,0 +1 @@\n+export {};\n",
    },
  ];
  const fileItem = {
    ...base,
    id: "codex-file",
    type: "file_change",
    fileName: "/workspace/src/small.ts",
    nativeItemRef: { driver: codex, nativeId: "call-1", strength: "strong" },
    diffOmitted: true,
    changes: wireChanges,
  } as unknown as Item;
  const projection = {
    thread: { id: base.threadId },
    runtimeRequests: [
      {
        id: requestId,
        nodeId: base.nodeId,
        providerTurnId: base.providerTurnId,
        nativeRequestRef: { driver: codex, nativeId: "approval-1", strength: "weak" },
        kind: "file-change",
        status: "pending",
        responseCapability: {
          type: "live",
          providerSessionId: ProviderSessionId.make("codex-session"),
        },
        createdAt: now,
        resolvedAt: null,
      },
    ],
    turnItems: [
      {
        ...base,
        id: "codex-approval",
        type: "approval_request",
        requestId,
        requestKind: "file-change",
        prompt: "Apply these changes?",
        nativeItemRef: { driver: codex, nativeId: "call-1", strength: "weak" },
      },
      fileItem,
    ],
  } as unknown as Projection;

  it("shows every supplied patch, with the marker on the one the wire cut", () => {
    const approval = derivePendingThreadRequests(projection).approvals[0]!;
    const markup = renderToStaticMarkup(
      <ComposerPendingApprovalPanel approval={approval} pendingCount={1} />,
    );
    expect(markup.match(/aria-label="Supplied patch"/g)).toHaveLength(3);
    for (const change of wireChanges) expect(markup).toContain(change.diffStr);
    expect(markup).toContain(`${TRANSPORT_TRUNCATION_MARKER}</code>`);
    expect(markup).not.toContain("Preview unavailable");
    // The edit row reads the full patch, because the wire says it cut one.
    expect(turnItemNeedsDetailFetch(fileItem)).toBe(true);
  });
});
