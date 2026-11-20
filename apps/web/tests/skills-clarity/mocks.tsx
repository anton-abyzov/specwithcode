// Synthetic agents, machines and skills for the skills clarity fixture. Nothing here reads a real home.
import type { ProjectSkillsSnapshot, ServerProviderSkill } from "@specweave-studio/contracts";
import type { ReactNode } from "react";

const params = new URLSearchParams(location.search);
export const fixtureView = params.get("view") ?? "settings";

const TOPICS = [
  "release-notes",
  "meeting-notes",
  "image-workflow",
  "api-review",
  "changelog",
  "db-migration",
  "design-tokens",
  "docs-style",
  "e2e-smoke",
  "incident-report",
  "invoice-check",
  "load-test",
  "localize",
  "onboarding",
  "perf-audit",
  "pr-summary",
  "queue-triage",
  "schema-diff",
  "security-scan",
  "support-reply",
];
/** 72 fictional skill names: twenty topics in a few flavours. */
const NAMES = ["", "-team", "-draft", "-legacy"]
  .flatMap((suffix) => TOPICS.map((topic) => `${topic}${suffix}`))
  .slice(0, 72);

const presence = (
  driver: string,
  label: string,
  scope: string,
  path: string,
  extra: Record<string, unknown> = {},
) => ({ instanceId: driver, driver, label, path, scope, enabled: true, ...extra });
const lockOf = (
  name: string,
  scope: "project" | "user",
  version: string,
  source: string | null,
) => ({
  lockPath: scope === "project" ? "/work/app/vskill.lock" : "/home/demo/.agents/vskill.lock",
  lockScope: scope,
  version,
  tier: null,
  source,
  sha: null,
  installedAt: "2026-11-02T10:00:00.000Z",
  name,
});

function rowOf(name: string, index: number) {
  const project = index % 3 !== 1;
  const base = project ? "/work/app" : "/home/demo";
  const scope = project ? "project" : "user";
  const providers: Array<ReturnType<typeof presence>> = [];
  if (index % 4 !== 3)
    providers.push(
      presence("claudeAgent", "Claude", scope, `${base}/.claude/skills/${name}/SKILL.md`, {
        fileVersion: `1.${index % 5}.0`,
      }),
    );
  if (index % 2 === 0)
    providers.push(
      presence("copilot", "Copilot", scope, `${base}/.agents/skills/${name}/SKILL.md`, {
        discovery: "folder-scan",
        fileVersion: `1.${index % 5}.0`,
        // Every sixth one also sits at the other level, behind the first copy.
        ...(index % 6 === 0
          ? {
              otherCopies: [
                {
                  path: `${project ? "/home/demo" : "/work/app"}/.agents/skills/${name}/SKILL.md`,
                  scope: project ? "user" : "project",
                },
              ],
            }
          : {}),
      }),
    );
  if (providers.length === 0)
    providers.push(presence("codex", "Codex", scope, `${base}/.agents/skills/${name}/SKILL.md`));
  const lock =
    index % 5 === 0
      ? lockOf(name, scope, `1.${index % 5}.0`, "github:example-org/skills")
      : index % 5 === 1
        ? lockOf(name, scope, `1.${index % 5}.0`, null)
        : null;
  return {
    name,
    description: `Fictional skill ${index + 1} for the fixture.`,
    status: "ok",
    attention: false,
    issues: [],
    path: providers[0]!.path,
    scopes: [scope],
    providers,
    lock,
    drift: lock ? "match" : "unlocked",
    copies: providers.length,
    divergent: false,
    doctor: [],
  };
}
const ROWS = NAMES.map(rowOf);
const snapshotOf = (rows: ReadonlyArray<unknown>, checkedAt: string, complete = false) =>
  ({
    cwd: "/work/app",
    checkedAt,
    rows,
    providers: [
      {
        instanceId: "claudeAgent",
        driver: "claudeAgent",
        label: "Claude",
        state: "ok",
        skills: 54,
      },
      {
        instanceId: "copilot",
        driver: "copilot",
        label: "Copilot",
        state: "unsupported",
        // The app scanned its skill folders itself.
        discovery: "folder-scan",
        skills: 36,
      },
      { instanceId: "codex", driver: "codex", label: "Codex", state: "ok", skills: 18 },
      // One agent whose folder scan did not finish, unless the read is complete.
      ...(complete
        ? []
        : [
            {
              instanceId: "gemini",
              driver: "gemini",
              label: "Gemini",
              state: "timeout",
              skills: 0,
            },
          ]),
    ],
    locks: [{ path: "/work/app/vskill.lock", scope: "project", skills: 15 }],
    doctor: "unavailable",
  }) as unknown as ProjectSkillsSnapshot;

const SNAPSHOTS: Readonly<Record<string, ProjectSkillsSnapshot>> = {
  laptop: snapshotOf(ROWS, "2026-11-18T15:04:00.000Z"),
  // The other machine holds fewer, some at an older version.
  desktop: snapshotOf(
    ROWS.filter((_, index) => index % 4 !== 2).map((row, index) =>
      index % 7 === 0
        ? {
            ...row,
            providers: row.providers.map((entry) =>
              "fileVersion" in entry ? { ...entry, fileVersion: "0.9.0" } : entry,
            ),
          }
        : row,
    ),
    "2026-11-18T15:03:00.000Z",
    true,
  ),
};

/**
 * What the agent itself advertises: commands with no file path. Sixty share a
 * name with a file the app found; four have no file under that name.
 */
export const advertisedSkills: ReadonlyArray<ServerProviderSkill> = [
  ...NAMES.filter((_, index) => index % 2 === 0).map((name, index) => ({
    name,
    path: `acp://skill/${name}`,
    scope: "agent",
    enabled: true,
    description: `Fictional skill ${index + 1} for the fixture.`,
  })),
  ...["agent-builtin-plan", "agent-builtin-review", "remote-lookup", "session-recap"].map(
    (name) => ({
      name,
      path: `acp://command/${name}`,
      scope: "agent",
      enabled: true,
      description: "Advertised by the agent with no file path.",
    }),
  ),
] as ReadonlyArray<ServerProviderSkill>;

export const fixtureProvider = {
  instanceId: "copilot",
  driverKind: "copilot",
  displayName: "Copilot",
  enabled: true,
  installed: true,
  status: "ready",
  isDefault: true,
  isAvailable: true,
  models: [],
  snapshot: {
    status: "ready",
    message: null,
    workspaceSnapshots: [{ cwd: "/work/app", skillsDiscovery: "machine" }],
  },
};

const MACHINES = [
  { id: "laptop", label: "Laptop", phase: "connected", status: "reachable" },
  { id: "desktop", label: "Desktop", phase: "connected", status: "reachable" },
  { id: "mini", label: "Mini", phase: "idle", status: "unreachable" },
] as const;

export const projectWorkspace = {
  skills: (query: { environmentId: string }) => ({ machine: query.environmentId }),
  skillsOutdated: () => null,
};
export function useEnvironmentQuery(atom: { machine?: string } | null) {
  const data = atom?.machine ? (SNAPSHOTS[atom.machine] ?? null) : null;
  return {
    data,
    dataUpdatedAt: 0,
    error: null,
    failure: null,
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
});
export function useEnvironment(environmentId: string | null) {
  const machine = MACHINES.find((candidate) => candidate.id === environmentId);
  return machine ? presentation(machine) : null;
}
export function useEnvironments() {
  return { environments: MACHINES.map(presentation), presentationById: new Map() };
}
export const usePrimaryEnvironmentId = () => "laptop";
export const useEnvironmentScope = () => true;
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
export function Link(props: {
  to: string;
  search?: Record<string, string>;
  children?: ReactNode;
  className?: string;
  "aria-label"?: string;
  "data-testid"?: string;
}) {
  return (
    <a
      href={`#${props.to}`}
      className={props.className}
      aria-label={props["aria-label"]}
      data-testid={props["data-testid"]}
      onClick={(event) => event.preventDefault()}
    >
      {props.children}
    </a>
  );
}

// The composer popover's other reads.
export const SkillAuthoringSheet = () => null;
export const serverEnvironment = { refreshProviders: {} };
export const useAtomCommand = () => async () => ({});
export const useSettingsProjectGroups = () => [
  {
    projectKey: "fixture-project",
    memberProjects: [
      { id: "fixture", environmentId: "laptop", physicalProjectKey: "laptop:/work/app" },
    ],
  },
];
