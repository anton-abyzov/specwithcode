import { describe, expect, it } from "vite-plus/test";
import * as Schema from "effect/Schema";
import { ProjectId } from "./baseSchemas.ts";
import { ProjectWorkspaceError } from "./projectWorkspace.ts";

describe("project workspace error transport", () => {
  it.each([
    ["empty_message", "Enter a message"],
    ["invalid_attachments", "Attach the files again"],
    ["attachment_unavailable", "Restore or attach them again"],
    ["attachment_limit", "Reduce the count or size"],
    ["invalid_coordinator", "coordinator thread is no longer available"],
    ["invalid_source_thread", "selected worker is no longer available"],
    ["unsupported_provider", "additional project folders under the current permissions"],
  ] as const)("preserves actionable %s errors across the wire", (code, message) => {
    const error = new ProjectWorkspaceError({ projectId: ProjectId.make("project"), code });
    const encoded = Schema.encodeSync(ProjectWorkspaceError)(error);
    const decoded = Schema.decodeUnknownSync(ProjectWorkspaceError)(encoded);
    expect(decoded.code).toBe(code);
    expect(decoded.message).toContain(message);
    expect(decoded.message).not.toMatch(/memory|KiB/);
  });

  it("retains quota guidance for actual memory validation failures", () => {
    expect(
      new ProjectWorkspaceError({ projectId: ProjectId.make("project"), code: "invalid" }).message,
    ).toContain("256 KiB per file, 16 MiB and 4,096 files per project");
  });
  it("explains the existing full-access ACP alternative without changing any permissions", () => {
    const error = new ProjectWorkspaceError({
      projectId: ProjectId.make("project"),
      code: "unsupported_provider",
    });
    expect(error.message).toContain("Codex or Claude");
    expect(error.message).toContain("already running with Full access");
    expect(error.message).toContain("no restrictive sandbox or approval override");
  });
});
