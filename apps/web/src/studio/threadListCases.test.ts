import type { EnvironmentThreadShell } from "@specweave-studio/client-runtime/state/shell";
import { EnvironmentId, ProjectId } from "@specweave-studio/contracts";
import cases from "@specweave-studio/shared/threadList.cases.json";
import { describe, expect, it } from "vite-plus/test";

import { logicalProjectThreads } from "./projectDomain";
import { projectThreadGroup } from "./projectWorkspaceModel";
import { modelLabel, type ProviderNameSource } from "./shellModel";

// One project's thread list, shared with the iPhone
// (apps/ios/SWCKit/Tests/SWCFeaturesTests/ThreadListCasesTests.swift): which
// threads are listed, the group each sits in and the line under its title.

type ThreadCase = (typeof cases.threads)[number] & {
  parent?: string;
  imported?: boolean;
  settled?: boolean;
  deleted?: boolean;
  group?: string;
  label?: string;
};

const at = "2026-11-10T15:00:00.000Z";

function shell(thread: ThreadCase): EnvironmentThreadShell {
  return {
    id: thread.id,
    environmentId: cases.environmentId,
    projectId: cases.projectId,
    title: thread.title,
    createdBy: thread.createdBy,
    lineage: {
      parentThreadId: thread.parent ?? null,
      relationshipToParent: thread.parent ? "subagent" : null,
      rootThreadId: thread.parent ?? thread.id,
    },
    forkedFrom: null,
    modelSelection: { instanceId: thread.provider, model: thread.model },
    runtime: null,
    latestRun: null,
    latestUserMessageAt: null,
    hasPendingApprovals: false,
    hasPendingUserInput: false,
    hasActionableProposedPlan: false,
    pendingBackgroundTasks: [],
    historyOrigin: thread.imported ? "v1_import" : undefined,
    settledOverride: thread.settled ? "settled" : null,
    archivedAt: null,
    deletedAt: thread.deleted ? at : null,
    createdAt: at,
    updatedAt: at,
  } as unknown as EnvironmentThreadShell;
}

const providers = new Map<string, ProviderNameSource>(
  cases.providers.map((provider) => [
    provider.instanceId,
    { driverKind: provider.driver, displayName: provider.displayName, models: provider.models },
  ]),
);

describe("thread list, shared cases", () => {
  const threads: ThreadCase[] = cases.threads;
  const listed = logicalProjectThreads(
    threads.map(shell),
    [
      {
        environmentId: EnvironmentId.make(cases.environmentId),
        projectId: ProjectId.make(cases.projectId),
        coordinatorThreadId: null,
      },
    ],
    true,
  );

  it("lists the threads the iPhone lists", () => {
    expect(listed.map((thread) => thread.id).sort()).toEqual(
      threads
        .filter((thread) => thread.listed)
        .map((thread) => thread.id)
        .sort(),
    );
  });

  it.each(threads.filter((thread) => thread.listed))("groups and labels $name", (thread) => {
    const row = listed.find((candidate) => candidate.id === thread.id);
    expect(row).toBeDefined();
    expect(projectThreadGroup(row!)).toBe(thread.group);
    expect(
      modelLabel(providers.get(thread.provider) ?? null, thread.provider, thread.model).full,
    ).toBe(thread.label);
  });
});
