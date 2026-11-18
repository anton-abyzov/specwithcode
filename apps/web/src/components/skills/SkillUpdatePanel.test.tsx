// @vitest-environment jsdom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vite-plus/test";
import { EnvironmentId, ProjectId } from "@specweave-studio/contracts";

const mocks = vi.hoisted(() => ({
  update: vi.fn(),
  reposChange: vi.fn(),
  refresh: vi.fn(),
  queryRefresh: vi.fn(),
  scopes: new Set<string>(),
  data: {} as Record<string, unknown>,
  queries: [] as Array<{ kind: string; arg: unknown }>,
}));
vi.mock("../../state/use-atom-command", () => ({
  useAtomCommand: (atom: { fn: unknown }) => atom.fn,
}));
vi.mock("../../studio/projectWorkspace", () => ({
  projectWorkspace: {
    skillFleetPush: { fn: vi.fn() },
    skillsRolloutKeep: { fn: vi.fn() },
    skillsUpdate: { fn: mocks.update },
    skillReposChange: { fn: mocks.reposChange },
    skillRepos: (arg: unknown) => ({ kind: "repos", arg }),
    skillSources: (arg: unknown) => ({ kind: "sources", arg }),
  },
}));
vi.mock("../../state/query", () => ({
  useEnvironmentQuery: (atom: { kind: string; arg: unknown } | null) => {
    if (atom) mocks.queries.push(atom);
    return {
      data: atom ? (mocks.data[atom.kind] ?? null) : null,
      error: null,
      isPending: false,
      refresh: mocks.queryRefresh,
    };
  },
}));
vi.mock("../../state/server", () => ({
  serverEnvironment: { refreshProviders: { fn: mocks.refresh } },
}));
vi.mock("../../state/session", () => ({
  useEnvironmentScope: (_environmentId: unknown, scope: string) => mocks.scopes.has(scope),
}));
vi.mock("../../studio/machineNickname", () => ({
  useMachineNickname: () => "M4",
  useMachineNicknames: () => (_id: string, label: string) => label,
}));
// No other machine is paired here, so "Also add on" stays out of these tests.
vi.mock("../../studio/fleet", () => ({ useStudioFleet: () => ({ snapshot: null }) }));
import { SkillUpdatePanel } from "./SkillUpdatePanel";
import { SkillUpdateRepos } from "./SkillUpdateRepos";

const environmentId = EnvironmentId.make("local");
const projectId = ProjectId.make("project");
const A = "a".repeat(40);
const B = "b".repeat(40);
const success = (value: unknown) => ({ _tag: "Success", value });

const status = (skill: string, state: string, latestVersion: string | null) => ({
  skill,
  repo: "anton-abyzov/vskill",
  lockScope: "user",
  installed: { version: "1.1.0", commit: A, contentHash: "1".repeat(64) },
  latest:
    latestVersion === null
      ? null
      : { version: latestVersion, commit: B, contentHash: "2".repeat(64) },
  state,
});
const SOURCES = {
  checkedAt: "2026-11-18T00:00:00.000Z",
  statuses: [
    status("html-report", "update", "1.2.0"),
    status("obsidian-brain", "changed", "1.1.0"),
    {
      ...status("gws", "current", "1.1.0"),
      latest: { version: "1.1.0", commit: B, contentHash: "1".repeat(64) },
    },
    status("pinned-one", "pinned", "2.0.0"),
  ],
};
const repoSkill = (name: string, version: string, plugin: string | null) => ({
  name,
  path: plugin ? `plugins/${plugin}/skills/${name}/SKILL.md` : `skills/${name}/SKILL.md`,
  plugin,
  version,
  commit: B,
  contentHash: "2".repeat(64),
});
const REPOS = {
  repos: [
    {
      repo: "anton-abyzov/vskill",
      visibility: "public",
      connectedAt: "2026-11-18T00:00:00.000Z",
      state: "ok",
      commit: B,
      checkedAt: "2026-11-18T00:00:00.000Z",
      skills: [repoSkill("html-report", "1.2.0", null), repoSkill("scout", "0.3.1", "personal")],
    },
    {
      repo: "acme/private-skills",
      visibility: "private",
      connectedAt: "2026-11-18T00:00:00.000Z",
      state: "needs-sign-in",
      commit: null,
      checkedAt: null,
      skills: [],
    },
  ],
  suggestions: ["anton-abyzov/anton-personal-skills"],
};

let host: HTMLDivElement;
let root: Root;
beforeEach(() => {
  mocks.scopes.clear();
  for (const scope of ["filesystem:write", "terminal:operate", "settings:write"])
    mocks.scopes.add(scope);
  mocks.data = { sources: SOURCES, repos: REPOS };
  mocks.queries.length = 0;
  mocks.refresh.mockResolvedValue(success({}));
  host = document.createElement("div");
  document.body.append(host);
  root = createRoot(host);
});
afterEach(async () => {
  await act(async () => root.unmount());
  host.remove();
  vi.resetAllMocks();
});
const button = (text: string, within: ParentNode = host) => {
  const node = [...within.querySelectorAll("button")].find(
    (entry) => entry.textContent?.trim() === text,
  );
  if (!node) throw new Error(`Missing button ${text}`);
  return node;
};
const row = (name: string) => host.querySelector<HTMLElement>(`[data-skill="${name}"]`)!;
const repo = (name: string) => host.querySelector<HTMLElement>(`[data-repo="${name}"]`)!;

describe("skill versions and updates", () => {
  const render = () =>
    act(async () =>
      root.render(
        <SkillUpdatePanel environmentId={environmentId} projectId={projectId} cwd="/work/app" />,
      ),
    );

  it("shows each skill's version and source commit against the latest in its source", async () => {
    await render();
    expect(mocks.queries[0]).toEqual({
      kind: "sources",
      arg: { environmentId, input: { projectId, cwd: "/work/app", operation: "status" } },
    });
    expect(row("html-report").textContent).toContain("1.1.0 · aaaaaaa");
    expect(row("html-report").textContent).toContain("1.2.0 · bbbbbbb");
    expect(row("html-report").textContent).toContain("Update available");
    // The same version with other content is still a difference.
    expect(row("obsidian-brain").textContent).toContain("Changed at source");
    expect(row("gws").textContent).toContain("Up to date");
    expect(row("gws").querySelector("button")).toBeNull();
    expect(row("pinned-one").textContent).toContain("Pinned");
    expect(row("pinned-one").querySelector("button")).toBeNull();
  });

  it("updates one skill and shows the version and commit read back, with readiness", async () => {
    mocks.update.mockResolvedValue(
      success({
        checkedAt: "2026-11-18T00:01:00.000Z",
        statuses: [
          {
            ...status("html-report", "current", "1.2.0"),
            installed: { version: "1.2.0", commit: B, contentHash: "2".repeat(64) },
          },
        ],
        outcomes: [
          {
            skill: "html-report",
            outcome: "updated",
            before: { version: "1.1.0", commit: A, contentHash: "1".repeat(64) },
            after: { version: "1.2.0", commit: B, contentHash: "2".repeat(64) },
            readiness: [
              {
                instanceId: "codex",
                driver: "codex",
                label: "Codex",
                readiness: "loaded-now",
                detail: "Codex lists it.",
              },
              {
                instanceId: "copilot",
                driver: "acpRegistry",
                label: "Copilot",
                readiness: "next-message",
                detail: "Copilot's folder holds it.",
              },
              {
                instanceId: "claudeAgent",
                driver: "claudeAgent",
                label: "Claude",
                readiness: "next-session",
                detail: "Claude reads skills when a session starts.",
              },
            ],
          },
        ],
      }),
    );
    await render();
    await act(async () => button("Update", row("html-report")).click());
    expect(mocks.update.mock.calls[0]?.[0]).toEqual({
      environmentId,
      input: { projectId, cwd: "/work/app", operation: "update", skills: ["html-report"] },
    });
    const text = row("html-report").textContent ?? "";
    expect(text).toContain("Updated html-report to 1.2.0 · bbbbbbb");
    expect(text).toContain("Codex: Loaded now");
    expect(text).toContain("Copilot: Next message");
    expect(text).toContain("Claude: Next session");
    expect(text).toContain("Up to date");
    expect(mocks.refresh.mock.calls[0]?.[0]).toEqual({
      environmentId,
      input: { instanceId: "codex", cwd: "/work/app", fresh: true },
    });
  });

  it("updates every outdated skill with one press", async () => {
    mocks.update.mockResolvedValue(
      success({
        checkedAt: "2026-11-18T00:01:00.000Z",
        statuses: SOURCES.statuses,
        outcomes: [
          {
            skill: "obsidian-brain",
            outcome: "failed",
            before: null,
            after: null,
            message: "vskill.lock still records the old copy.",
            readiness: [],
          },
        ],
      }),
    );
    await render();
    await act(async () => button("Update all (2)").click());
    expect(mocks.update.mock.calls[0]?.[0].input).toEqual({
      projectId,
      cwd: "/work/app",
      operation: "update",
    });
    expect(row("obsidian-brain").textContent).toContain("vskill.lock still records the old copy.");
  });

  it("does not offer updates without permission to change files and run vskill", async () => {
    mocks.scopes.delete("filesystem:write");
    await render();
    expect(button("Update", row("html-report")).disabled).toBe(true);
    expect(button("Update all (2)").disabled).toBe(true);
  });

  it("says when nothing on the machine is tracked", async () => {
    mocks.data = { sources: { checkedAt: SOURCES.checkedAt, statuses: [] } };
    await render();
    expect(host.textContent).toContain("No skill on M4 records a source yet.");
  });
});

describe("connected skill repos", () => {
  const render = () =>
    act(async () =>
      root.render(
        <SkillUpdateRepos environmentId={environmentId} projectId={projectId} cwd="/work/app" />,
      ),
    );
  const type = async (text: string) => {
    const input = host.querySelector<HTMLInputElement>("input")!;
    const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!;
    await act(async () => {
      setter.call(input, text);
      input.dispatchEvent(new Event("input", { bubbles: true }));
    });
  };

  it("lists a repo's skills with version and commit, in both layouts", async () => {
    await render();
    const text = repo("anton-abyzov/vskill").textContent ?? "";
    expect(text).toContain("Public");
    expect(text).toContain("html-report");
    expect(text).toContain("1.2.0 · bbbbbbb");
    expect(text).toContain("scout");
    expect(text).toContain("0.3.1 · bbbbbbb");
    expect(text).toContain("personal");
  });

  it("names the machine to sign in on for a private repo it cannot read", async () => {
    await render();
    expect(repo("acme/private-skills").textContent).toContain(
      "Sign in to GitHub on M4 to read acme/private-skills",
    );
  });

  it("connects a typed repo and shows the refusal for one it cannot read", async () => {
    mocks.reposChange.mockResolvedValue(
      success({ ...REPOS, refusal: { reason: "needs-sign-in", repo: "acme/secret" } }),
    );
    await render();
    await type("https://github.com/acme/secret");
    await act(async () => button("Connect").click());
    expect(mocks.reposChange.mock.calls[0]?.[0]).toEqual({
      environmentId,
      input: { projectId, operation: "connect", repo: "https://github.com/acme/secret" },
    });
    expect(host.querySelector('[role="alert"]')?.textContent).toBe(
      "Sign in to GitHub on M4 to read acme/secret",
    );
  });

  it("refuses text that is not a GitHub repo before asking the machine", async () => {
    await render();
    await type("not a repo");
    await act(async () => button("Connect").click());
    expect(mocks.reposChange).not.toHaveBeenCalled();
    expect(host.querySelector('[role="alert"]')?.textContent).toBe(
      "Name the repo as owner/repo or paste its GitHub link.",
    );
  });

  it("suggests repos that are not connected yet and disconnects one", async () => {
    mocks.reposChange.mockResolvedValue(success({ ...REPOS, suggestions: [] }));
    await render();
    await act(async () => button("Connect anton-abyzov/anton-personal-skills").click());
    expect(mocks.reposChange.mock.calls[0]?.[0].input).toEqual({
      projectId,
      operation: "connect",
      repo: "anton-abyzov/anton-personal-skills",
    });
    await act(async () => button("Disconnect", repo("acme/private-skills")).click());
    expect(mocks.reposChange.mock.calls[1]?.[0].input).toEqual({
      projectId,
      operation: "disconnect",
      repo: "acme/private-skills",
    });
  });

  it("does not offer changes without permission to change settings", async () => {
    mocks.scopes.delete("settings:write");
    await render();
    expect(button("Connect").disabled).toBe(true);
    expect(button("Disconnect", repo("acme/private-skills")).disabled).toBe(true);
  });

  it("installs a listed skill only when asked", async () => {
    mocks.update.mockResolvedValue(
      success({ checkedAt: "2026-11-18T00:00:00.000Z", statuses: [], outcomes: [] }),
    );
    await render();
    expect(mocks.update).not.toHaveBeenCalled();
    const scout = repo("anton-abyzov/vskill").querySelector<HTMLElement>('[data-skill="scout"]')!;
    await act(async () => button("Install", scout).click());
    expect(mocks.update.mock.calls[0]?.[0].input).toEqual({
      projectId,
      cwd: "/work/app",
      operation: "install",
      install: { repo: "anton-abyzov/vskill", skill: "scout" },
    });
  });
});
