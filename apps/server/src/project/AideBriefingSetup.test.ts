import { describe, expect, it } from "@effect/vitest";
import { DEFAULT_SERVER_SETTINGS, type ModelSelection } from "@specweave-studio/contracts";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";

import * as Google from "../integrations/google/GoogleAccountService.ts";
import * as ProjectStore from "../orchestration-v2/ProjectStore.ts";
import { ScheduledTaskService } from "../scheduledTasks/ScheduledTaskService.ts";
import * as ServerSettings from "../serverSettings.ts";
import { type BriefingSetupInput, briefingSetupStep, runOnce } from "./AideBriefingSetup.ts";

const MODEL = { instanceId: "claudeAgent", model: "claude-opus-5-5" } as ModelSelection;
const aide = {
  projectId: "aide",
  createdAt: "2026-10-10T00:00:00.000Z",
  deletedAt: null,
  defaultModelSelection: MODEL,
  workspaceSettings: { kind: "personal" },
};
const code = { ...aide, projectId: "code", workspaceSettings: { kind: "code" } };

const base: BriefingSetupInput = {
  aideEnabled: true,
  projects: [code, aide],
  google: {
    email: "me@example.com",
    services: ["gmail", "calendar", "gmailDrafts"],
    projects: [{ projectId: "aide", services: ["gmail", "calendar", "gmailDrafts"] }],
    briefingSetUp: [],
  },
  tasks: [],
};

describe("briefingSetupStep", () => {
  it("sets up the briefing for the machine's assistant once it may read mail", () => {
    expect(briefingSetupStep(base)).toEqual({ kind: "create", projectId: "aide", model: MODEL });
    // Calendar alone is enough for a briefing.
    expect(
      briefingSetupStep({
        ...base,
        google: { ...base.google, projects: [{ projectId: "aide", services: ["calendar"] }] },
      }),
    ).toMatchObject({ kind: "create" });
  });

  it("only remembers a briefing the person already has", () => {
    expect(
      briefingSetupStep({
        ...base,
        tasks: [{ projectId: "aide", title: "Morning mail", prompt: "/proactive-briefing short" }],
      }),
    ).toEqual({ kind: "mark", projectId: "aide" });
  });

  it.each<[string, Partial<BriefingSetupInput>]>([
    ["Aide is off", { aideEnabled: false }],
    ["no account is connected", { google: { ...base.google, email: null } }],
    [
      "it was set up before for this account",
      {
        google: { ...base.google, briefingSetUp: ["aide"] },
      },
    ],
    [
      "the assistant may read only Drive",
      {
        google: { ...base.google, projects: [{ projectId: "aide", services: ["drive"] }] },
      },
    ],
    [
      "Google did not grant what the switch names",
      {
        google: { ...base.google, services: ["drive"] },
      },
    ],
    [
      "only a code project may read mail",
      {
        google: { ...base.google, projects: [{ projectId: "code", services: ["gmail"] }] },
      },
    ],
    ["there is no assistant", { projects: [code] }],
    [
      "the assistant is archived",
      {
        projects: [{ ...aide, workspaceSettings: { kind: "personal", archived: true } }],
      },
    ],
    ["the assistant has no model yet", { projects: [{ ...aide, defaultModelSelection: null }] }],
  ])("does nothing when %s", (_name, change) => {
    expect(briefingSetupStep({ ...base, ...change })).toBeNull();
  });
});

const harness = (tasks: BriefingSetupInput["tasks"], briefingSetUp: string[] = []) => {
  const upserts: unknown[] = [];
  const marked: string[] = [];
  const layer = Layer.mergeAll(
    Layer.mock(ServerSettings.ServerSettingsService)({
      getSettings: Effect.succeed({ ...DEFAULT_SERVER_SETTINGS, aideEnabled: true }),
    }),
    Layer.mock(Google.GoogleAccountService)({
      briefingState: Effect.sync(() => ({
        ...base.google,
        briefingSetUp: [...briefingSetUp, ...marked],
      })) as never,
      markBriefingSetUp: (projectId) => Effect.sync(() => void marked.push(projectId)),
    }),
    Layer.mock(ProjectStore.ProjectStoreV2)({
      list: () => Effect.succeed([code, aide] as never),
    }),
    Layer.mock(ScheduledTaskService)({
      list: () => Effect.succeed({ tasks } as never),
      upsert: (input) =>
        Effect.sync(() => {
          upserts.push(input);
          return { task: {} } as never;
        }),
    }),
  );
  return { upserts, marked, layer };
};

it.effect("creates one daily 08:00 briefing in its own thread, then never again", () => {
  const h = harness([]);
  return Effect.gen(function* () {
    yield* runOnce;
    yield* runOnce;
    expect(h.upserts).toEqual([
      expect.objectContaining({
        commandId: "aide-briefing:aide",
        title: "Proactive briefing",
        prompt: "/proactive-briefing",
        enabled: true,
        schedule: { type: "fixed_time", timeOfDay: "08:00" },
        projectId: "aide",
        ownThread: true,
        modelSelection: MODEL,
      }),
    ]);
    expect(h.marked).toEqual(["aide"]);
  }).pipe(Effect.provide(h.layer));
});

it.effect("leaves a briefing the person deleted deleted", () => {
  const h = harness([], ["aide"]);
  return Effect.gen(function* () {
    yield* runOnce;
    expect(h.upserts).toEqual([]);
  }).pipe(Effect.provide(h.layer));
});
