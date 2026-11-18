import { describe, expect, it } from "@effect/vitest";

import {
  AuthFilesystemReadScope,
  AuthOrchestrationOperateScope,
  AuthSourceControlWriteScope,
} from "./auth.ts";
import { CLIENT_GUARDED_RPC_SCOPES, clientRpcRequiredScopes } from "./clientRpcPermissions.ts";
import {
  planProjectSync,
  planProjectSyncRepository,
  PROJECT_SYNC_RPC_METHODS,
  ProjectSyncAction,
  type ProjectSyncRepositoryFacts,
  projectSyncRpcs,
} from "./projectSync.ts";

const facts = (change: Partial<ProjectSyncRepositoryFacts> = {}): ProjectSyncRepositoryFacts => ({
  path: ".",
  branch: "main",
  head: "a".repeat(40),
  upstream: "origin/main",
  ahead: 0,
  behind: 0,
  uncommitted: 0,
  inUseBy: null,
  remote: "https://example.com/acme/app.git",
  fetch: "ok",
  fetchError: null,
  ...change,
});

describe("project sync scopes (1390 AC-33)", () => {
  const expected = {
    [PROJECT_SYNC_RPC_METHODS.projectSyncStatus]: AuthFilesystemReadScope,
    [PROJECT_SYNC_RPC_METHODS.projectSyncInventory]: AuthOrchestrationOperateScope,
    [PROJECT_SYNC_RPC_METHODS.projectSyncFetch]: AuthSourceControlWriteScope,
    [PROJECT_SYNC_RPC_METHODS.projectSyncRun]: AuthSourceControlWriteScope,
    [PROJECT_SYNC_RPC_METHODS.projectSyncSendExtras]: AuthSourceControlWriteScope,
  };

  it("gives each call exactly one scope from the existing set", () => {
    for (const [method, scope] of Object.entries(expected)) {
      expect(clientRpcRequiredScopes(method), method).toEqual([scope]);
      expect(CLIENT_GUARDED_RPC_SCOPES[method as keyof typeof expected]).toBe(scope);
    }
  });

  it("covers every call the contract defines, and no hand off call yet", () => {
    expect(projectSyncRpcs.map((rpc) => rpc._tag).toSorted()).toEqual(
      Object.keys(expected).toSorted(),
    );
    const guarded = Object.keys(CLIENT_GUARDED_RPC_SCOPES);
    expect(guarded.filter((method) => method.startsWith("projectSync."))).toHaveLength(5);
    expect(guarded.filter((method) => method.startsWith("handOff."))).toEqual([]);
  });

  it("keeps the calls a sync is modelled on at the scopes it copies", () => {
    expect(clientRpcRequiredScopes("handoffMode.checkpointNow")).toEqual([
      AuthSourceControlWriteScope,
    ]);
  });
});

describe("the sync plan (1390 AC-11)", () => {
  it("has exactly four actions", () => {
    expect(ProjectSyncAction.literals).toEqual(["none", "fetch", "fast-forward", "clone"]);
  });

  it("gives each state its one action", () => {
    const plan = (change: Partial<ProjectSyncRepositoryFacts>, otherBranch: string | null = "main") => {
      const step = planProjectSyncRepository(facts(change), { branch: otherBranch });
      return `${step.action}:${step.reason}`;
    };
    expect(plan({ behind: 3 })).toBe("fast-forward:behind");
    expect(plan({})).toBe("none:up-to-date");
    expect(plan({ ahead: 2 })).toBe("none:not-pushed");
    expect(plan({ ahead: 2, behind: 1 })).toBe("fetch:diverged");
    expect(plan({ behind: 1, uncommitted: 4 })).toBe("fetch:uncommitted");
    expect(plan({ behind: 1, inUseBy: "Fix login" })).toBe("fetch:in-use");
    expect(plan({ branch: "feature", behind: 1 })).toBe("fetch:other-branch");
    expect(plan({ branch: null, upstream: null })).toBe("fetch:detached");
    expect(plan({ upstream: null })).toBe("none:no-upstream");
    expect(plan({ fetch: "failed", fetchError: "no route", behind: 5 })).toBe("none:fetch-failed");
    expect(plan({ fetch: "no-remote", remote: null, upstream: null })).toBe("none:no-remote");
  });

  it("clones a repository only the other machine has, when that one names a remote", () => {
    const steps = planProjectSync(
      [facts()],
      [facts(), facts({ path: "repositories/a" }), facts({ path: "notes", remote: null })],
    );
    expect(steps.map((step) => `${step.path} ${step.action}:${step.reason}`)).toEqual([
      ". none:up-to-date",
      "repositories/a clone:missing",
      "notes none:missing-no-remote",
    ]);
  });

  it("does not hold a repository back for a branch the other machine is not on", () => {
    expect(planProjectSyncRepository(facts({ behind: 1 }), { branch: null }).action).toBe(
      "fast-forward",
    );
    expect(planProjectSyncRepository(facts({ behind: 1 }), null).action).toBe("fast-forward");
  });
});
