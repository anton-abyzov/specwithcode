import { EnvironmentId, ProjectId } from "@specweave-studio/contracts";
import { expect, it } from "vite-plus/test";
import { buildLogicalProjectEnvironments } from "./logicalProjectEnvironments";

type Input = Parameters<typeof buildLogicalProjectEnvironments>[0];
const m4 = EnvironmentId.make("m4"),
  m1 = EnvironmentId.make("m1");
const identity = { canonicalKey: "github.com/anton/easychamp", rootPath: "/work/easychamp" };
const project = (environmentId: EnvironmentId, id: string, archived = false) =>
  ({
    environmentId,
    id: ProjectId.make(id),
    title: "EasyChamp",
    workspaceRoot: "/work/easychamp",
    repositoryIdentity: identity,
    workspaceSettings: { archived },
  }) as Input["allProjects"][number];
const source = project(m4, "source");
const environments = [m4, m1].map((environmentId) => ({
  environmentId,
  label: environmentId,
  serverConfig: null,
})) as unknown as Input["environments"];
function input(allProjects: Input["allProjects"]): Input {
  return {
    activeProject: source,
    activeProjectIsScratch: false,
    draftId: "draft",
    allProjects,
    environments,
    environmentById: new Map(environments.map((env) => [env.environmentId, env])),
    primaryEnvironmentId: m4,
    projectGroupingSettings: {
      sidebarProjectGroupingMode: "repository",
      sidebarProjectGroupingOverrides: {},
    },
    scratchWorkspaceRootFor: () => null,
  };
}
it("excludes archived matches and retains the active sibling on the same machine", () => {
  expect(
    buildLogicalProjectEnvironments(
      input([source, project(m1, "old", true), project(m1, "active")]),
    ).map((target) => target.projectId),
  ).toEqual(["source", "active"]);
});
it("does not turn the current archived history into a draft destination", () => {
  const archived = project(m4, "source", true);
  expect(
    buildLogicalProjectEnvironments({
      ...input([archived, project(m1, "active")]),
      activeProject: archived,
    }).map((target) => target.environmentId),
  ).toEqual([m1]);
});
it("does not route to archived scratch while keeping creation on a machine without scratch", () => {
  const archived = { ...project(m1, "scratch", true), workspaceRoot: "/scratch" };
  expect(
    buildLogicalProjectEnvironments({
      ...input([source, archived]),
      activeProjectIsScratch: true,
      scratchWorkspaceRootFor: () => "/scratch",
    }).map((target) => target.environmentId),
  ).toEqual([m4]);
});

it("retains the current archived machine when displaying existing conversation history", () => {
  const archived = project(m4, "source", true);
  expect(
    buildLogicalProjectEnvironments({
      ...input([archived, project(m1, "old", true)]),
      activeProject: archived,
      draftId: null,
    }).map((target) => target.projectId),
  ).toEqual(["source"]);
});

it("labels each machine with its nickname and marks a saved fleet", () => {
  const targets = buildLogicalProjectEnvironments({
    ...input([source]),
    nickname: (environmentId, label) => (environmentId === m4 ? "Studio" : label),
  });
  expect(targets).toEqual([
    expect.objectContaining({ environmentId: m4, label: "Studio", fleet: true }),
  ]);
  const alone = buildLogicalProjectEnvironments({
    ...input([source]),
    environments: environments.slice(0, 1),
  });
  expect(alone).toEqual([expect.objectContaining({ label: "m4", fleet: false })]);
});
