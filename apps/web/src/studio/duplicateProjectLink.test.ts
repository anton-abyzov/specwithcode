// @vitest-environment jsdom
import { beforeEach, expect, it } from "vite-plus/test";
import type { EnvironmentProject } from "@specweave-studio/client-runtime/state/shell";
import type { EnvironmentId } from "@specweave-studio/contracts";
import {
  dismissLinkSuggestion,
  duplicateLinkSuggestions,
  isLinkSuggestionDismissed,
  linkDialogTarget,
  type SuggestionGroup,
} from "./duplicateProjectLink";

const M4 = "env-m4" as EnvironmentId;
const M3 = "env-m3" as EnvironmentId;
const M1 = "env-m1" as EnvironmentId;

const identity = (key: string, rootPath: string) => ({
  canonicalKey: key,
  rootPath,
  locator: { source: "git-remote", remoteName: "origin", remoteUrl: `https://${key}.git` },
  displayName: key.replace(/^github\.com\//u, ""),
});

const project = (
  environmentId: EnvironmentId,
  id: string,
  repository: string | null,
  extra: Partial<EnvironmentProject> = {},
): EnvironmentProject =>
  ({
    environmentId,
    id,
    title: "specweave",
    workspaceRoot: `/Users/a/${id}`,
    repositoryIdentity: repository ? identity(repository, `/Users/a/${id}`) : null,
    workspaceSettings: undefined,
    ...extra,
  }) as unknown as EnvironmentProject;

/** A project in a folder inside its repository, such as a monorepo's apps/web. */
const inside = (environmentId: EnvironmentId, id: string, folder: string): EnvironmentProject =>
  ({
    environmentId,
    id,
    title: folder,
    workspaceRoot: `/Users/a/mono-${id}/${folder}`,
    repositoryIdentity: identity("github.com/acme/mono", `/Users/a/mono-${id}`),
    workspaceSettings: undefined,
  }) as unknown as EnvironmentProject;

const group = (projectKey: string, ...members: EnvironmentProject[]): SuggestionGroup => ({
  projectKey,
  displayName: members[0]?.title ?? projectKey,
  memberProjects: members,
});

const REPO = "github.com/anton-abyzov/specweave";
const options = { primaryEnvironmentId: M4, eligible: () => true };

beforeEach(() => localStorage.clear());

it("offers the other machine's copy of the same repository", () => {
  const here = group("a", project(M4, "p-m4", REPO));
  const there = group("b", project(M3, "p-m3", REPO));
  const suggestions = duplicateLinkSuggestions([here, there], options);
  expect([...suggestions.keys()]).toEqual(["b"]);
  const suggestion = suggestions.get("b")!;
  expect(suggestion.anchor.id).toBe("p-m4");
  expect(suggestion.candidate.id).toBe("p-m3");
  expect(suggestion.repository).toBe("anton-abyzov/specweave");
  expect(linkDialogTarget(suggestion).candidate).toEqual({ environmentId: M3, projectId: "p-m3" });
});

it("offers the single copy to join a project already shared, anchored on its coordinator", () => {
  const logicalProject = {
    id: "logical:1",
    members: [
      { environmentId: M4, projectId: "p-m4", workspaceRoot: "/x" },
      { environmentId: M1, projectId: "p-m1", workspaceRoot: "/y" },
    ],
  };
  const shared = group(
    "a",
    project(M1, "p-m1", REPO, { workspaceSettings: { logicalProject } as never }),
    project(M4, "p-m4", REPO, { workspaceSettings: { logicalProject } as never }),
  );
  const single = group("b", project(M3, "p-m3", REPO));
  const suggestion = duplicateLinkSuggestions([shared, single], options).get("b");
  expect(suggestion?.candidate.id).toBe("p-m3");
  expect([M4, M1]).toContain(suggestion?.anchor.environmentId);
});

it("never guesses: different repositories, unknown repositories or name-only matches", () => {
  expect(
    duplicateLinkSuggestions(
      [group("a", project(M4, "1", REPO)), group("b", project(M3, "2", `${REPO}-studio`))],
      options,
    ).size,
  ).toBe(0);
  expect(
    duplicateLinkSuggestions(
      [group("a", project(M4, "1", null)), group("b", project(M3, "2", null))],
      options,
    ).size,
  ).toBe(0);
});

it("skips copies on the same machine and three-way matches", () => {
  expect(
    duplicateLinkSuggestions(
      [group("a", project(M4, "1", REPO)), group("b", project(M4, "2", REPO))],
      options,
    ).size,
  ).toBe(0);
  expect(
    duplicateLinkSuggestions(
      [
        group("a", project(M4, "1", REPO)),
        group("b", project(M3, "2", REPO)),
        group("c", project(M1, "3", REPO)),
      ],
      options,
    ).size,
  ).toBe(0);
});

it("skips two single copies on other machines, and two linked projects", () => {
  expect(
    duplicateLinkSuggestions(
      [group("a", project(M1, "1", REPO)), group("b", project(M3, "2", REPO))],
      options,
    ).size,
  ).toBe(0);
  expect(
    duplicateLinkSuggestions(
      [
        group("a", project(M4, "1", REPO), project(M1, "3", REPO)),
        group("b", project(M3, "2", REPO), project("env-x" as EnvironmentId, "4", REPO)),
      ],
      options,
    ).size,
  ).toBe(0);
});

it("skips ineligible copies and copies the person said are different", () => {
  const groups = [group("a", project(M4, "1", REPO)), group("b", project(M3, "2", REPO))];
  expect(
    duplicateLinkSuggestions(groups, { ...options, eligible: (item) => item.id !== "2" }).size,
  ).toBe(0);
  dismissLinkSuggestion({ environmentId: M3, id: "2" } as never);
  expect(isLinkSuggestionDismissed({ environmentId: M3, id: "2" } as never)).toBe(true);
  expect(
    duplicateLinkSuggestions(groups, { ...options, dismissed: isLinkSuggestionDismissed }).size,
  ).toBe(0);
});

it("tells apart two folders of one monorepo, and offers the same folder", () => {
  expect(
    duplicateLinkSuggestions(
      [group("a", inside(M4, "1", "apps/web")), group("b", inside(M3, "2", "apps/api"))],
      options,
    ).size,
  ).toBe(0);
  expect(
    duplicateLinkSuggestions(
      [group("a", inside(M4, "1", "apps/web")), group("b", inside(M3, "2", "apps/web"))],
      options,
    ).has("b"),
  ).toBe(true);
});

it("skips a copy whose place in its repository is unknown", () => {
  const unknownRoot = project(M3, "2", REPO);
  const withoutRoot = {
    ...unknownRoot,
    repositoryIdentity: { ...unknownRoot.repositoryIdentity!, rootPath: undefined },
  } as unknown as EnvironmentProject;
  expect(
    duplicateLinkSuggestions([group("a", project(M4, "1", REPO)), group("b", withoutRoot)], options)
      .size,
  ).toBe(0);
});

it("never offers a copy already linked to a machine this app does not list", () => {
  const ownOnly = (environmentId: EnvironmentId, id: string) => ({
    logicalProject: { id: `logical:${id}`, members: [{ environmentId, projectId: id }] },
  });
  const linkedElsewhere = project(M3, "2", REPO, {
    workspaceSettings: {
      logicalProject: {
        id: "logical:x",
        members: [
          { environmentId: M3, projectId: "2" },
          { environmentId: "env-offline" as EnvironmentId, projectId: "9" },
        ],
      },
    } as never,
  });
  expect(
    duplicateLinkSuggestions(
      [
        group("a", project(M4, "1", REPO, { workspaceSettings: ownOnly(M4, "1") as never })),
        group("b", linkedElsewhere),
      ],
      options,
    ).size,
  ).toBe(0);
  // A project that lists only itself is not linked: every project does.
  expect(
    duplicateLinkSuggestions(
      [
        group("a", project(M4, "1", REPO, { workspaceSettings: ownOnly(M4, "1") as never })),
        group("b", project(M3, "2", REPO, { workspaceSettings: ownOnly(M3, "2") as never })),
      ],
      options,
    ).has("b"),
  ).toBe(true);
});
