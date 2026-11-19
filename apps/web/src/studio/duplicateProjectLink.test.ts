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
  expect(suggestion.sameRow).toBeUndefined();
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

it("skips copies on the same machine, in two rows or among three", () => {
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
        group("c", project(M3, "3", REPO)),
      ],
      options,
    ).size,
  ).toBe(0);
});

it("offers every unlinked copy when the repository is on three machines", () => {
  const groups = [
    group("a", project(M4, "1", REPO)),
    group("b", project(M3, "2", REPO)),
    group("c", project(M1, "3", REPO)),
  ];
  const suggestions = duplicateLinkSuggestions(groups, options);
  // This machine's row stays the established one; each other row offers its own link.
  expect([...suggestions.keys()]).toEqual(["b", "c"]);
  expect(suggestions.get("b")).toMatchObject({ anchor: { id: "1" }, candidate: { id: "2" } });
  expect(suggestions.get("c")).toMatchObject({ anchor: { id: "1" }, candidate: { id: "3" } });
  // One the person said is different drops out; the other is still offered.
  dismissLinkSuggestion({ environmentId: M3, id: "2" } as never);
  expect([
    ...duplicateLinkSuggestions(groups, {
      ...options,
      dismissed: isLinkSuggestionDismissed,
    }).keys(),
  ]).toEqual(["c"]);
  // With no copy on this machine there is no row to keep, so nothing is guessed.
  expect(
    duplicateLinkSuggestions(groups, { ...options, primaryEnvironmentId: "env-x" as EnvironmentId })
      .size,
  ).toBe(0);
});

it("offers two unlinked copies to join one linked project, and skips two linked projects", () => {
  const M2 = "env-m2" as EnvironmentId;
  const logicalProject = {
    id: "logical:1",
    members: [
      { environmentId: M4, projectId: "p-m4", workspaceRoot: "/x" },
      { environmentId: M1, projectId: "p-m1", workspaceRoot: "/y" },
    ],
  };
  const shared = group(
    "a",
    project(M4, "p-m4", REPO, { workspaceSettings: { logicalProject } as never }),
    project(M1, "p-m1", REPO, { workspaceSettings: { logicalProject } as never }),
  );
  const suggestions = duplicateLinkSuggestions(
    [shared, group("b", project(M3, "p-m3", REPO)), group("c", project(M2, "p-m2", REPO))],
    options,
  );
  expect([...suggestions.keys()]).toEqual(["b", "c"]);
  expect(suggestions.get("b")?.candidate.id).toBe("p-m3");
  expect(suggestions.get("c")?.candidate.id).toBe("p-m2");
  const other = {
    id: "logical:2",
    members: [
      { environmentId: M3, projectId: "p-m3", workspaceRoot: "/z" },
      { environmentId: M2, projectId: "p-m2", workspaceRoot: "/w" },
    ],
  };
  const second = group(
    "b",
    project(M3, "p-m3", REPO, { workspaceSettings: { logicalProject: other } as never }),
    project(M2, "p-m2", REPO, { workspaceSettings: { logicalProject: other } as never }),
  );
  // Two projects already: which one a third copy joins is not this row's to guess.
  expect(
    duplicateLinkSuggestions(
      [shared, second, group("c", project("env-m5" as EnvironmentId, "p-m5", REPO))],
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
    expect(suggestion.sameRow).toBe(true);
    expect(linkDialogTarget(suggestion)).toMatchObject({
      project: { environmentId: M4, id: "p-m4" },
      candidate: { environmentId: M1, projectId: "p-m1" },
    });
  });

  it("offers each of three unlinked copies in turn, naming the ones that wait", () => {
    const groups = rows(copyOf(M4, "p-m4"), copyOf(M1, "p-m1"), copyOf(M3, "p-m3"));
    expect(groups).toHaveLength(1);
    const key = groups[0]!.projectKey;
    const first = duplicateLinkSuggestions(groups, options).get(key)!;
    expect(first.anchor.id).toBe("p-m4");
    expect(first.sameRow).toBe(true);
    const offered = [first.candidate.id, ...(first.more ?? []).map((copy) => copy.id)];
    expect(offered.toSorted()).toEqual(["p-m1", "p-m3"]);
    // "Not the same project" on the first leaves the other, with nothing behind it.
    dismissLinkSuggestion(first.candidate);
    const next = duplicateLinkSuggestions(groups, {
      ...options,
      dismissed: isLinkSuggestionDismissed,
    }).get(key)!;
    expect(next.candidate.id).toBe(offered[1]);
    expect(next.more).toBeUndefined();
  });

  it("offers the unlinked copy of a row whose other two copies are linked", () => {
    const logicalProject = {
      id: "logical:pair",
      title: "EasyChamp",
      members: [
        { environmentId: M4, projectId: "p-m4", workspaceRoot: "/Users/a/p-m4" },
        { environmentId: M1, projectId: "p-m1", workspaceRoot: "/Users/a/p-m1" },
      ],
    };
    const pair = (coordinator: EnvironmentId) =>
      [M4, M1].map((environmentId) =>
        copyOf(environmentId, environmentId === M4 ? "p-m4" : "p-m1", {
          workspaceSettings: {
            logicalProject,
            coordinatorBinding:
              environmentId === coordinator
                ? { epoch: 2, state: "active" }
                : {
                    epoch: 2,
                    state: "transferred",
                    successor: {
                      environmentId: coordinator,
                      projectId: coordinator === M4 ? "p-m4" : "p-m1",
                    },
                  },
          },
        } as unknown as Partial<EnvironmentProject>),
      );
    for (const coordinator of [M4, M1]) {
      // One row holding all three, as a list that has not regrouped yet leaves them.
      const suggestion = duplicateLinkSuggestions(
        [group("row", ...pair(coordinator), copyOf(M3, "p-m3"))],
        options,
      ).get("row")!;
      // The unlinked copy joins the project, anchored on the copy that is main.
      expect(suggestion.candidate.id).toBe("p-m3");
      expect(suggestion.anchor.environmentId).toBe(coordinator);
      expect(suggestion.sameRow).toBe(true);
      expect(suggestion.more).toBeUndefined();
      expect(linkDialogTarget(suggestion).candidate).toEqual({
        environmentId: M3,
        projectId: "p-m3",
      });
      // The sidebar's own rows keep the linked pair apart: the unlinked row offers the link.
      const sidebar = rows(...pair(coordinator), copyOf(M3, "p-m3"));
      expect(sidebar).toHaveLength(2);
      const offered = [...duplicateLinkSuggestions(sidebar, options).values()];
      expect(offered).toHaveLength(1);
      expect(offered[0]).toMatchObject({ candidate: { id: "p-m3" } });
      expect(offered[0]!.anchor.environmentId).toBe(coordinator);
    }
    // A linked pair that names a copy this row does not hold stays out: a link hides there.
    const elsewhere = {
      ...logicalProject,
      members: [
        ...logicalProject.members,
        { environmentId: "env-off" as EnvironmentId, projectId: "p-off", workspaceRoot: "/o" },
      ],
    };
    const hidden = [M4, M1].map((environmentId) =>
      copyOf(environmentId, environmentId === M4 ? "p-m4" : "p-m1", {
        workspaceSettings: { logicalProject: elsewhere },
      } as unknown as Partial<EnvironmentProject>),
    );
    expect(
      duplicateLinkSuggestions([group("row", ...hidden, copyOf(M3, "p-m3"))], options).size,
    ).toBe(0);
    expect(duplicateLinkSuggestions(rows(...hidden, copyOf(M3, "p-m3")), options).size).toBe(0);
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
    // Three copies, none on this machine; three copies, two of them on one machine.
    none(copyOf(M3, "p-m3"), copyOf(M1, "p-m1"), copyOf("env-m2" as EnvironmentId, "p-m2"));
    none(copyOf(M4, "p-m4"), copyOf(M1, "p-m1"), copyOf(M1, "p-m1b"));
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
    // A merged row whose copy names another machine's copy, as a source that has not
    // streamed its new grouping yet would leave it.
    const linked = copyOf(M1, "p-m1", {
      workspaceSettings: {
        logicalProject: {
          id: "logical:elsewhere",
          members: [{ environmentId: M3, projectId: "p-m3", workspaceRoot: "/Users/a/p-m3" }],
        },
      },
    } as unknown as Partial<EnvironmentProject>);
    expect(duplicateLinkSuggestions([group("row", copyOf(M4, "p-m4"), linked)], options).size).toBe(
      0,
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
