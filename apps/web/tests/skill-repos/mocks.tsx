// Fixture answers for the skill search, repos and update panels. Nothing here reaches a machine.
const A = "3f9c2ab".padEnd(40, "0");
const B = "8d41e07".padEnd(40, "0");
const hash = (char: string) => char.repeat(64);
const success = (value: unknown) => Promise.resolve({ _tag: "Success", value });
const repoSkill = (name: string, version: string, plugin: string | null, description: string) => ({
  name,
  path: plugin ? `plugins/${plugin}/skills/${name}/SKILL.md` : `skills/${name}/SKILL.md`,
  plugin,
  version,
  description,
  commit: B,
  contentHash: hash("b"),
});
const repos = {
  repos: [
    {
      repo: "anton-abyzov/vskill",
      visibility: "public",
      connectedAt: "2026-11-18T00:00:00.000Z",
      state: "ok",
      commit: B,
      checkedAt: "2026-11-18T00:00:00.000Z",
      skills: [
        repoSkill("html-report", "1.2.0", null, "Write work reports that render well."),
        repoSkill("report-builder", "0.4.0", null, "Build a weekly report from notes."),
        repoSkill("scout", "0.3.1", "skills", "Find skills for a task."),
      ],
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
const status = (skill: string, state: string, latest: string, same = false) => ({
  skill,
  repo: "anton-abyzov/vskill",
  lockScope: "user",
  installed: { version: "1.1.0", commit: A, contentHash: hash("a") },
  latest: { version: latest, commit: B, contentHash: same ? hash("a") : hash("b") },
  state,
});
const sources = {
  checkedAt: "2026-11-18T00:00:00.000Z",
  statuses: [
    status("html-report", "update", "1.2.0"),
    status("obsidian-brain", "changed", "1.1.0"),
    status("gws", "current", "1.1.0", true),
    status("release-notes", "pinned", "2.0.0"),
  ],
};
const readiness = [
  { instanceId: "codex", driver: "codex", label: "Codex", readiness: "loaded-now", detail: "" },
  {
    instanceId: "copilot",
    driver: "acpRegistry",
    label: "Copilot",
    readiness: "next-message",
    detail: "",
  },
  {
    instanceId: "claudeAgent",
    driver: "claudeAgent",
    label: "Claude",
    readiness: "next-session",
    detail: "",
  },
];
const search = ({ input }: any) =>
  success({
    query: input.query ?? "",
    installed: [
      {
        name: "html-report",
        description: "Write work reports that render well.",
        version: "1.1.0",
        agents: ["Claude", "Codex"],
      },
    ],
    available: [
      { repo: "anton-abyzov/vskill", visibility: "public", skill: repos.repos[0]!.skills[1] },
    ],
    notes: [
      {
        title: "Report skills",
        path: "Resources/AI Skills/Report skills.md",
        vault: "notes",
        snippet: "How the html-report skill is used for the weekly report.",
      },
    ],
    notesState: "partial",
    opened: true,
  });
const update = ({ input }: any) =>
  success({
    checkedAt: "2026-11-18T00:01:00.000Z",
    statuses: sources.statuses.map((entry) =>
      entry.skill === "html-report"
        ? { ...entry, state: "current", installed: entry.latest }
        : entry,
    ),
    outcomes: [
      input.operation === "install"
        ? {
            skill: input.install.skill,
            outcome: "installed",
            before: null,
            after: { version: "0.4.0", commit: B, contentHash: hash("b") },
            readiness,
          }
        : {
            skill: "html-report",
            outcome: "updated",
            before: sources.statuses[0]!.installed,
            after: sources.statuses[0]!.latest,
            readiness,
          },
    ],
  });
export const projectWorkspace = {
  skillsSearch: { fn: search },
  skillsUpdate: { fn: update },
  skillReposChange: {
    fn: ({ input }: any) =>
      success(
        input.operation === "connect"
          ? { ...repos, refusal: { reason: "needs-sign-in", repo: "acme/secret" } }
          : repos,
      ),
  },
  skillRepos: () => ({ data: repos }),
  skillSources: () => ({ data: sources }),
};
export const serverEnvironment = { refreshProviders: { fn: () => success({}) } };
export const useAtomCommand = (atom: { fn: unknown }) => atom.fn;
export const useEnvironmentQuery = (atom: { data: unknown } | null) => ({
  data: atom?.data ?? null,
  error: null,
  isPending: false,
  refresh: () => {},
});
export const useEnvironmentScope = () => true;
export const useMachineNickname = () => "Workstation";
// Names other modules of the app import from the stubbed files; none is called here.
export const useThreadShell = () => null;
export const useEnvironment = () => null;
export const useOrchestrationCommand = () => () => Promise.resolve();
export const usePreparedConnection = () => null;
export const awaitEnvironmentScope = () => Promise.resolve(true);
export const readEnvironmentScope = () => true;
export const environmentServerConfigsAtom = null;
