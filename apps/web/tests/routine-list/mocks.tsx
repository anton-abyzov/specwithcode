/* The project-workspace host, plus two machines with routines in several states and a fixed
   settings scope. Routines are fictional; actions are recorded in window.__projectCalls. */
import { Atom } from "effect/reactivity";
import * as Base from "../project-workspace/mocks";

export * from "../project-workspace/mocks";

const base = { createdBy: "user", creationSource: "web", interactionMode: "default" };
const runtime = { runtimeMode: "full-access", workspaceStrategy: { type: "root" } };
const at = (offsetHours: number) => new Date(Date.now() + offsetHours * 3_600_000).toISOString();
const routine = (fields: Record<string, unknown>) => ({
  ...base,
  ...runtime,
  enabled: true,
  threadId: null,
  ownThread: true,
  nextRunAt: null,
  lastRunAt: null,
  lastRunStatus: "never",
  lastRunError: null,
  runCount: 0,
  createdAt: "2026-10-01T00:00:00.000Z",
  updatedAt: "2026-10-01T00:00:00.000Z",
  ...fields,
});
const daily = { type: "fixed_time", timeOfDay: "09:00", weekdays: [1, 2, 3, 4, 5] };
const claude = { instanceId: "claudeAgent", model: "claude-opus" };
const codex = { instanceId: "codex", model: "gpt-5.4" };

const routinesByMachine: Record<string, unknown[]> = {
  "environment-local": [
    routine({
      id: "sentry",
      title: "Check Sentry issues",
      prompt: "Review new Sentry issues and open a thread for anything that needs a fix.",
      projectId: "atlas",
      schedule: daily,
      modelSelection: claude,
      nextRunAt: at(3),
      lastRunAt: at(-21),
      lastRunStatus: "succeeded",
    }),
    routine({
      id: "deps",
      title: "Dependency updates",
      prompt: "Open one pull request with safe dependency updates.",
      projectId: "atlas",
      schedule: { type: "interval", everyMs: 6 * 3_600_000 },
      modelSelection: codex,
      modelPinned: true,
      lastRunAt: at(-2),
      lastRunStatus: "failed",
      lastRunError: "Codex ran out of usage before the run finished.",
      nextRunAt: at(4),
    }),
    routine({
      id: "standup",
      title: "Standup notes",
      prompt: "Summarize yesterday's merged pull requests.",
      projectId: "beacon",
      schedule: daily,
      modelSelection: claude,
      enabled: false,
    }),
    routine({
      id: "launch",
      title: "Launch day checklist",
      prompt: "Walk the launch checklist and report anything still open.",
      projectId: "beacon",
      schedule: { type: "once", at: at(-30) },
      modelSelection: claude,
      enabled: false,
      lastRunAt: at(-30),
      lastRunStatus: "succeeded",
      runCount: 1,
    }),
    routine({
      id: "export-once",
      title: "Quarterly export",
      prompt: "Export the quarter's invoices to the shared folder.",
      projectId: "beacon",
      schedule: { type: "once", at: at(-5) },
      modelSelection: claude,
      enabled: false,
      lastRunAt: at(-5),
      lastRunStatus: "failed",
      lastRunError: "The shared folder was not mounted. Turned off; turn it on to try again.",
      runCount: 1,
    }),
    routine({
      id: "release-notes",
      title: "Release notes draft",
      prompt: "Draft release notes from the merged pull requests.",
      projectId: "atlas",
      schedule: { type: "manual" },
      modelSelection: codex,
    }),
  ],
  "environment-remote": [
    routine({
      id: "nightly",
      title: "Nightly build",
      prompt: "Build the desktop app and report failures.",
      projectId: "atlas-linux",
      schedule: daily,
      modelSelection: codex,
      nextRunAt: at(10),
    }),
    routine({
      id: "migration",
      title: "One-time data check",
      prompt: "Confirm last week's migration left no orphaned rows.",
      projectId: "atlas-linux",
      schedule: { type: "once", at: at(-60) },
      modelSelection: claude,
      enabled: false,
      lastRunAt: at(-60),
      lastRunStatus: "succeeded",
      runCount: 1,
    }),
  ],
};

const config = (machine: string) => ({ environment: { platform: { machine } }, settings: {} });
export const fixtureEnvironments = [
  {
    environmentId: "environment-local",
    label: "Development Mac",
    connection: { phase: "connected" },
    serverConfig: config("laptop"),
  },
  {
    environmentId: "environment-remote",
    label: "Build server",
    connection: { phase: "connected" },
    serverConfig: config("server"),
  },
];

const projects = [
  { id: "atlas", environmentId: "environment-local", title: "Atlas Studio" },
  { id: "beacon", environmentId: "environment-local", title: "Beacon" },
  { id: "atlas-linux", environmentId: "environment-remote", title: "Atlas Studio" },
];
export const useProjects = () => projects;

export const serverEnvironment = new Proxy(Base.serverEnvironment, {
  get(target, key) {
    if (key === "scheduledTasksLive")
      return ({ environmentId }: { environmentId: string }) => ({
        kind: "routines",
        environmentId,
      });
    if (key === "providersValueAtom") return () => noProviders;
    if (key === "deleteScheduledTask") return "routineDelete";
    if (key === "upsertScheduledTask")
      return Object.assign(() => ({ kind: "routineSave" }), { permissionAtom: () => allowed });
    return Reflect.get(target, key);
  },
});
const noProviders = Atom.make([]);
const allowed = Atom.make(true);

// One result object per machine, as a live query keeps its value between renders.
const routineResults = new Map(
  Object.entries(routinesByMachine).map(([environmentId, tasks]) => [
    environmentId,
    { data: { tasks }, error: null, refresh: () => {}, isPending: false },
  ]),
);
export const useEnvironmentQuery = (query: { kind?: string; environmentId?: string } | null) =>
  query?.kind === "routines" && query.environmentId
    ? routineResults.get(query.environmentId)
    : Base.useEnvironmentQuery(query as never);

const scope = {
  kind: "all",
  label: "All machines",
  members: [],
  environmentIds: fixtureEnvironments.map((environment) => environment.environmentId),
};
export const useSettingsScope = () => ({
  scope,
  environments: fixtureEnvironments,
  connectedEnvironments: fixtureEnvironments,
  environment: fixtureEnvironments[0],
});
// Rows read the scope optionally; without a provider they act as in the other fixtures.
export const useOptionalSettingsScope = () => null;
export const SettingsScopeProvider = ({ children }: { children: unknown }) => children;
