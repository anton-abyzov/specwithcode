import { describe, expect, it } from "vite-plus/test";
import * as Schema from "effect/Schema";
import {
  AuthFilesystemReadScope,
  AuthOrchestrationOperateScope,
  AuthOrchestrationReadScope,
} from "./auth.ts";
import { clientRpcRequiredScopes } from "./clientRpcPermissions.ts";
import { ProjectKnowledgeSearchInput } from "./projectKnowledge.ts";
import { WS_METHODS } from "./rpc.ts";

describe("project knowledge contracts", () => {
  it.each([WS_METHODS.projectsKnowledgeRead, WS_METHODS.projectsKnowledgeSearch])(
    "needs both orchestration read and file read for %s, since it quotes Library files",
    (method) => {
      expect(clientRpcRequiredScopes(method, {})).toEqual([
        AuthOrchestrationReadScope,
        AuthFilesystemReadScope,
      ]);
    },
  );

  it("rebuilds the index with operate access", () => {
    expect(clientRpcRequiredScopes(WS_METHODS.projectsKnowledgeReindex, {})).toEqual([
      AuthOrchestrationOperateScope,
    ]);
  });

  it("bounds the folder a search is limited to", () => {
    const decode = Schema.decodeUnknownSync(ProjectKnowledgeSearchInput);
    expect(
      decode({ projectId: "project", query: "storage", within: ".specweave/increments/0864" })
        .within,
    ).toBe(".specweave/increments/0864");
    expect(() =>
      decode({ projectId: "project", query: "storage", within: "x".repeat(501) }),
    ).toThrow();
  });
});
