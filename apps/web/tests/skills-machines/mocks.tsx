// Synthetic machines and skills for the Skills page fixture. Nothing here reads a real home.
import type { ProjectSkillsSnapshot } from "@specweave-studio/contracts";

const params = new URLSearchParams(location.search);
export const fixtureCase = params.get("case") ?? "synced";
/** The machine the page is set up for; the person sits at the laptop. */
export const fixtureMachine =
  fixtureCase === "offline" ? "mini" : fixtureCase === "view-only" ? "desktop" : "laptop";

const agent = (driver: string, label: string, scope: string, path: string, version?: string) => ({
  instanceId: driver,
  driver,
  label,
  path,
  scope,
  enabled: true,
  ...(version ? { fileVersion: version } : {}),
});
const row = (name: string, description: string, presence: ReturnType<typeof agent>) => ({
  name,
  description,
  status: "ok",
  attention: false,
  issues: [],
  path: presence.path,
  scopes: [presence.scope],
  providers: [presence],
  lock: null,
  drift: "unlocked",
  copies: 1,
  divergent: false,
  doctor: [],
});
const synced = (name: string, description: string) =>
  row(
    `anthropic-skills:${name}`,
    description,
    agent(
      "claudeAgent",
      "Claude",
      "claude.ai",
      `/home/demo/.claude/skills/synced/account_org/${name}/SKILL.md`,
    ),
  );
const system = (name: string, description: string) =>
  row(
    name,
    description,
    agent("codex", "Codex", "system", `/home/demo/.codex/skills/.system/${name}/SKILL.md`),
  );
const installed = (name: string, description: string, version?: string) =>
  row(
    name,
    description,
    agent("codex", "Codex", "user", `/home/demo/.agents/skills/${name}/SKILL.md`, version),
  );

const SYNCED = [
  synced("docx", "Create and edit Word documents."),
  synced("pdf", "Read, fill and assemble PDF files."),
  synced("pptx", "Build and edit slide decks."),
  synced("xlsx", "Work with spreadsheets."),
  synced("deep-research", "Research a topic across many sources."),
  synced("morning", "A short brief for the start of the day."),
];
const SYSTEM = [
  system("imagegen", "Generate and edit images."),
  system("openai-docs", "Look up current OpenAI documentation."),
  system("plugin-creator", "Scaffold a Codex plugin."),
  system("skill-creator", "Write a new skill."),
  system("skill-installer", "Install a skill from a list or a repository."),
  system("plan", "Plan a change before making it."),
];
const snapshotOf = (
  rows: ReadonlyArray<unknown>,
  counts: Readonly<Record<string, number>>,
  checkedAt = "2026-11-18T15:04:00.000Z",
) =>
  ({
    cwd: "~",
    checkedAt,
    rows,
    providers: Object.entries(counts).map(([label, skills]) => ({
      instanceId: label === "Claude" ? "claudeAgent" : "codex",
      driver: label === "Claude" ? "claudeAgent" : "codex",
      label,
      state: "ok",
      skills,
    })),
    locks: [],
    doctor: "unavailable",
  }) as unknown as ProjectSkillsSnapshot;

const LAPTOP_ACROSS = [
  installed("release-notes", "Draft release notes from merged changes.", "1.4.0"),
  installed("image-workflow", "Review illustrations before publishing.", "2.1.0"),
  installed("meeting-notes", "Turn a transcript into decisions and actions."),
  ...SYNCED.slice(0, 2),
  ...SYSTEM.slice(0, 2),
];
const SNAPSHOTS: Readonly<Record<string, Readonly<Record<string, ProjectSkillsSnapshot>>>> = {
  synced: { laptop: snapshotOf(SYNCED, { Claude: SYNCED.length, Codex: 0 }) },
  codex: { laptop: snapshotOf(SYSTEM, { Claude: 0, Codex: SYSTEM.length }) },
  "view-only": { desktop: snapshotOf(LAPTOP_ACROSS, { Claude: 2, Codex: 5 }) },
  across: {
    laptop: snapshotOf(LAPTOP_ACROSS, { Claude: 2, Codex: 5 }),
    desktop: snapshotOf(
      [
        installed("release-notes", "Draft release notes from merged changes.", "1.3.0"),
        installed("image-workflow", "Review illustrations before publishing.", "2.1.0"),
        ...SYNCED.slice(0, 1),
        ...SYSTEM.slice(0, 2),
      ],
      { Claude: 1, Codex: 4 },
      "2026-11-18T15:03:00.000Z",
    ),
  },
};

const MACHINES = [
  { id: "laptop", label: "Laptop", phase: "connected", status: "reachable" },
  { id: "desktop", label: "Desktop", phase: "connected", status: "reachable" },
  { id: "mini", label: "Mini", phase: "idle", status: "unreachable" },
] as const;

export const projectWorkspace = {
  skills: (query: { environmentId: string }) => ({ machine: query.environmentId }),
};
export function useEnvironmentQuery(atom: { machine: string } | null) {
  const data = atom ? (SNAPSHOTS[fixtureCase]?.[atom.machine] ?? null) : null;
  return {
    data,
    error: null,
    isPending: false,
    isSuccess: data !== null,
    refresh: () => {},
  };
}
const presentation = (machine: (typeof MACHINES)[number]) => ({
  environmentId: machine.id,
  label: machine.label,
  connection: { phase: machine.phase },
  serverConfig: null,
  // The laptop is the device in front of the person: a server reached over loopback.
  entry: {
    target:
      machine.id === "laptop"
        ? { _tag: "PrimaryConnectionTarget", httpBaseUrl: "http://127.0.0.1:3000" }
        : { _tag: "PrimaryConnectionTarget", httpBaseUrl: "http://desk.example:3000" },
  },
});
export function useEnvironment(environmentId: string | null) {
  const machine = MACHINES.find((candidate) => candidate.id === environmentId);
  return machine ? presentation(machine) : null;
}
export function useEnvironments() {
  return { environments: MACHINES.map(presentation), presentationById: new Map() };
}
export const usePrimaryEnvironmentId = () => "laptop";
export const useEnvironmentScope = () => fixtureCase !== "view-only";
const nickname = (environmentId: string, fallback?: string | null) =>
  MACHINES.find((candidate) => candidate.id === environmentId)?.label ?? fallback ?? environmentId;
export const useMachineNickname = nickname;
export const useMachineNicknames = () => nickname;
export function useStudioFleet() {
  return {
    snapshot: {
      machines: MACHINES.map((machine) => ({
        id: `fleet-${machine.id}`,
        environmentId: machine.id,
        label: machine.label,
        status: machine.status,
      })),
    },
    loading: false,
    failed: false,
    refresh: () => {},
  };
}
const NO_ENTRIES = new Map();
export const useProviderEntries = () => NO_ENTRIES;

const NO_SEARCH = {};
export const useSearch = () => NO_SEARCH;
export const useNavigate = () => () => Promise.resolve();

// The scope line at the top of the page.
export const useLocation = (input: { select: (location: { pathname: string }) => unknown }) =>
  input.select({ pathname: "/settings/skills" });
export const useOptionalSettingsScope = () => ({
  search: { machine: fixtureMachine },
  singleEnvironment: true,
  groups: [],
  scope: { kind: "environment" },
  selectScope: () => {},
});
export const useNamedEnvironments = () => ({ environments: MACHINES.map(presentation) });
export const useServerConfigs = () => new Map();
