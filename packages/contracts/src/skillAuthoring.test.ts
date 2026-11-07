import * as Schema from "effect/Schema";
import { describe, expect, it } from "vite-plus/test";
import { SkillAuthoringInput } from "./skillAuthoring.ts";
import { clientRpcRequiredScopes } from "./clientRpcPermissions.ts";
import { WS_METHODS } from "./rpc.ts";
const decode = Schema.decodeUnknownSync(SkillAuthoringInput);
describe("skill authoring boundary", () => {
  it("rejects filesystem-shaped draft identities and oversized instructions", () => {
    expect(() => decode({ projectId: "p", operation: "read", draftId: "../../escape" })).toThrow();
    expect(() =>
      decode({
        projectId: "p",
        operation: "save",
        draft: {
          name: "sample",
          description: "sample",
          instructions: "x".repeat(100001),
          prompt: "",
          version: "1.0.0",
        },
      }),
    ).toThrow();
  });
  it("requires explicit generation, publication and install permissions", () => {
    expect(
      clientRpcRequiredScopes(WS_METHODS.projectsSkillAuthoring, { operation: "generate" }),
    ).toEqual(["filesystem:write", "orchestration:operate"]);
    expect(
      clientRpcRequiredScopes(WS_METHODS.projectsSkillAuthoring, { operation: "publish" }),
    ).toEqual(["filesystem:write", "source-control:write", "terminal:operate"]);
    for (const operation of ["status", "previewApply"])
      expect(clientRpcRequiredScopes(WS_METHODS.projectsSkillAuthoring, { operation })).toEqual([
        "filesystem:write",
        "terminal:operate",
      ]);
    expect(
      clientRpcRequiredScopes(WS_METHODS.projectsSkillAuthoring, { operation: "apply" }),
    ).toEqual(["filesystem:write", "terminal:operate"]);
  });
});

it("retains bounded original frontmatter on the wire", () => {
  const draft = {
    name: "sample",
    description: "sample",
    instructions: "body",
    prompt: "",
    version: "1.0.0",
    sourceFrontmatter: "allowed-tools: [Read]\nmetadata: { author: Example }",
  };
  expect(decode({ projectId: "p", operation: "save", draft }).draft?.sourceFrontmatter).toBe(
    draft.sourceFrontmatter,
  );
  expect(() =>
    decode({
      projectId: "p",
      operation: "save",
      draft: { ...draft, sourceFrontmatter: "x".repeat(20_001) },
    }),
  ).toThrow();
});
