import { EnvironmentId, ProjectId } from "@specweave-studio/contracts";
import {
  createMemoryHistory,
  createRootRoute,
  createRoute,
  createRouter,
  type AnyRouter,
} from "@tanstack/react-router";
import { afterEach, describe, expect, it } from "vite-plus/test";

import type {
  SidebarProjectGroupMember,
  SidebarProjectSnapshot,
} from "../../sidebarProjectGrouping";
import { parseProjectWorkspaceSearch } from "../../studio/projectPaneThreads";
import {
  redirectSettingsEntry,
  rememberSettingsOriginProject,
  resolveSettingsOriginProjectKey,
  settingsEntrySearch,
  settingsOriginFromPathname,
  trackSettingsOriginNavigation,
} from "./settingsEntryScope";
import { resolveSettingsScope } from "./settingsScope";
import { selectSingleEnvironmentScope } from "./settingsScopeAxis";
import { retainSettingsScope, validateSettingsRouteSearch } from "./settingsScopeNavigation";
import { SETTINGS_SECTION_LABELS, type SettingsPath } from "./settingsSearch";

const mac = EnvironmentId.make("mac");
const server = EnvironmentId.make("server");
const projectKey = "repository:studio";

const member = (environmentId: EnvironmentId, id: string): SidebarProjectGroupMember =>
  ({
    id: ProjectId.make(id),
    environmentId,
    workspaceRoot: `/work/${id}`,
    physicalProjectKey: `${environmentId}:/work/${id}`,
    environmentLabel: environmentId,
  }) as unknown as SidebarProjectGroupMember;

const group = {
  projectKey,
  displayName: "Studio",
  memberProjects: [member(mac, "studio-mac"), member(server, "studio-server")],
} as unknown as SidebarProjectSnapshot;
const other = {
  projectKey: "repository:other",
  displayName: "Other",
  memberProjects: [member(mac, "other-mac")],
} as unknown as SidebarProjectSnapshot;
const environments = [
  { environmentId: mac, label: "Mac", connection: { phase: "connected" as const } },
  { environmentId: server, label: "Server", connection: { phase: "connected" as const } },
];

const SECTIONS = Object.keys(SETTINGS_SECTION_LABELS) as SettingsPath[];

function createAppRouter(initialEntry: string) {
  const root = createRootRoute();
  const home = createRoute({ getParentRoute: () => root, path: "/" });
  const project = createRoute({
    getParentRoute: () => root,
    path: "projects/$projectKey",
    validateSearch: parseProjectWorkspaceSearch,
  });
  const settings = createRoute({
    getParentRoute: () => root,
    path: "settings",
    validateSearch: validateSettingsRouteSearch,
    search: { middlewares: [retainSettingsScope] },
    beforeLoad: ({ location, search, cause }) => redirectSettingsEntry({ location, search, cause }),
  });
  const sections = SECTIONS.map((path) =>
    createRoute({
      getParentRoute: () => settings,
      path: path.slice("/settings/".length),
      validateSearch: (raw: Record<string, unknown>) =>
        typeof raw.taskId === "string" ? { taskId: raw.taskId } : {},
    }),
  );
  return createRouter({
    routeTree: root.addChildren([home, project, settings.addChildren(sections)]),
    history: createMemoryHistory({ initialEntries: [initialEntry] }),
  });
}

async function go(router: AnyRouter, options: Parameters<AnyRouter["navigate"]>[0]) {
  // The test router records a redirect instead of following it, and keeps the last one.
  let followed = router.state.redirect;
  await router.navigate(options);
  for (let hops = 0; router.state.redirect && router.state.redirect !== followed; hops += 1) {
    if (hops > 3) throw new Error("redirect loop");
    followed = router.state.redirect;
    await router.navigate(followed.options);
  }
}

afterEach(() => rememberSettingsOriginProject(null));

describe("settings entry scope", () => {
  it("names the project of the project page, a thread or a draft", () => {
    expect(
      resolveSettingsOriginProjectKey({
        routeProjectKey: projectKey,
        projectRef: null,
        groups: [],
      }),
    ).toBe(projectKey);
    expect(
      resolveSettingsOriginProjectKey({
        routeProjectKey: null,
        projectRef: { environmentId: server, projectId: "studio-server" },
        groups: [other, group],
      }),
    ).toBe(projectKey);
    expect(
      resolveSettingsOriginProjectKey({
        routeProjectKey: null,
        projectRef: { environmentId: server, projectId: "missing" },
        groups: [group],
      }),
    ).toBeNull();
    expect(
      resolveSettingsOriginProjectKey({ routeProjectKey: null, projectRef: null, groups: [group] }),
    ).toBeNull();
  });

  it("keeps an explicit target and drops a checkout without a project", () => {
    expect(settingsEntrySearch({}, projectKey)).toEqual({ project: projectKey });
    expect(settingsEntrySearch({ checkout: "mac:/work/x" }, projectKey)).toEqual({
      project: projectKey,
    });
    expect(settingsEntrySearch({ machine: "server" }, projectKey)).toBeNull();
    expect(settingsEntrySearch({ project: "repository:other" }, projectKey)).toBeNull();
    expect(settingsEntrySearch({}, null)).toBeNull();
    expect(settingsEntrySearch({ checkout: "mac:/work/x" }, null)).toEqual({});
  });

  it("opens Settings from the coordinator with its project selected", async () => {
    // The coordinator's own `?checkout=` used to leak in and read as "Select a project".
    const router = createAppRouter(
      `/projects/${encodeURIComponent(projectKey)}?checkout=${encodeURIComponent("mac:/work/studio-mac")}`,
    );
    await router.load();
    rememberSettingsOriginProject(projectKey);
    await go(router, { to: "/settings" });
    expect(router.state.location.pathname).toBe("/settings/general");
    expect(router.state.location.search).toEqual({ project: projectKey });
  });

  it("selects the project when Settings opens before the page's origin effect ran", async () => {
    // A fresh project page can be left for Settings before the layout records its origin.
    const router = createAppRouter(`/projects/${encodeURIComponent(projectKey)}`);
    trackSettingsOriginNavigation(router);
    await router.load();
    rememberSettingsOriginProject(null);
    await go(router, { to: "/settings/agents" });
    expect(router.state.location.search).toEqual({ project: projectKey });
  });

  it("selects the newer project on each later Settings entry", async () => {
    const router = createAppRouter(`/projects/${encodeURIComponent(projectKey)}`);
    trackSettingsOriginNavigation(router);
    await router.load();
    rememberSettingsOriginProject(null);
    await go(router, { to: "/settings/agents" });
    expect(router.state.location.search).toEqual({ project: projectKey });
    await go(router, { to: `/projects/${encodeURIComponent(other.projectKey)}` });
    rememberSettingsOriginProject(null);
    await go(router, { to: "/settings/general" });
    expect(router.state.location.search).toEqual({ project: other.projectKey });
  });

  it("reads a project key only from a project page path", () => {
    expect(settingsOriginFromPathname(`/projects/${encodeURIComponent(projectKey)}`)).toBe(
      projectKey,
    );
    expect(settingsOriginFromPathname("/projects/a/b")).toBeNull();
    expect(settingsOriginFromPathname("/settings/general")).toBeNull();
    expect(settingsOriginFromPathname("/projects/%E0%A4%A")).toBeNull();
  });

  it.each(SECTIONS)("scopes %s to the current project", async (section) => {
    const router = createAppRouter(`/projects/${encodeURIComponent(projectKey)}`);
    await router.load();
    rememberSettingsOriginProject(projectKey);
    await go(router, { to: section, hash: "a-setting" });
    expect(router.state.location.pathname).toBe(section);
    expect(router.state.location.search).toEqual({ project: projectKey });
    expect(router.state.location.hash).toBe("a-setting");

    const scope = resolveSettingsScope(router.state.location.search, [other, group], environments);
    expect(scope).toMatchObject({ kind: "project", label: "Studio / All checkouts" });
    expect(scope.members.map((entry) => entry.id)).toEqual(["studio-mac", "studio-server"]);
    // Providers and Privacy pin one environment of that same project.
    expect(
      selectSingleEnvironmentScope(router.state.location.search, scope, environments, "mac"),
    ).toEqual({ project: projectKey, machine: mac });
  });

  it("keeps the project across sections and honours an explicit choice of all projects", async () => {
    const router = createAppRouter(`/projects/${encodeURIComponent(projectKey)}`);
    await router.load();
    rememberSettingsOriginProject(projectKey);
    await go(router, { to: "/settings/general" });
    await go(router, { to: "/settings/integrations" });
    expect(router.state.location.search).toEqual({ project: projectKey });

    await go(router, {
      to: "/settings/integrations",
      search: (() => ({ project: undefined, machine: undefined, checkout: undefined })) as never,
    });
    expect(router.state.location.search).toEqual({});
    await go(router, { to: "/settings/storage" });
    expect(router.state.location.search).toEqual({});
  });

  it("keeps an explicit link target and other search keys", async () => {
    const router = createAppRouter(`/projects/${encodeURIComponent(projectKey)}`);
    await router.load();
    rememberSettingsOriginProject(projectKey);
    await go(router, { to: "/settings/providers", search: { machine: "server" } as never });
    expect(router.state.location.search).toEqual({ machine: "server" });

    await go(router, { to: "/" });
    await go(router, { to: "/settings/scheduled-tasks", search: { taskId: "task-1" } as never });
    expect(router.state.location.search).toEqual({ project: projectKey, taskId: "task-1" });
  });

  it("opens with all projects when the page has no project", async () => {
    const router = createAppRouter("/");
    await router.load();
    await go(router, { to: "/settings" });
    expect(router.state.location.pathname).toBe("/settings/general");
    expect(router.state.location.search).toEqual({});
  });
});
