import { RuntimeRequestId } from "@specweave-studio/contracts";
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
