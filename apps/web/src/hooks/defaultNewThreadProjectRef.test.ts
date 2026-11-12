import { describe, expect, it } from "vite-plus/test";
import type { EnvironmentId, ProjectId } from "@specweave-studio/contracts";
import { getProjectOrderKey } from "../logicalProject";
import { defaultNewThreadProjectRef } from "./defaultNewThreadProjectRef";

function project(id: string, kind: "code" | "personal" = "code") {
  return {
    id: id as ProjectId,
    environmentId: "env-a" as EnvironmentId,
    workspaceRoot: `/work/${id}`,
    workspaceSettings: { kind },
  };
}

const aide = project("aide", "personal");
const app = project("app");
const docs = project("docs");
// The assistant sits first in sidebar order, where Cmd+N would land.
const projectOrder = [getProjectOrderKey(aide), getProjectOrderKey(app), getProjectOrderKey(docs)];

describe("defaultNewThreadProjectRef", () => {
  it("skips the personal assistant and lands on the next project in sidebar order", () => {
    expect(defaultNewThreadProjectRef({ projects: [docs, aide, app], projectOrder })).toEqual({
      environmentId: "env-a",
      projectId: "app",
    });
  });

  it("has no default when the assistant is the only project", () => {
    expect(defaultNewThreadProjectRef({ projects: [aide], projectOrder })).toBeNull();
  });
});
