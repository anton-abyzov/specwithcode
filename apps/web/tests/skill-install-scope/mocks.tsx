// Stand-ins for the stores the install chooser and search read: one machine
// (Studio Mac) with a project "atlas", fictional settings and a connected repo.
import { useState } from "react";

const params = new URLSearchParams(location.search);
export const ENVIRONMENT_ID = "env-m5";
const settings = {
  skillInstallScope: (params.get("machineDefault") ?? "project") as "user" | "project",
  projectSettingsOverrides: params.get("projectOwn")
    ? { "project-first": { skillInstallScope: params.get("projectOwn") } }
    : {},
};
const config = {
  settings,
  environment: {
    capabilities: {
      skillInstallScope: params.get("older") !== "1",
      projectSettingsOverrideChanges: true,
    },
  },
};

declare global {
  interface Window {
    fixtureCalls: unknown[];
  }
}
window.fixtureCalls = [];

// @effect/atom-react: the fixture's "atoms" are their own values.
export const useAtomValue = <T,>(atom: T): T => atom;

// state/server
export const serverEnvironment = {
  configValueAtom: () => config,
  refreshProviders: { fn: async () => ({ _tag: "Success", value: {} }) },
};

// state/entities
export const useProject = () => ({
  id: "project-first",
  workspaceRoot: "/home/you/projects/atlas",
  workspaceSettings: { kind: params.get("percy") === "1" ? "personal" : "work" },
});

// state/session
export const useEnvironmentScope = () => true;

// hooks/useSettings
export const useUpdateEnvironmentSettings = () => (patch: unknown) => {
  window.fixtureCalls.push({ settings: patch });
};

// studio/machineNickname
export const useMachineNickname = () => "Studio Mac";

const available = {
  repo: "anton-abyzov/vskill",
  visibility: "public",
  skill: {
    name: "obsidian-brain",
    path: "plugins/personal/skills/obsidian-brain/SKILL.md",
    plugin: "personal",
    version: "1.0.12",
    description:
      "Autonomous Obsidian vault management using the PARA + LLM Wiki pattern. Three operations: ingest, query, lint.",
    commit: "9f8b96610efc9a6af1477456188fb8d114899ccd",
    contentHash: "a".repeat(64),
  },
};

// studio/projectWorkspace and state/use-atom-command: commands are plain functions.
export const projectWorkspace = {
  skillsSearch: {
    fn: async ({ input }: { input: { query: string } }) => ({
      _tag: "Success",
      value: {
        query: input.query,
        installed: [],
        available: [available],
        notes: [],
        notesState: "none",
      },
    }),
  },
  skillsUpdate: {
    fn: (request: { input: { install?: { scope?: string } } }) => {
      window.fixtureCalls.push({ update: request.input });
      // ?hold=1 keeps the run going, to show the progress line.
      if (params.get("hold") === "1") return new Promise(() => {});
      const scope = request.input.install?.scope;
      return Promise.resolve({
        _tag: "Success",
        value: {
          checkedAt: "2026-11-28T08:22:21.000Z",
          statuses: [],
          outcomes: [
            {
              skill: "obsidian-brain",
              outcome: "installed",
              before: null,
              after: {
                version: "1.0.12",
                commit: available.skill.commit,
                contentHash: "a".repeat(64),
              },
              readiness: [
                {
                  instanceId: "claudeAgent",
                  driver: "claudeAgent",
                  label: "Claude",
                  readiness: "next-session",
                  detail: "",
                },
                {
                  instanceId: "codex",
                  driver: "codex",
                  label: "Codex",
                  readiness: "loaded-now",
                  detail: "",
                },
              ],
              ...(scope ? { scope } : {}),
            },
          ],
        },
      });
    },
  },
};
export const useAtomCommand = (atom: { fn: unknown }) => atom.fn;

// components/skills/SkillRollout: "Also add on" is its own fixture.
export const SkillRolloutAfter = () => null;

export function useFixtureState<T>(value: T) {
  return useState(value);
}
