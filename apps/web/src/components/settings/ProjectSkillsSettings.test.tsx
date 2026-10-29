// @vitest-environment jsdom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vite-plus/test";
import {
  EnvironmentId,
  ProjectId,
  ProviderDriverKind,
  ProviderInstanceId,
  type ProjectSkillRow,
  type ProjectSkillsSnapshot,
} from "@specweave-studio/contracts";

const state = vi.hoisted(() => ({
  data: null as unknown,
  error: null as string | null,
  isPending: false,
  copied: [] as string[],
  versions: null as unknown,
  actions: [] as Array<{ preview: boolean; action: unknown; expected?: unknown }>,
  search: {} as Record<string, unknown>,
  navigations: [] as Array<{ replace?: boolean; search?: unknown }>,
  skillsInputs: [] as unknown[],
  toasts: [] as Array<{
    title?: string;
    actionProps?: { children?: unknown; onClick?: () => void };
  }>,
}));

vi.mock("../../studio/projectWorkspace", () => ({
  projectWorkspace: {
    skills: (options: { input: unknown }) => {
      state.skillsInputs.push(options.input);
      return { kind: "skills" };
    },
    skillVersions: () => ({ kind: "versions" }),
    skillAction: { label: "skill-action" },
    skillFleetPush: { label: "skill-fleet-push" },
    skillStudioLink: { label: "skill-studio-link" },
  },
}));
vi.mock("../../state/query", () => ({
  useEnvironmentQuery: (atom: { kind?: string } | null) =>
    atom === null
      ? { refresh: () => {}, data: null, error: null, isPending: false }
      : atom.kind === "versions"
        ? { refresh: () => {}, data: state.versions, error: null, isPending: false }
        : {
            refresh: () => {},
            data: state.data,
            error: state.error,
            isPending: state.isPending,
          },
}));
vi.mock(import("../../state/session"), async (importOriginal) => ({
  ...(await importOriginal()),
  useEnvironmentScope: () => true,
}));
vi.mock("../../studio/fleet", () => ({
  useStudioFleet: () => ({ snapshot: null, loading: false, failed: false, refresh: () => {} }),
}));
vi.mock("@tanstack/react-router", () => ({
  useSearch: () => state.search,
  useNavigate: () => (options: { replace?: boolean; search?: unknown }) => {
    state.navigations.push(options);
    return Promise.resolve();
  },
}));
vi.mock("../ui/toast", () => ({
  toastManager: {
    add: (toast: (typeof state.toasts)[number]) => {
      state.toasts.push(toast);
      return "toast";
    },
    close: () => {},
  },
}));
vi.mock("../../state/use-atom-command", () => ({
  useAtomCommand:
    () =>
    async ({
      input,
    }: {
      input: { preview: boolean; action: { kind: string; enabled?: boolean }; expected?: unknown };
    }) => {
      state.actions.push({
        preview: input.preview,
        action: input.action,
        ...(input.expected ? { expected: input.expected } : {}),
      });
      return input.preview
        ? {
            _tag: "Success",
            value: {
              preview: {
                files: ["/work/app/.claude/settings.local.json"],
                summary: "Turn off deploy for Claude.",
                liveness: "next-session",
                expected: { fileHash: "h1" },
              },
            },
          }
        : {
            _tag: "Success",
            value: {
              applied: true,
              summary: "Turned off deploy for Claude.",
              liveness: "next-session",
              effectiveEnabled: input.action.enabled,
            },
          };
    },
}));
vi.mock("~/hooks/useCopyToClipboard", () => ({
  useCopyToClipboard: () => ({
    copyToClipboard: (value: string) => state.copied.push(value),
    isCopied: false,
  }),
}));
vi.mock("./settingsLayout", () => ({
  SettingsSection: (props: { id?: string; title: string; children: unknown }) => (
    <section id={props.id} aria-label={props.title}>
      {props.children as never}
    </section>
  ),
  SettingsPageContainer: (props: { children: unknown }) => <div>{props.children as never}</div>,
}));

import { ProjectSkillsView } from "./ProjectSkillsSettings";

const claude = {
  instanceId: ProviderInstanceId.make("claudeAgent"),
  driver: ProviderDriverKind.make("claudeAgent"),
  label: "Claude",
};

function row(name: string, extra: Partial<ProjectSkillRow> = {}): ProjectSkillRow {
  const path = `/work/app/.claude/skills/${name}/SKILL.md`;
  return {
    name,
    status: "ok",
    attention: false,
    issues: [],
    path,
    scopes: ["project"],
    providers: [{ ...claude, path, scope: "project", enabled: true }],
    lock: null,
    drift: "unlocked",
    copies: 1,
    divergent: false,
    doctor: [],
    ...extra,
  };
}

const snapshot: ProjectSkillsSnapshot = {
  cwd: "/work/app",
  checkedAt: "2026-10-11T00:00:00.000Z",
  rows: [
    row("deploy", {
      lock: {
        lockPath: "/work/app/vskill.lock",
        lockScope: "project",
        version: "1.2.0",
        tier: "VERIFIED",
        source: "github:acme/deploy",
        sha: "abc",
        installedAt: null,
        pinnedVersion: "1.2.0",
        skillId: "acme/deploy/deploy",
      },
      drift: "match",
    }),
    row("review", {
      status: "drift",
      attention: true,
      issues: ["SKILL.md changed since vskill installed it."],
    }),
    row("ghost", { status: "missing", attention: true, providers: [], path: null, scopes: [] }),
  ],
  providers: [
    { ...claude, state: "ok", skills: 2 },
    {
      instanceId: ProviderInstanceId.make("cursor"),
      driver: ProviderDriverKind.make("cursor"),
      label: "Cursor",
      state: "error",
      skills: 0,
      message: "Not installed.",
    },
  ],
  locks: [{ path: "/work/app/vskill.lock", scope: "project", skills: 2 }],
  doctor: "unavailable",
};

let root: Root;
let container: HTMLDivElement;

beforeEach(() => {
  (globalThis as Record<string, unknown>).IS_REACT_ACT_ENVIRONMENT = true;
  state.data = snapshot;
  state.error = null;
  state.isPending = false;
  state.copied = [];
  state.versions = null;
  state.actions = [];
  state.toasts = [];
  state.search = {};
  state.navigations = [];
  state.skillsInputs = [];
  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
});

afterEach(async () => {
  await act(async () => root.unmount());
  container.remove();
});

async function render() {
  await act(async () =>
    root.render(
      <ProjectSkillsView
        environmentId={EnvironmentId.make("host")}
        projectId={ProjectId.make("project")}
        folder="/work/app"
      />,
    ),
  );
}

const bodyRows = () =>
  [...container.querySelectorAll("tbody tr[data-skill]")].map((element) =>
    element.getAttribute("data-skill"),
  );

describe("ProjectSkillsView", () => {
  it("reads the machine's user-level skills in the machine-wide view", async () => {
    await act(async () =>
      root.render(
        <ProjectSkillsView
          environmentId={EnvironmentId.make("host")}
          projectId={ProjectId.make("project")}
          folder="~"
          userLevel
        />,
      ),
    );
    expect(state.skillsInputs.at(-1)).toEqual({ projectId: "project", userLevel: true });
    expect(container.querySelector("[data-testid=skills-user-level]")?.textContent).toContain(
      "changes only that agent's own settings",
    );
  });

  it("shows a summary line and one row per skill with its lock details", async () => {
    await render();
    expect(container.querySelector("[data-testid=skills-summary]")?.textContent).toBe(
      "3 skills, 2 need attention",
    );
    expect(bodyRows()).toEqual(["deploy", "review", "ghost"]);
    const deploy = container.querySelector("tr[data-skill=deploy]")!;
    const cells = [...deploy.querySelectorAll("td")].map((cell) => cell.textContent);
    expect(cells.slice(0, 7)).toEqual([
      "deploy",
      "Claude",
      "Project",
      // The version, then its pinned chip.
      "1.2.0pinned",
      "VERIFIED",
      // The repository, then the skill's verified-skill.com page under it.
      "acme/deployverified-skill.com",
      "ok",
    ]);
    expect(
      deploy.querySelector<HTMLAnchorElement>(
        "a[aria-label='Open deploy on verified-skill.com: https://verified-skill.com/skills/acme/deploy/deploy']",
      ),
    ).not.toBeNull();
    expect(
      deploy.querySelector<HTMLAnchorElement>("a[aria-label='Open deploy on verified-skill.com']")
        ?.href,
    ).toBe("https://verified-skill.com/skills/acme/deploy/deploy");
    expect(
      deploy.querySelector<HTMLAnchorElement>("a[href='https://github.com/acme/deploy']"),
    ).not.toBeNull();
    expect(container.textContent).toContain("Cursor: Not installed.");
    expect(container.textContent).toContain("vskill doctor is not available here");
  });

  it("filters to problems and by search", async () => {
    await render();
    const toggle = container.querySelector<HTMLElement>("[role=switch]")!;
    await act(async () => toggle.click());
    expect(bodyRows()).toEqual(["review", "ghost"]);
    expect(container.querySelector("[data-testid=skills-summary]")?.textContent).toBe(
      "3 skills, 2 need attention · showing 2",
    );

    const input = container.querySelector<HTMLInputElement>("input[aria-label='Search skills']")!;
    await act(async () => {
      const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!;
      setter.call(input, "nothing-matches");
      input.dispatchEvent(new Event("input", { bubbles: true }));
    });
    expect(bodyRows()).toEqual([]);
    expect(container.textContent).toContain("No skills match these filters.");
  });

  it("filters by agent and level chips and clears every filter at once", async () => {
    state.data = {
      ...snapshot,
      rows: [
        ...snapshot.rows,
        row("gws", {
          scopes: ["user"],
          providers: [
            {
              instanceId: ProviderInstanceId.make("codex"),
              driver: ProviderDriverKind.make("codex"),
              label: "Codex",
              path: "/home/me/.agents/skills/gws/SKILL.md",
              scope: "user",
              enabled: true,
            },
          ],
        }),
      ],
    };
    await render();
    const chip = (group: string, value: string) =>
      container.querySelector<HTMLElement>(
        `[aria-label='Filter by ${group}'] [data-facet='${value}']`,
      )!;
    await act(async () => chip("agent", "Codex").click());
    expect(bodyRows()).toEqual(["gws"]);
    await act(async () => chip("agent", "Codex").click());
    await act(async () => chip("level", "project").click());
    expect(bodyRows()).toEqual(["deploy", "review"]);
    await act(async () => chip("tier", "VERIFIED").click());
    expect(bodyRows()).toEqual(["deploy"]);

    const clear = [...container.querySelectorAll("button")].find(
      (button) => button.textContent === "Clear filters",
    )!;
    await act(async () => clear.click());
    expect(bodyRows()).toEqual(["deploy", "review", "ghost", "gws"]);
  });

  it("opens a details panel with links, problems and where each agent loads the skill", async () => {
    await render();
    await act(async () =>
      container.querySelector<HTMLElement>("button[aria-label='Show details for deploy']")!.click(),
    );
    const panel = document.querySelector("[data-testid=skill-details]")!;
    expect(panel.textContent).toContain("deploy");
    expect(panel.textContent).toContain("/work/app/.claude/skills/deploy/SKILL.md");
    expect(panel.textContent).toContain("/work/app/vskill.lock (project)");
    expect(panel.textContent).toContain("Matches the locked version");
    const links = [...panel.querySelectorAll<HTMLAnchorElement>("a")].map((link) => link.href);
    expect(links).toContain("https://verified-skill.com/skills/acme/deploy/deploy");
    expect(links).toContain("https://github.com/acme/deploy");

    await act(async () =>
      (container.querySelector("tr[data-skill=review] td:nth-child(3)") as HTMLElement).click(),
    );
    expect(document.querySelector("[data-testid=skill-details]")?.textContent).toContain(
      "SKILL.md changed since vskill installed it.",
    );
  });

  async function openRowMenu(skill: string) {
    const trigger = container.querySelector<HTMLButtonElement>(
      `button[aria-label='More actions for ${skill}']`,
    )!;
    await act(async () => {
      trigger.dispatchEvent(new MouseEvent("pointerdown", { bubbles: true, button: 0 }));
      trigger.dispatchEvent(new MouseEvent("mousedown", { bubbles: true, button: 0 }));
      trigger.click();
    });
    return (label: string) =>
      [...document.querySelectorAll<HTMLElement>("[role=menuitem]")].find(
        (item) => item.textContent === label,
      )!;
  }

  it("copies the SKILL.md path from the row menu and disables copy when nothing loads the skill", async () => {
    await render();
    let item = await openRowMenu("review");
    await act(async () => item("Copy path").click());
    expect(state.copied).toEqual(["/work/app/.claude/skills/review/SKILL.md"]);
    await act(async () =>
      document.body.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true })),
    );
    item = await openRowMenu("ghost");
    expect(
      item("Copy path").getAttribute("aria-disabled") ??
        item("Copy path").getAttribute("data-disabled"),
    ).not.toBeNull();
    // A local skill has no registry versions to change or push.
    expect(item("Change version…").hasAttribute("data-disabled")).toBe(true);
  });

  it("shows the version, and previews a switch before it writes, with Undo after", async () => {
    state.versions = {
      skill: "deploy",
      skillId: "acme/deploy/deploy",
      lockScope: "project",
      installedVersion: "1.2.0",
      pinnedVersion: "1.2.0",
      versions: [
        { version: "1.3.0", certTier: "VERIFIED", createdAt: null, installed: false },
        { version: "1.2.0", certTier: "VERIFIED", createdAt: null, installed: true },
      ],
      outdated: { latest: "1.3.0", updateAvailable: true, pinned: true, pinnedVersion: "1.2.0" },
    };
    await render();
    await act(async () =>
      container.querySelector<HTMLElement>("button[aria-label='Show details for deploy']")!.click(),
    );
    const panel = document.querySelector("[data-testid=skill-details]")!;
    const version = panel.querySelector("[data-testid=skill-version]")!;
    expect(version.textContent).toContain("1.2.0");
    expect(version.textContent).toContain("pinned");
    expect(version.textContent).toContain("Update to 1.3.0");
    // The row learns about the update once its versions were read.
    expect(
      container.querySelector("tr[data-skill=deploy] [data-testid=version-update]")?.textContent,
    ).toBe("↑1.3.0");
    expect(panel.querySelector("[data-testid=skill-liveness]")?.textContent).toBe("Next session");

    const toggle = panel.querySelector<HTMLElement>("[data-testid=skill-agent-switch]")!;
    await act(async () => toggle.click());
    expect(state.actions).toEqual([
      {
        preview: true,
        action: {
          kind: "toggle-skill",
          provider: "claudeAgent",
          instanceId: "claudeAgent",
          enabled: false,
          scope: "local",
        },
      },
    ]);
    const card = panel.querySelector("[data-testid=skill-action-preview]")!;
    expect(card.textContent).toContain("Turn off deploy for Claude.");
    expect(card.textContent).toContain("Edits /work/app/.claude/settings.local.json");
    expect(card.textContent).toContain("Takes effect: Next session");

    await act(async () =>
      panel.querySelector<HTMLButtonElement>("[data-testid=skill-action-apply]")!.click(),
    );
    expect(state.actions[1]).toMatchObject({ preview: false, expected: { fileHash: "h1" } });
    expect(panel.querySelector("[data-testid=skill-action-preview]")).toBeNull();
    expect(state.toasts[0]?.title).toBe("Turned off deploy for Claude.");
    expect(state.toasts[0]?.actionProps?.children).toBe("Undo");

    // Undo previews the inverse and applies it with what that preview saw.
    await act(async () => state.toasts[0]!.actionProps!.onClick!());
    expect(state.actions.slice(2)).toEqual([
      expect.objectContaining({
        preview: true,
        action: expect.objectContaining({ enabled: true }),
      }),
      expect.objectContaining({ preview: false, expected: { fileHash: "h1" } }),
    ]);
  });

  it("says why Pin and Unpin are disabled for a skill in the user's lock", async () => {
    const userLock = {
      lockPath: "/home/me/.agents/vskill.lock",
      lockScope: "user" as const,
      version: "1.0.0",
      tier: "VERIFIED",
      source: "github:acme/brain",
      sha: "abc",
      installedAt: null,
      pinnedVersion: "1.0.0",
      skillId: "acme/brain/brain",
    };
    state.data = { ...snapshot, rows: [row("brain", { lock: userLock, drift: "match" })] };
    await render();
    await act(async () =>
      container.querySelector<HTMLElement>("button[aria-label='Show details for brain']")!.click(),
    );
    const version = document.querySelector(
      "[data-testid=skill-details] [data-testid=skill-version]",
    )!;
    const unpin = [...version.querySelectorAll("button")].find(
      (button) => button.textContent === "Unpin",
    )!;
    expect(unpin.disabled).toBe(true);
    // The reason sits on a focusable wrapper, since a disabled button gets no hover or focus.
    const wrapper = unpin.closest<HTMLElement>("[data-testid=skill-control-reason]")!;
    expect(wrapper.tabIndex).toBe(0);
    const described = document.getElementById(wrapper.getAttribute("aria-describedby")!);
    expect(described?.textContent).toContain("vskill pins only in a project folder's own lock");
    // The Install section no longer repeats the links and version shown above it.
    const install = document.querySelector("[data-testid=skill-details] [aria-label=Install]")!;
    expect(install.textContent).not.toContain("verified-skill.com");
    expect(install.textContent).not.toContain("Version");
  });

  it("opens the linked skill once, leaves the URL, and says when it is not loaded here", async () => {
    state.search = { skill: "deploy" };
    await render();
    expect(document.querySelector("[data-testid=skill-details]")?.textContent).toContain("deploy");
    expect(state.navigations).toEqual([expect.objectContaining({ replace: true })]);
    const strip = state.navigations[0]!.search as (prev: Record<string, unknown>) => unknown;
    expect(strip({ skill: "deploy", tab: "x" })).toEqual({ tab: "x" });

    await act(async () => root.unmount());
    root = createRoot(container);
    state.search = { skill: "nope" };
    await render();
    expect(document.querySelector("[data-testid=skills-linked-missing]")?.textContent).toContain(
      "nope is not loaded in this project.",
    );
  });

  it("can turn a disabled Claude plugin back on after a rescan", async () => {
    state.data = {
      ...snapshot,
      rows: [
        row("sw:do", {
          providers: [
            {
              ...claude,
              path: "/home/me/.claude/plugins/cache/specweave/sw/1.0.0/skills/do/SKILL.md",
              scope: "plugin",
              enabled: false,
              name: "sw:do",
            },
          ],
        }),
      ],
    };
    await render();
    await act(async () =>
      container.querySelector<HTMLElement>("button[aria-label='Show details for sw:do']")!.click(),
    );
    const panel = document.querySelector("[data-testid=skill-details]")!;
    const button = [...panel.querySelectorAll("button")].find(
      (element) => element.textContent === "Turn on plugin sw",
    )!;
    expect(button).toBeDefined();
    await act(async () => button.click());
    expect(state.actions[0]).toMatchObject({
      preview: true,
      action: { kind: "toggle-plugin", pluginId: "sw@specweave", enabled: true },
    });
  });

  it("shows Grok's skill switch disabled and offers turning off a plugin", async () => {
    state.data = {
      ...snapshot,
      rows: [
        row("sw:do", {
          providers: [
            {
              instanceId: ProviderInstanceId.make("grok"),
              driver: ProviderDriverKind.make("grok"),
              label: "Grok",
              path: "/home/me/.grok/installed-plugins/sw-1a2b3c4d/skills/do/SKILL.md",
              scope: "plugin",
              enabled: true,
            },
            {
              ...claude,
              path: "/home/me/.claude/plugins/cache/specweave/sw/1.0.0/skills/do/SKILL.md",
              scope: "plugin",
              enabled: true,
              name: "sw:do",
            },
          ],
        }),
      ],
    };
    await render();
    await act(async () =>
      container.querySelector<HTMLElement>("button[aria-label='Show details for sw:do']")!.click(),
    );
    const panel = document.querySelector("[data-testid=skill-details]")!;
    const switches = [...panel.querySelectorAll<HTMLElement>("[data-testid=skill-agent-switch]")];
    expect(switches.map((element) => element.getAttribute("data-driver"))).toEqual([
      "grok",
      "claudeAgent",
    ]);
    expect(switches[0]!.hasAttribute("data-disabled")).toBe(true);
    expect(switches[1]!.hasAttribute("data-disabled")).toBe(true);
    const plugin = [...panel.querySelectorAll("button")].find(
      (button) =>
        button.textContent === "Turn off plugin sw" &&
        button.closest("li")?.textContent?.includes("Claude"),
    )!;
    await act(async () => plugin.click());
    expect(state.actions[0]).toEqual({
      preview: true,
      action: {
        kind: "toggle-plugin",
        provider: "claudeAgent",
        instanceId: "claudeAgent",
        pluginId: "sw@specweave",
        enabled: false,
        scope: "user",
      },
    });
    expect(panel.querySelector("[data-testid=skill-version]")?.textContent).toContain(
      "Local skill. No registry versions.",
    );
  });

  it("shows loading, error and empty states", async () => {
    state.data = null;
    state.isPending = true;
    await render();
    expect(container.textContent).toContain("Scanning skill folders and lockfiles");

    state.isPending = false;
    state.error = "Project skills could not be read.";
    await render();
    expect(container.querySelector("[role=alert]")?.textContent).toContain(
      "Project skills could not be read.",
    );

    state.error = null;
    state.data = { ...snapshot, rows: [] };
    await render();
    expect(container.textContent).toContain("No agent loads any skill in this folder");
  });
});
