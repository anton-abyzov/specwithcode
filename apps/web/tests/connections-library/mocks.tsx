import { useSyncExternalStore, type ReactNode } from "react";
import {
  EnvironmentId,
  ProjectId,
  type NativeConnectionsSnapshot,
} from "@specweave-studio/contracts";
let mode = "ready";
let project = false;
const listeners = new Set<() => void>();
export const requests: string[] = [];
export function setFixture(next: string) {
  mode = next;
  for (const notify of listeners) notify();
}
export function setProject(next: boolean) {
  project = next;
  for (const notify of listeners) notify();
}
function useFixture() {
  return useSyncExternalStore(
    (callback) => {
      listeners.add(callback);
      return () => {
        listeners.delete(callback);
      };
    },
    () => `${mode}:${project}`,
  );
}
const environments = ["mac", "remote"].map((id) => ({
  environmentId: EnvironmentId.make(id),
  label: `${id === "mac" ? "Mac" : "Remote"} fixture`,
}));
export function useSettingsScope() {
  useFixture();
  return {
    scope: project
      ? {
          kind: "project",
          members: environments.map((e) => ({
            id: ProjectId.make(`project-${e.environmentId}`),
            environmentId: e.environmentId,
            workspaceRoot: `/fixture/${e.environmentId}`,
          })),
        }
      : { kind: "all" },
    search: project ? { project: "fixture-project" } : {},
    environments,
  };
}
export function useEnvironments() {
  useFixture();
  return {
    environments: environments.map((e) => ({
      environmentId: e.environmentId,
      entry: null,
      connection: { phase: mode === "offline" ? "offline" : "connected" },
    })),
  };
}
export function useEnvironment() {
  useFixture();
  return { connection: { phase: mode === "offline" ? "offline" : "connected" } };
}
export function useEnvironmentScope() {
  useFixture();
  return mode !== "denied";
}
export const projectWorkspace = {
  nativeConnections: (request: unknown) => request,
  nativeConnectionApply: "nativeConnectionApply",
};
/** The fixture never writes: every command reports the machine as unavailable. */
export function useAtomCommand() {
  return async () => ({ _tag: "Failure" as const, cause: new Error("Fixture is read-only") });
}
/** Claude Code local-scope entries outside project context, as Settings lists them. */
const folderEntry = (name: string, folder: string, transport: "http" | "stdio") => ({
  id: `claude:claude-all-projects:${name}:${folder}`,
  name,
  provider: "claude" as const,
  sourceId: "claude-all-projects",
  scope: "local" as const,
  transport,
  state: "configured" as const,
  shadowed: false,
  project: folder,
});
const folderEntries: NativeConnectionsSnapshot["connections"] = [
  {
    id: "codex-user:posthog",
    name: "PostHog",
    provider: "codex",
    sourceId: "codex-user",
    scope: "user",
    transport: "http",
    state: "configured",
    shadowed: false,
  },
  folderEntry("design-mcp", "sample-portal", "http"),
  folderEntry("browser-mcp", "sample-portal", "stdio"),
  folderEntry("browser-mcp", "demo-site", "stdio"),
  folderEntry("browser-mcp", "notes-app", "stdio"),
  folderEntry("scheduler", "travel-demo", "http"),
];
/** A wide machine: many servers across Codex, Claude Code and four other tools. */
const gridNames = [
  "pencil",
  "blender",
  "posthog",
  "rea",
  "supermetrics",
  "excalidraw",
  "higgsfield",
  "n8n-mcp",
  "node_repl",
  "playwright",
  "context7",
  "sentry",
];
type GridState = "configured" | "disabled" | "invalid" | null;
const gridCodex: GridState[] = [
  "configured",
  "configured",
  "configured",
  null,
  "configured",
  "disabled",
  null,
  "configured",
  "configured",
  null,
  "configured",
  "invalid",
];
const gridClaude: GridState[] = [
  "configured",
  "configured",
  "configured",
  "configured",
  "configured",
  "configured",
  "configured",
  null,
  null,
  "configured",
  "disabled",
  null,
];
const gridOther: Record<string, GridState[]> = {
  "claude-desktop": [
    "configured",
    null,
    null,
    null,
    null,
    "configured",
    null,
    null,
    null,
    null,
    null,
    null,
  ],
  gemini: [
    "configured",
    null,
    "disabled",
    null,
    null,
    null,
    null,
    null,
    null,
    "configured",
    null,
    null,
  ],
  cursor: [
    "configured",
    "configured",
    null,
    null,
    null,
    null,
    null,
    null,
    null,
    "configured",
    "configured",
    null,
  ],
  opencode: [null, null, null, null, null, null, null, "configured", null, null, null, null],
};
const gridEntries = (provider: "codex" | "claude", states: GridState[]) =>
  gridNames.flatMap((name, index) => {
    const state = states[index];
    if (!state) return [];
    return [
      {
        id: `${provider}-user:${name}`,
        name,
        provider,
        sourceId: `${provider}-user`,
        scope: "user" as const,
        transport: index % 3 === 0 ? ("stdio" as const) : ("http" as const),
        state,
        shadowed: false,
        portable: name !== "node_repl",
        ...(provider === "claude" && state === "disabled" ? { parked: true } : {}),
      },
    ];
  });
const gridSnapshot: NativeConnectionsSnapshot = {
  observedAt: "2026-10-14T12:00:00Z",
  runtime: "unverified",
  truncated: false,
  sources: [
    { id: "codex-user", provider: "codex", scope: "user", status: "read" },
    { id: "claude-user", provider: "claude", scope: "user", status: "read" },
  ],
  connections: [...gridEntries("codex", gridCodex), ...gridEntries("claude", gridClaude)],
  otherTools: Object.entries(gridOther).map(([tool, states]) => ({
    tool: tool as "claude-desktop" | "gemini" | "cursor" | "opencode",
    status: "read" as const,
    connections: gridNames.flatMap((name, index) => {
      const state = states[index];
      return state && state !== "invalid"
        ? [{ id: `${tool}:${name}`, name, transport: "stdio" as const, state }]
        : [];
    }),
  })),
};
export function useEnvironmentQuery(
  atom: { environmentId: string; input: { projectId?: string } } | null,
) {
  useFixture();
  if (atom) requests.push(`${atom.environmentId}:${atom.input.projectId ?? "user"}`);
  const provider = atom?.environmentId === "remote" ? "claude" : "codex";
  const scope = atom?.input.projectId ? "project" : "user";
  const sourceId = `${provider}-${scope}`;
  const snapshot: NativeConnectionsSnapshot =
    mode === "grid"
      ? gridSnapshot
      : {
          observedAt: "2026-10-14T12:00:00Z",
          runtime: "unverified",
          truncated: false,
          sources: [
            { id: sourceId, provider, scope, status: mode === "invalid" ? "invalid" : "read" },
          ],
          connections:
            mode === "empty" || mode === "invalid"
              ? []
              : mode === "folders"
                ? folderEntries
                : [
                    {
                      id: sourceId,
                      name: provider === "claude" ? "Remote analytics" : "PostHog",
                      provider,
                      scope,
                      sourceId,
                      transport: "http",
                      state: scope === "project" ? "disabled" : "configured",
                      shadowed: false,
                    },
                  ],
        };
  return {
    data: mode === "loading" ? null : snapshot,
    error: mode === "error" ? "Discovery unavailable" : null,
    isPending: mode === "loading",
    refresh: () => setFixture("ready"),
  };
}
export function SettingsPageContainer({ children }: { children: ReactNode }) {
  return <main className="mx-auto max-w-4xl p-4">{children}</main>;
}
export function SettingsSection({
  title,
  headerAction,
  children,
}: {
  title: string;
  headerAction?: ReactNode;
  children: ReactNode;
}) {
  return (
    <section className="space-y-5 rounded-xl border border-border bg-background p-4">
      <div className="flex items-center justify-between gap-2">
        <h1 className="text-xl font-medium">{title}</h1>
        {headerAction}
      </div>
      {children}
    </section>
  );
}
