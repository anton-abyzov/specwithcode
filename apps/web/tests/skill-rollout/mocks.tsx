// Fixture answers for "Also add on", Adopt and the machine table. Nothing here reaches a machine.
const A = "3f9c2ab".padEnd(40, "0");
const B = "8d41e07".padEnd(40, "0");
const C = "5be0c11".padEnd(40, "0");
const hash = (char: string) => char.repeat(64);
const success = (value: unknown) => Promise.resolve({ _tag: "Success", value });
const at = "2026-11-18T00:00:00.000Z";

const repos = {
  repos: [
    {
      repo: "anton-abyzov/vskill",
      visibility: "public",
      connectedAt: at,
      state: "ok",
      commit: B,
      checkedAt: at,
      skills: [],
    },
    {
      repo: "acme/team-skills",
      visibility: "private",
      connectedAt: at,
      state: "ok",
      commit: C,
      checkedAt: at,
      skills: [],
    },
  ],
  suggestions: [],
};
const status = (skill: string, version: string) => ({
  skill,
  repo: "anton-abyzov/vskill",
  lockScope: "user",
  installed: { version, commit: B, contentHash: hash("b") },
  installedSource: { path: `skills/${skill}/SKILL.md`, branch: "main" },
  latest: { version, commit: B, contentHash: hash("b") },
  state: "current",
});
const sources = {
  checkedAt: at,
  statuses: [status("html-report", "1.2.0"), status("obsidian-brain", "1.1.0")],
};

// Laptop has an older copy, Build box has none and no vskill, Old desk cannot preview.
const preview = (machineId: string) =>
  machineId === "old-desk"
    ? {
        machineId,
        ok: false,
        reason: "unsupported",
        message: "Old desk cannot add skills from a GitHub repo; update it first.",
      }
    : {
        machineId,
        ok: true,
        preview: true,
        expectedHash: `fp-${machineId}`,
        installedVersion: machineId === "laptop" ? "1.1.0" : null,
        files: ["/home/demo/.agents/skills/html-report/SKILL.md"],
        via: machineId === "build-box" ? "npx" : "vskill",
        previous:
          machineId === "laptop"
            ? {
                version: "1.1.0",
                commit: A,
                contentHash: hash("a"),
                branch: "main",
                path: "skills/html-report/SKILL.md",
              }
            : null,
      };
const applied = (machineId: string) =>
  machineId === "laptop"
    ? {
        machineId,
        ok: true,
        installedVersion: "1.2.0",
        via: "vskill",
        previous: {
          version: "1.1.0",
          commit: A,
          contentHash: hash("a"),
          branch: "main",
          path: "skills/html-report/SKILL.md",
        },
      }
    : {
        machineId,
        ok: false,
        reason: "install-failed",
        message: "npx exited 1: GitHub answered 502",
      };
const push = ({ input }: any) =>
  success({
    preview: input.preview === true,
    results: input.targets.map((target: { machineId: string }) =>
      input.preview ? preview(target.machineId) : applied(target.machineId),
    ),
  });

const adopt = ({ input }: any) =>
  success(
    input.operation === "check"
      ? {
          checkedAt: at,
          candidates: [
            {
              skill: "asc-signing-setup",
              tracker: "npx-skills",
              trackedSource: "acme/app-store-skills",
              match: {
                repo: "acme/app-store-skills",
                source: {
                  kind: "github",
                  path: "skills/asc-signing-setup/SKILL.md",
                  branch: "main",
                  commit: C,
                },
                version: "1.0.0",
                contentHash: hash("c"),
                visibility: "public",
              },
            },
            {
              skill: "tax-notes",
              tracker: "none",
              match: null,
              detail: "No connected repo holds this copy.",
            },
          ],
        }
      : input.operation === "propose-preview"
        ? {
            checkedAt: at,
            proposal: {
              repo: "acme/team-skills",
              skill: input.skill,
              files: [
                `skills/${input.skill}/SKILL.md`,
                `skills/${input.skill}/references/forms.md`,
              ],
              skipped: [".DS_Store"],
              fingerprint: "fp",
            },
          }
        : { checkedAt: at },
  );

// "Across machines": Claude on Laptop could not open one of its skill folders.
const provider = (instanceId: string, label: string, incomplete = false) => ({
  instanceId,
  driver: instanceId,
  label,
  state: "ok",
  ...(incomplete ? { incomplete: true } : {}),
});
const row = (name: string, version: string) => ({
  name,
  providers: [
    {
      instanceId: "codex",
      driver: "codex",
      label: "Codex",
      path: `/home/demo/.agents/skills/${name}/SKILL.md`,
      scope: "user",
      enabled: true,
      fileVersion: version,
    },
  ],
  lock: null,
  divergent: false,
});
export const snapshots: Record<string, unknown> = {
  laptop: {
    checkedAt: "2026-11-18T14:05:00.000Z",
    rows: [row("html-report", "1.2.0")],
    providers: [provider("codex", "Codex"), provider("claudeAgent", "Claude", true)],
  },
  "build-box": {
    checkedAt: "2026-11-18T14:05:00.000Z",
    rows: [row("html-report", "1.2.0"), row("obsidian-brain", "1.1.0")],
    providers: [provider("codex", "Codex")],
  },
};
export const localSnapshot = {
  checkedAt: "2026-11-18T14:05:00.000Z",
  rows: [row("html-report", "1.2.0"), row("obsidian-brain", "1.1.0")],
  providers: [provider("codex", "Codex"), provider("claudeAgent", "Claude")],
};

export const projectWorkspace = {
  skillsSearch: { fn: () => success({ query: "", installed: [], available: [], notes: [] }) },
  skillsUpdate: { fn: () => success(sources) },
  skillReposChange: { fn: () => success(repos) },
  skillRepos: () => ({ data: repos }),
  skillSources: () => ({ data: sources }),
  skillFleetPush: { fn: push },
  skillsRolloutKeep: { fn: () => success({ records: [] }) },
  skillsAdopt: { fn: adopt },
  skills: (query: { environmentId: string }) => ({ data: snapshots[query.environmentId] ?? null }),
};
const machine = (id: string, label: string, fields: Record<string, unknown> = {}) => ({
  id,
  label,
  environmentId: id,
  url: `http://${id}.example:8319`,
  status: "reachable",
  pairingConfigured: true,
  ...fields,
});
const fleetSnapshot = {
  machines: [
    machine("local", "Workstation"),
    machine("laptop", "Laptop"),
    machine("build-box", "Build box"),
    machine("tower", "Tower", { status: "unreachable" }),
    machine("mini", "Mini", { pairingConfigured: false }),
    machine("old-desk", "Old desk"),
  ],
};
export const useStudioFleet = () => ({
  snapshot: fleetSnapshot,
  loading: false,
  failed: false,
  refresh: () => {},
});
export const useFleetSkillGithubSupported = () => true;
export const serverEnvironment = { refreshProviders: { fn: () => success({}) } };
export const useAtomCommand = (atom: { fn: unknown }) => atom.fn;
export const useEnvironmentQuery = (atom: { data: unknown } | null) => ({
  data: atom?.data ?? null,
  error: null,
  isPending: false,
  isSuccess: atom?.data != null,
  refresh: () => {},
});
export const useEnvironmentScope = () => true;
export const useMachineNickname = () => "Workstation";
export const useMachineNicknames = () => (_id: string, label?: string | null) => label ?? "?";
export const useEnvironment = (environmentId: string) => ({
  label: environmentId === "local" ? "Workstation" : environmentId,
  connection: { phase: "connected" },
});
// Names other modules of the app import from the stubbed files; none is called here.
export const useThreadShell = () => null;
export const useOrchestrationCommand = () => () => Promise.resolve();
export const usePreparedConnection = () => null;
export const awaitEnvironmentScope = () => Promise.resolve(true);
export const readEnvironmentScope = () => true;
export const environmentServerConfigsAtom = null;
export const refreshSkillAvailability = () => {};
export const openSkillLink = () => Promise.resolve();
