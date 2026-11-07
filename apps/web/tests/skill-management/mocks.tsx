let row: any;
export function setFixtureRow(value: any) {
  row = value;
}
const copies = [
  {
    id: "copy-a",
    path: "/home/demo/.claude/skills/image-workflow/SKILL.md",
    scope: "user",
    agents: [{ instanceId: "claudeAgent", label: "Claude", provider: "claudeAgent" }],
    version: "1.2.0",
    hash: "a".repeat(64),
    content:
      "---\nname: image-workflow\nmetadata:\n  version: 1.2.0\n---\n# Image workflow\n\nUse the legacy image model.\nReview the result.",
    writable: true,
  },
  {
    id: "copy-b",
    path: "/home/demo/.agents/skills/image-workflow/SKILL.md",
    scope: "user",
    agents: [
      { instanceId: "codex", label: "Codex", provider: "codex" },
      { instanceId: "gemini", label: "Gemini", provider: "acpRegistry" },
    ],
    version: "1.3.0",
    hash: "b".repeat(64),
    content:
      "---\nname: image-workflow\nmetadata:\n  version: 1.3.0\n---\n# Image workflow\n\nUse `image-v2` for product illustrations.\nReview the result.",
    writable: true,
  },
];
export const useSkillControls = () => ({
  row:
    new URLSearchParams(location.search).get("case") === "fleet"
      ? {
          ...row,
          lock: {
            skillId: "example/image-workflow",
            version: "1.3.0",
            sha: "a".repeat(64),
            lockScope: "user",
          },
        }
      : row,
  environmentId: "local",
  projectId: "demo",
  cwd: "/work/demo",
  userLevel: true,
  canWrite: true,
  canOperate: true,
  canPush: true,
  versions: { data: null },
  memberProjects: [
    { environmentId: "desktop", id: "desktop-project" },
    { environmentId: "mini", id: "mini-project" },
  ],
  setPushOpen() {},
  previews: new Map(),
});
export const useStudioFleet = () => ({
  snapshot: {
    machines:
      new URLSearchParams(location.search).get("case") === "fleet"
        ? [
            { id: "desktop", environmentId: "desktop", label: "Desktop", status: "reachable" },
            { id: "mini", environmentId: "mini", label: "Mini", status: "reachable" },
            { id: "travel", environmentId: "travel", label: "Travel", status: "offline" },
          ]
        : [],
  },
  loading: false,
  failed: false,
});
export const SkillControlsProvider = ({ children }: { children: React.ReactNode }) => children;
export const SkillActionPreviewCard = () => null;
export const useEnvironmentScope = () => true;
export const useEnvironmentQuery = () => ({
  data: null,
  error: null,
  isPending: false,
  refresh() {},
});
export const useEnvironment = () => ({ label: "Laptop", connection: { phase: "connected" } });
export const useEnvironments = () => ({ presentationById: new Map() });
export const usePrimaryEnvironmentId = () => "local";
export const useAtomCommand =
  () =>
  async ({ input }: any) =>
    input.targets
      ? {
          _tag: "Success",
          value: {
            preview: input.preview,
            results: input.targets.map((target: any) => ({
              machineId: target.machineId,
              ok: input.preview || target.machineId === "desktop",
              ...(input.preview
                ? { preview: true, expectedHash: `observed-${target.machineId}` }
                : {
                    installedVersion: target.machineId === "desktop" ? "1.3.0" : null,
                    pinnedVersion: target.machineId === "desktop" ? "1.3.0" : null,
                    message: "Permission changed. Refresh access before retrying.",
                  }),
            })),
          },
        }
      : {
          _tag: "Success",
          value: {
            _tag: input.operation === "apply" ? "applied" : input.operation,
            copies,
            ...(input.operation === "preview"
              ? {
                  sourceId: input.sourceId,
                  targetIds: input.targetIds,
                  expected: {
                    sourceHash: copies[0].hash,
                    targets: input.targetIds.map((id: string) => ({ id, hash: copies[1].hash })),
                  },
                }
              : {}),
          },
        };
export const projectWorkspace = new Proxy({}, { get: () => () => ({}) });
export * from "../provider-usability/mocks";
export const skillActionKey = JSON.stringify;
export const useEnvironmentsWithScope = () => [];
export const environmentSession = {};
export const readEnvironmentScope = () => true;
export const readPreparedConnection = () => null;
export const usePreparedConnection = () => null;
export const formatEnvironmentQueryError = String;

import { settings } from "../provider-usability/mocks";
export const usePrimarySettings = () => settings;
export const useProviderEntries = () => new Map();
export const useTraitsEffortControl = () => null;
export const useSearch = () => ({});
export const useLocation = () => ({ pathname: "/settings/skills", search: {} });
export const PRIMARY_SETTINGS_UNAVAILABLE_MESSAGE = "Fixture settings unavailable";
export const usePrimarySettingsAvailable = () => true;
export const mergeEnvironmentSettings = (local: unknown) => local;
export const persistClientSettingsPatch = () => Promise.resolve();
