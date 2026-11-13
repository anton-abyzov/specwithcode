/* Synthetic threads and machine names for the restart dialog preview. Nothing is real. */
const shells = [
  [
    "thread-1",
    "env-m4",
    "Release all platforms",
    "Running bash scripts/release/release.sh ship desktop",
  ],
  [
    "thread-2",
    "env-m1",
    "Fix Windows installer signing",
    "Editing apps/desktop/electron-builder.yml",
  ],
  [
    "thread-3",
    "env-m4",
    "Model picker: provider logos",
    "Running npx vitest run src/components/chat",
  ],
  ["thread-4", "env-mini", "SpecOS nightly sync", null],
].map(([id, environmentId, title, label]) => ({
  id,
  environmentId,
  title,
  activeWork: label === null ? null : { label, startedAt: "2026-11-12T10:00:00Z" },
  source: {},
}));

export const useThreadShells = () => shells;
const names: Record<string, string> = { "env-m4": "M4", "env-m1": "M1", "env-mini": "Minis" };
export const useMachineNicknames = () => (environmentId: string) =>
  names[environmentId] ?? environmentId;
