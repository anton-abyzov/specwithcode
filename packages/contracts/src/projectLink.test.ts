import { describe, expect, it } from "@effect/vitest";
import * as Schema from "effect/Schema";

import {
  AuthFilesystemReadScope,
  AuthOrchestrationOperateScope,
  AuthOrchestrationReadScope,
  AuthSettingsWriteScope,
} from "./auth.ts";
import { clientRpcRequiredScopes } from "./clientRpcPermissions.ts";
import {
  allocateNoteName,
  keepBothNoteName,
  NOTE_NAME_ALLOCATION_TRIES,
  ProjectLinkError,
  ProjectLinkNoteWrite,
  ProjectUnlinkInput,
} from "./projectLink.ts";
import { ProjectMemoryName } from "./projectWorkspace.ts";
import { WS_METHODS } from "./rpc.ts";

describe("project link contracts", () => {
  it.each([
    WS_METHODS.projectLinkPrepare,
    WS_METHODS.projectLinkAccept,
    WS_METHODS.projectLinkCommit,
    WS_METHODS.projectUnlink,
    WS_METHODS.projectLinkReplicate,
    WS_METHODS.projectLinkMemoryMerge,
    WS_METHODS.projectTakeover,
    WS_METHODS.projectSupersede,
    WS_METHODS.projectSetStandby,
    WS_METHODS.projectAcceptStandby,
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
    expect(clientRpcRequiredScopes(WS_METHODS.projectLinkMemoryExport, {})).toEqual([
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
  it("allocates a kept-both name that holds nothing else, reusing only identical text", () => {
    const allocate = (taken: Map<string, string>, content = "joining plan") =>
      allocateNoteName({ base: "plan.md", suffix: "M4", content, taken });
    const free = new Map([["plan.md", "kept plan"]]);
    expect(allocate(free)).toBe("plan-m4.md");
    // The chosen name is reserved for the rest of the batch.
    expect(free.get("plan-m4.md")).toBe("joining plan");
    expect(allocate(free, "another plan")).toBe("plan-m4-2.md");
    const taken = new Map([["plan-m4.md", "kept on purpose"]]);
    expect(allocate(taken)).toBe("plan-m4-2.md");
    expect(taken.get("plan-m4.md")).toBe("kept on purpose");
    // A retry finds the copy its first attempt wrote.
    const retried = new Map([
      ["plan-m4.md", "kept on purpose"],
      ["plan-m4-2.md", "joining plan"],
    ]);
    expect(allocate(retried)).toBe("plan-m4-2.md");
    expect(allocate(new Map([["plan-m4.md", "joining plan"]]))).toBe("plan-m4.md");
  });
  it("keeps long allocated names valid and gives up after a bounded search", () => {
    const base = `${"n".repeat(127 - 3)}.md`.slice(0, 128);
    const taken = new Map<string, string>();
    const names = Array.from({ length: 12 }, (_, index) =>
      allocateNoteName({ base, suffix: "Anton's MacBook M4MAX", content: `v${index}`, taken }),
    );
    expect(new Set(names).size).toBe(12);
    for (const name of names) {
      expect(name!.length).toBeLessThanOrEqual(128);
      expect(Schema.is(ProjectMemoryName)(name)).toBe(true);
    }
    expect(names[11]).toMatch(/-12\.md$/u);
    const full = new Map<string, string>();
    for (let index = 0; index < NOTE_NAME_ALLOCATION_TRIES; index += 1)
      expect(
        allocateNoteName({ base: "plan.md", suffix: "M4", content: `v${index}`, taken: full }),
      ).not.toBeNull();
    expect(
      allocateNoteName({ base: "plan.md", suffix: "M4", content: "one more", taken: full }),
    ).toBeNull();
    expect(full.size).toBe(NOTE_NAME_ALLOCATION_TRIES);
  });
  it("marks kept-both writes create-only, optional for older peers", () => {
    const decode = Schema.decodeUnknownSync(ProjectLinkNoteWrite);
    const write = { name: "plan-m4.md", content: "x", expectedRevision: null };
    expect(decode(write)).toEqual(write);
    expect(decode({ ...write, createOnly: true }).createOnly).toBe(true);
    expect(() => decode({ ...write, createOnly: false })).toThrow();
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
