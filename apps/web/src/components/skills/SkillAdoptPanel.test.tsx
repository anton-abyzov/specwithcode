// @vitest-environment jsdom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vite-plus/test";
import { EnvironmentId, ProjectId } from "@specweave-studio/contracts";

const mocks = vi.hoisted(() => ({
  adopt: vi.fn(),
  open: vi.fn(),
  scopes: new Set<string>(),
}));
vi.mock("../../state/use-atom-command", () => ({
  useAtomCommand: (atom: { fn: unknown }) => atom.fn,
}));
vi.mock("../../studio/projectWorkspace", () => ({
  projectWorkspace: {
    skillsAdopt: { fn: mocks.adopt },
    skillRepos: (arg: unknown) => ({ kind: "repos", arg }),
  },
}));
vi.mock("../../state/query", () => ({
  useEnvironmentQuery: () => ({
    data: {
      repos: [
        { repo: "anton-abyzov/vskill", visibility: "public", state: "ok" },
        { repo: "acme/team-skills", visibility: "private", state: "ok" },
      ],
    },
    error: null,
    isPending: false,
    refresh: vi.fn(),
  }),
}));
vi.mock("../../state/session", () => ({
  useEnvironmentScope: (_environmentId: unknown, scope: string) => mocks.scopes.has(scope),
}));
vi.mock("../../state/server", () => ({ serverEnvironment: { refreshProviders: { fn: vi.fn() } } }));
vi.mock("../settings/ProjectSkillRowMenu", () => ({ openSkillLink: mocks.open }));
import { SkillAdoptPanel, proposalRepoOf } from "./SkillAdoptPanel";

const environmentId = EnvironmentId.make("env-m4");
const projectId = ProjectId.make("project");
const success = (value: unknown) => ({ _tag: "Success", value });
const MATCH = {
  repo: "anton-abyzov/vskill",
  source: { kind: "github", path: "skills/gws/SKILL.md", branch: "main", commit: "c".repeat(40) },
  version: "1.0.2",
  contentHash: "d".repeat(64),
  visibility: "public",
};

let host: HTMLDivElement;
let root: Root;
beforeEach(() => {
  mocks.scopes.clear();
  for (const scope of [
    "filesystem:read",
    "filesystem:write",
    "source-control:write",
    "terminal:operate",
  ])
    mocks.scopes.add(scope);
  host = document.createElement("div");
  document.body.append(host);
  root = createRoot(host);
});
afterEach(async () => {
  await act(async () => root.unmount());
  host.remove();
  document.body.innerHTML = "";
  vi.resetAllMocks();
});
const flush = () => act(async () => new Promise((resolve) => setTimeout(resolve, 0)));
const render = async () => {
  await act(async () =>
    root.render(<SkillAdoptPanel environmentId={environmentId} projectId={projectId} />),
  );
  await flush();
};
const button = (text: string, within: ParentNode = document.body) => {
  const node = [...within.querySelectorAll("button")].find(
    (entry) => entry.textContent?.trim() === text,
  );
  if (!node) throw new Error(`Missing button ${text}`);
  return node;
};
const row = (skill: string) => host.querySelector<HTMLElement>(`[data-skill="${skill}"]`)!;
const inputs = () =>
  mocks.adopt.mock.calls.map(([arg]) => (arg as { input: { operation: string } }).input);

describe("Adopt and Add to a repo", () => {
  it("offers a connected private repo first", () => {
    expect(
      proposalRepoOf([
        { repo: "a/public", visibility: "public", state: "ok" },
        { repo: "a/private", visibility: "private", state: "ok" },
      ]),
    ).toBe("a/private");
    expect(
      proposalRepoOf([{ repo: "a/x", visibility: "private", state: "needs-sign-in" }]),
    ).toBeNull();
  });

  it("adopts a matching skill and says the folder is unchanged", async () => {
    let adopted = false;
    mocks.adopt.mockImplementation(async ({ input }: { input: { operation: string } }) =>
      input.operation === "adopt"
        ? ((adopted = true),
          success({
            checkedAt: "2026-11-18T00:00:00.000Z",
            outcome: {
              skill: "gws",
              outcome: "adopted",
              version: "1.0.2",
              commit: "ccccccc",
              releasedFromNpxSkills: true,
            },
          }))
        : success({
            checkedAt: "2026-11-18T00:00:00.000Z",
            candidates: [
              ...(adopted
                ? []
                : [
                    {
                      skill: "gws",
                      tracker: "npx-skills",
                      trackedSource: "anton-abyzov/vskill",
                      match: MATCH,
                    },
                  ]),
              {
                skill: "notes",
                tracker: "none",
                match: null,
                detail: "No connected repo holds this copy.",
              },
            ],
          }),
    );
    await render();
    expect(row("gws").textContent).toContain("Tracked by npx skills");
    expect(row("gws").textContent).toContain("Matches anton-abyzov/vskill 1.0.2");
    await act(async () => button("Adopt", row("gws")).click());
    await flush();
    expect(inputs().map((input) => input.operation)).toEqual(["check", "adopt", "check"]);
    expect(row("gws")).toBeNull();
  });

  it("keeps Adopt off without permission to change files here", async () => {
    mocks.scopes.delete("filesystem:write");
    mocks.adopt.mockResolvedValue(
      success({
        checkedAt: "2026-11-18T00:00:00.000Z",
        candidates: [{ skill: "gws", tracker: "npx-skills", match: MATCH }],
      }),
    );
    await render();
    expect(button("Adopt", row("gws")).disabled).toBe(true);
  });

  it("asks before each pull request and never merges", async () => {
    mocks.adopt.mockImplementation(async ({ input }: { input: { operation: string } }) =>
      input.operation === "check"
        ? success({
            checkedAt: "2026-11-18T00:00:00.000Z",
            candidates: [
              {
                skill: "notes",
                tracker: "none",
                match: null,
                detail: "No connected repo holds this copy.",
              },
            ],
          })
        : input.operation === "propose-preview"
          ? success({
              checkedAt: "2026-11-18T00:00:00.000Z",
              proposal: {
                repo: "acme/team-skills",
                skill: "notes",
                files: ["skills/notes/SKILL.md"],
                skipped: [".DS_Store"],
                fingerprint: "fp",
              },
            })
          : success({
              checkedAt: "2026-11-18T00:00:00.000Z",
              pullRequestUrl: "https://github.com/acme/team-skills/pull/7",
            }),
    );
    await render();
    await act(async () => button("Add to team-skills", row("notes")).click());
    await flush();
    // Nothing is written to GitHub until the confirmation.
    expect(inputs().map((input) => input.operation)).toEqual(["check", "propose-preview"]);
    expect(document.body.textContent).toContain("Open a pull request on acme/team-skills?");
    expect(document.body.textContent).toContain("skills/notes/SKILL.md");
    await act(async () => button("Open pull request").click());
    await flush();
    const propose = inputs().at(-1) as unknown as Record<string, unknown>;
    expect(propose).toMatchObject({ operation: "propose", fingerprint: "fp", confirmed: true });
    expect(row("notes").textContent).toContain("It is not merged.");
  });
});
