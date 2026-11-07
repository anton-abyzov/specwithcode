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
  row,
  environmentId: "local",
  projectId: "demo",
  cwd: "/work/demo",
  userLevel: true,
  canWrite: true,
  canOperate: true,
  canPush: true,
  memberProjects: [],
  setPushOpen() {},
  previews: new Map(),
});
export const useStudioFleet = () => ({ snapshot: { machines: [] }, loading: false, failed: false });
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
  async ({ input }: any) => ({
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
  });
export const projectWorkspace = new Proxy({}, { get: () => () => ({}) });
export * from "../provider-usability/mocks";
export const skillActionKey = JSON.stringify;
export const useEnvironmentsWithScope = () => [];
export const environmentSession = {};
export const readEnvironmentScope = () => true;
export const readPreparedConnection = () => null;
export const usePreparedConnection = () => null;
export const formatEnvironmentQueryError = String;
