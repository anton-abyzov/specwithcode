import { describe, expect, it } from "vite-plus/test";
import { DEFAULT_PROJECT_WORKSPACE_SETTINGS } from "@specweave-studio/contracts";
import { provider } from "../studio/fixtures.ts";
import {
  isProjectModelSelectionCompatible,
  projectCompatibleProviders,
  projectNeedsAdditionalDirectoryGrants,
} from "./ProjectProviderCompatibility.ts";

const providers = [
  provider("copilot", "acpRegistry"),
  provider("codex", "codex"),
  provider("claude", "claudeAgent"),
  provider("muse", "muse"),
];
const project = {
  workspaceRoot: "/project",
  workspaceSettings: {
    ...DEFAULT_PROJECT_WORKSPACE_SETTINGS,
    environment: { additionalFolders: ["/approved"], repositories: [] },
  },
};

describe("project provider folder compatibility", () => {
  it("retains installed full-access ACP and filters every restricted policy", () => {
    const full = { runtimeMode: "full-access", interactionMode: "default" };
    expect(projectCompatibleProviders({ project, providers, runtimePolicy: full })).toEqual(
      providers,
    );
    for (const runtimePolicy of [
      { ...full, runtimeMode: "approval-required" },
      { ...full, interactionMode: "plan" },
      { ...full, approvalPolicy: "on-request" },
      { ...full, sandboxPolicy: { type: "externalSandbox" } },
      { ...full, sandboxPolicy: { type: "readOnly" } },
    ])
      expect(projectCompatibleProviders({ project, providers, runtimePolicy })).toEqual([
        providers[1],
        providers[2],
        providers[3],
      ]);
    expect(
      projectCompatibleProviders({
        project,
        runtimePolicy: full,
        providers: [
          { ...providers[0]!, supportedRuntimeModes: ["approval-required"] },
          providers[1]!,
        ],
      }),
    ).toEqual([providers[1]]);
  });
  it("filters automatic routes while leaving provider readiness and usage data intact", () => {
    const compatible = projectCompatibleProviders({ project, providers });
    expect(compatible).toEqual([providers[1], providers[2], providers[3]]);
    expect(compatible[0]).toBe(providers[1]);
    expect(
      isProjectModelSelectionCompatible({
        project,
        providers,
        selection: { instanceId: providers[0]!.instanceId, model: "opus" },
      }),
    ).toBe(false);
    expect(
      isProjectModelSelectionCompatible({
        project,
        providers: [],
        selection: { instanceId: providers[1]!.instanceId, model: "model" },
      }),
    ).toBe(false);
  });

  it("preserves empty legacy environments even when a thread uses another checkout", () => {
    const legacy = { ...project, workspaceSettings: DEFAULT_PROJECT_WORKSPACE_SETTINGS };
    expect(projectNeedsAdditionalDirectoryGrants(legacy, "/worktree")).toBe(false);
    expect(projectCompatibleProviders({ project: legacy, cwd: "/worktree", providers })).toBe(
      providers,
    );
    expect(projectCompatibleProviders({ project: undefined, providers })).toBe(providers);
  });

  it("requires the project root beside a worktree only for a configured environment", () => {
    const configured = {
      ...project,
      workspaceSettings: {
        ...DEFAULT_PROJECT_WORKSPACE_SETTINGS,
        environment: {
          additionalFolders: [],
          repositories: [
            { id: "code", url: "https://github.com/example/code", localPath: "/project/code" },
          ],
        },
      },
    };
    expect(projectCompatibleProviders({ project: configured, cwd: "/project", providers })).toBe(
      providers,
    );
    expect(
      projectCompatibleProviders({ project: configured, cwd: "/worktree", providers }),
    ).toEqual([providers[1], providers[2], providers[3]]);
  });
});
