// @vitest-environment jsdom
import { beforeEach, describe, expect, it } from "vite-plus/test";
import type { EnvironmentProject } from "@specweave-studio/client-runtime/state/shell";
import type { EnvironmentId, ProjectId } from "@specweave-studio/contracts";
import {
  dismissLinkSuggestion,
  duplicateLinkSuggestions,
  isLinkSuggestionDismissed,
  linkDialogTarget,
  type SuggestionGroup,
} from "./duplicateProjectLink";
import { buildSidebarProjectSnapshots } from "../sidebarProjectGrouping";
import type { Project } from "../types";

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

it("offers a copy to join a shared project whose Linux member sits behind a home link", () => {
  // Ministorm's git reports /srv/work/... for a project added as /home/anton/...
  const MS = "env-ministorm" as EnvironmentId;
  const logicalProject = {
    id: "logical:1",
    members: [
      { environmentId: M4, projectId: "p-m4", workspaceRoot: "/Users/a/p-m4" },
      { environmentId: MS, projectId: "p-ms", workspaceRoot: "/home/anton/repos/specweave" },
    ],
  };
  const shared = group(
    "a",
    project(M4, "p-m4", REPO, { workspaceSettings: { logicalProject } as never }),
    project(MS, "p-ms", REPO, {
      workspaceRoot: "/home/anton/repos/specweave",
      repositoryIdentity: identity(REPO, "/srv/work/repos/specweave") as never,
      workspaceSettings: { logicalProject } as never,
    }),
  );
  const single = group("b", project(M1, "p-m1", REPO));
  const suggestion = duplicateLinkSuggestions([shared, single], options).get("b");
  expect(suggestion?.candidate.id).toBe("p-m1");
  expect(suggestion?.anchorTitle).toBe("specweave");
});

describe("one row that repository grouping merged across machines", () => {
  const EASYCHAMP = "github.com/anton-abyzov/sw-easychamp";
  const copyOf = (
    environmentId: EnvironmentId,
    id: string,
    extra: Partial<EnvironmentProject> = {},
  ) => project(environmentId, id, EASYCHAMP, { title: "EasyChamp", ...extra });
  /** The sidebar's own rows, as `buildSidebarProjectSnapshots` makes them by default. */
  const rows = (...projects: EnvironmentProject[]) =>
    buildSidebarProjectSnapshots({
      projects: projects as unknown as Project[],
      settings: { sidebarProjectGroupingMode: "repository", sidebarProjectGroupingOverrides: {} },
      primaryEnvironmentId: M4,
      resolveEnvironmentLabel: (id) => id,
    });
  const handoffCopies = [
    copyOf(M1, "machine-handoff:a"),
    copyOf(M1, "machine-handoff:b", {
      workspaceRoot: "/Users/a/.specwithcode/machine-handoffs/git/sw-easychamp",
    }),
    copyOf(M4, "proof", {
      workspaceRoot: "/Users/a/fleet/handoff-proof-20261013/source-checkouts/sw-easychamp",
    }),
  ];

  it("offers the other machine's copy, anchored on this machine's, ignoring staging copies", () => {
    const groups = rows(copyOf(M4, "p-m4"), copyOf(M1, "p-m1"), ...handoffCopies);
    // Repository grouping makes them one row, which the two-row pass never saw.
    expect(groups).toHaveLength(1);
    expect(groups[0]!.memberProjects.length).toBeGreaterThan(2);
    const suggestions = duplicateLinkSuggestions(groups, options);
    const suggestion = suggestions.get(groups[0]!.projectKey)!;
    expect(suggestion.anchor.id).toBe("p-m4");
    expect(suggestion.candidate.id).toBe("p-m1");
    expect(suggestion.anchorTitle).toBe("EasyChamp");
    expect(suggestion.repository).toBe("anton-abyzov/sw-easychamp");
    expect(linkDialogTarget(suggestion)).toMatchObject({
      project: { environmentId: M4, id: "p-m4" },
      candidate: { environmentId: M1, projectId: "p-m1" },
    });
  });

  it("keeps every safety condition for the merged row", () => {
    const none = (...projects: EnvironmentProject[]) =>
      expect(duplicateLinkSuggestions(rows(...projects), options).size).toBe(0);
    // Different places inside the repository.
    none(
      copyOf(M4, "p-m4"),
      copyOf(M1, "p-m1", {
        workspaceRoot: "/Users/a/p-m1/apps/web",
        repositoryIdentity: identity(EASYCHAMP, "/Users/a/p-m1"),
      } as Partial<EnvironmentProject>),
    );
    // Both copies on one machine, and neither copy on this machine.
    none(copyOf(M4, "p-a"), copyOf(M4, "p-b"));
    none(copyOf(M3, "p-m3"), copyOf(M1, "p-m1"));
    // Three plain copies.
    none(copyOf(M4, "p-m4"), copyOf(M1, "p-m1"), copyOf(M3, "p-m3"));
    // A copy that already lists another machine's copy is linked.
    none(
      copyOf(M4, "p-m4"),
      copyOf(M1, "p-m1", {
        workspaceSettings: {
          logicalProject: {
            id: "logical:elsewhere",
            title: "EasyChamp",
            members: [
              { environmentId: M1, projectId: "p-m1", workspaceRoot: "/Users/a/p-m1" },
              { environmentId: M3, projectId: "p-m3", workspaceRoot: "/Users/a/p-m3" },
            ],
          },
        },
      } as unknown as Partial<EnvironmentProject>),
    );
    // Ineligible copies, and a copy the person said is different.
    expect(
      duplicateLinkSuggestions(rows(copyOf(M4, "p-m4"), copyOf(M1, "p-m1")), {
        ...options,
        eligible: (candidate) => candidate.id !== "p-m1",
      }).size,
    ).toBe(0);
    dismissLinkSuggestion({ environmentId: M1, id: "p-m1" as ProjectId });
    expect(
      duplicateLinkSuggestions(rows(copyOf(M4, "p-m4"), copyOf(M1, "p-m1"), ...handoffCopies), {
        ...options,
        dismissed: isLinkSuggestionDismissed,
      }).size,
    ).toBe(0);
  });
});
