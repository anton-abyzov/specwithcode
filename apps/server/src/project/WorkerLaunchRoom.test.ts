import { expect, it } from "@effect/vitest";
import {
  DEFAULT_PROJECT_WORKSPACE_SETTINGS,
  type Project,
  ProjectId,
  ProviderDriverKind,
  ProviderInstanceId,
  type ServerProvider,
} from "@specweave-studio/contracts";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";

import { ProviderFallbackEnv } from "../orchestration-v2/ProviderFallbackWorker.ts";
import { workerLaunchWithRoom } from "./WorkerLaunchRoom.ts";

const nowIso = DateTime.formatIso(DateTime.makeUnsafe("2026-10-24T12:00:00.000Z"));
const provider = (id: string, driver: string): ServerProvider => ({
  instanceId: ProviderInstanceId.make(id),
  driver: ProviderDriverKind.make(driver),
  enabled: true,
  installed: true,
  status: "ready",
  auth: { status: "authenticated" },
  checkedAt: nowIso,
  version: null,
  models: [{ slug: `${driver}-default`, name: "Default", isCustom: false, capabilities: null }],
  slashCommands: [],
  skills: [],
  usageLimits: {
    checkedAt: nowIso,
    windows: [{ id: "five_hour", kind: "session", label: "Session", usedPercent: 40 }],
  },
});

const preferred = { instanceId: ProviderInstanceId.make("claude"), model: "claudeAgent-default" };
const coordinator = { instanceId: ProviderInstanceId.make("codex"), model: "codex-default" };
const project: Project = {
  id: ProjectId.make("project:worker-launch"),
  title: "Project",
  workspaceRoot: "/tmp/worker-launch",
  repositoryIdentity: null,
  defaultModelSelection: preferred,
  defaultThreadEnvMode: null,
  autoPull: false,
  projectIcon: null,
  faviconPath: null,
  scripts: [],
  createdAt: "2026-10-24T00:00:00Z",
  updatedAt: "2026-10-24T00:00:00Z",
  deletedAt: null,
  workspaceSettings: { ...DEFAULT_PROJECT_WORKSPACE_SETTINGS },
};
const launch = (env: Record<string, string>) =>
  workerLaunchWithRoom({
    project,
    preferred,
    coordinator,
    providers: [provider("claude", "claudeAgent"), provider("codex", "codex")],
    runtimePolicy: { runtimeMode: "full-access", interactionMode: "default" },
  }).pipe(Effect.provideService(ProviderFallbackEnv, env));

it.effect("names no stand-in while the worker model has room", () =>
  Effect.gen(function* () {
    expect(yield* launch({})).toEqual({ selection: preferred, fallbackFrom: null });
  }),
);

it.effect("returns the worker model a launch with no room moved off", () =>
  Effect.gen(function* () {
    expect(yield* launch({ STUDIO_SIMULATE_USAGE_LIMIT: "claude" })).toEqual({
      selection: coordinator,
      fallbackFrom: preferred,
    });
  }),
);
