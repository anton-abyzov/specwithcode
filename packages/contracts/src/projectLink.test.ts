import { describe, expect, it } from "@effect/vitest";
import * as Schema from "effect/Schema";

import {
  AuthFilesystemReadScope,
  AuthOrchestrationOperateScope,
  AuthOrchestrationReadScope,
  AuthSettingsWriteScope,
} from "./auth.ts";
import { clientRpcRequiredScopes } from "./clientRpcPermissions.ts";
import { keepBothNoteName, ProjectLinkError, ProjectUnlinkInput } from "./projectLink.ts";
import { ProjectMemoryName } from "./projectWorkspace.ts";
import { WS_METHODS } from "./rpc.ts";

describe("project link contracts", () => {
  it.each([
    WS_METHODS.projectLinkPrepare,
    WS_METHODS.projectLinkAccept,
    WS_METHODS.projectLinkCommit,
    WS_METHODS.projectUnlink,
    WS_METHODS.projectLinkReplicate,
    WS_METHODS.projectTakeover,
    WS_METHODS.projectSupersede,
  ])("requires settings write and operate for %s, like a handoff", (method) => {
    expect(clientRpcRequiredScopes(method, {})).toEqual([
      AuthSettingsWriteScope,
      AuthOrchestrationOperateScope,
    ]);
  });
  it("previews and fingerprints with read grants only", () => {
    expect(clientRpcRequiredScopes(WS_METHODS.projectLinkPreview, {})).toEqual([
      AuthOrchestrationReadScope,
      AuthFilesystemReadScope,
    ]);
    expect(clientRpcRequiredScopes(WS_METHODS.projectsFingerprint, {})).toEqual([
      AuthFilesystemReadScope,
    ]);
    expect(clientRpcRequiredScopes(WS_METHODS.projectLinkDigest, {})).toEqual([
      AuthOrchestrationReadScope,
    ]);
  });
  it("names a keep-both note with the other machine and keeps it a valid note name", () => {
    expect(keepBothNoteName("decisions.md", "MacBook Pro M3")).toBe("decisions-macbook-pro-m3.md");
    expect(keepBothNoteName("a.b.md", "Ä Mac!")).toBe("a.b-a-mac.md");
    const long = keepBothNoteName(`${"n".repeat(120)}.md`, "Anton's MacBook M4MAX");
    expect(long.length).toBeLessThanOrEqual(128);
    for (const name of [long, keepBothNoteName("x.md", "")])
      expect(Schema.is(ProjectMemoryName)(name)).toBe(true);
  });
  it("tells the two unlink sides apart", () => {
    const decode = Schema.decodeUnknownSync(ProjectUnlinkInput);
    const operationId = "11111111-1111-4111-8111-111111111111";
    expect(decode({ side: "member", operationId, projectId: "p", notes: [] }).side).toBe("member");
    expect(() => decode({ side: "coordinator", operationId, projectId: "p", notes: [] })).toThrow();
  });
  it("names the fix in every refusal", () => {
    expect(new ProjectLinkError({ code: "already_shared" }).message).toContain(
      "Unlink it there first",
    );
    expect(
      new ProjectLinkError({
        code: "repository_mismatch",
        detail: "This copy holds a; the other holds b.",
      }).message,
    ).toMatch(/same project\. This copy holds a/u);
  });
});
