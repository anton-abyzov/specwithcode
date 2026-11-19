import type {
  EnvironmentId,
  HandoffModeSnapshot,
  HandoffThreadState,
  ProjectId,
  ThreadId,
} from "@specweave-studio/contracts";
import type { EnvironmentThreadShell } from "@specweave-studio/client-runtime/state/shell";
import { describe, expect, it } from "vite-plus/test";

import {
  handoffMachineRows,
  tickableHandoffRows,
  type HandoffMachineProject,
  type HandoffMachineRowFacts,
} from "./handOffMachineRows";

const HERE = "env-laptop" as EnvironmentId;
const DESK = "env-desk" as EnvironmentId;
const ATLAS = "project-atlas" as ProjectId;
const OTHER = "project-other" as ProjectId;
const ASSISTANT = "project-assistant" as ProjectId;

const shell = (id: string, patch: Partial<EnvironmentThreadShell> = {}) =>
  ({
    environmentId: HERE,
    id: id as ThreadId,
    projectId: ATLAS,
    title: id,
    lineage: { parentThreadId: null, relationshipToParent: null },
    runtime: null,
    archivedAt: null,
    settledOverride: null,
    settledAt: null,
    hasPendingApprovals: false,
    hasPendingUserInput: false,
    heldQueuedCount: 0,
    updatedAt: "2026-11-19T10:00:00.000Z",
    ...patch,
  }) as unknown as EnvironmentThreadShell;

const running = { status: "running", activeRunId: "run-1" } as EnvironmentThreadShell["runtime"];

const state = (threadId: string, patch: Partial<HandoffThreadState> = {}) =>
  ({
    threadId: threadId as ThreadId,
    projectId: ATLAS,
    mode: "inherit",
    effectiveMode: "on",
    badge: null,
    checkpoint: null,
    replicas: [],
    lease: null,
    continuedOn: null,
    fencedBranch: null,
    lastError: null,
    ...patch,
  }) as HandoffThreadState;

const snapshot = (threads: HandoffThreadState[]) =>
  ({ environmentId: HERE, threads }) as unknown as HandoffModeSnapshot;

const projects: HandoffMachineProject[] = [
  { id: ATLAS, environmentId: HERE, workspaceSettings: { coordinatorThreadId: "coord-atlas" } },
  { id: OTHER, environmentId: HERE },
  { id: ASSISTANT, environmentId: HERE, workspaceSettings: { kind: "personal" } },
];

const facts = (patch: Partial<HandoffMachineRowFacts>): HandoffMachineRowFacts => ({
  environmentId: HERE,
  shells: [],
  snapshot: snapshot([]),
  projects,
  projectId: null,
  ...patch,
});

describe("handoffMachineRows (AC-17)", () => {
  it("lists an idle thread waiting for its next message, so it can arrive Ready", () => {
    // Handoff mode is off for it, so the snapshot does not list it, and nothing runs.
    const rows = handoffMachineRows(
      facts({ shells: [shell("t-idle", { title: "Plan the release" })], projectId: ATLAS }),
    );
    expect(rows).toEqual([{ threadId: "t-idle", title: "Plan the release", group: "waiting" }]);
  });

  it("puts a running thread in Running and a waiting one after it", () => {
    const rows = handoffMachineRows(
      facts({
        shells: [shell("t-idle"), shell("t-run", { runtime: running })],
        snapshot: snapshot([state("t-run")]),
      }),
    );
    expect(rows.map((row) => [row.threadId, row.group])).toEqual([
      ["t-run", "running"],
      ["t-idle", "waiting"],
    ]);
  });

  it("lists a thread someone marked active again although it settled once", () => {
    const rows = handoffMachineRows(
      facts({
        shells: [
          shell("t-back", { settledAt: "2026-11-18T10:00:00.000Z", settledOverride: "active" }),
        ],
      }),
    );
    expect(rows.map((row) => row.group)).toEqual(["waiting"]);
  });

  it("leaves out what is not this machine's to move or never moves as a thread", () => {
    const rows = handoffMachineRows(
      facts({
        shells: [
          shell("t-settled", { settledAt: "2026-11-18T10:00:00.000Z" }),
          shell("t-settled-by-hand", { settledOverride: "settled" }),
          shell("t-archived", { archivedAt: "2026-11-18T10:00:00.000Z" }),
          shell("t-subagent", {
            lineage: { parentThreadId: "t-run", relationshipToParent: "subagent" },
          } as Partial<EnvironmentThreadShell>),
          shell("coord-atlas"),
          shell(`project-coordinator:${OTHER}`, { projectId: OTHER }),
          shell("t-on-desk", { executionMachineId: DESK }),
          shell("t-continued"),
          shell("t-fenced"),
          shell("t-other-machine", { environmentId: DESK }),
        ],
        snapshot: snapshot([
          state("t-continued", {
            continuedOn: {
              environmentId: DESK,
              machineLabel: "Desk",
              threadId: "t-continued" as ThreadId,
              at: "2026-11-19T09:00:00.000Z",
            },
          } as Partial<HandoffThreadState>),
          state("t-fenced", { lease: { state: "fenced" } } as Partial<HandoffThreadState>),
        ]),
      }),
    );
    expect(rows).toEqual([]);
  });

  it("keeps the project scope", () => {
    const rows = handoffMachineRows(
      facts({
        shells: [shell("t-atlas"), shell("t-other", { projectId: OTHER })],
        projectId: OTHER,
      }),
    );
    expect(rows.map((row) => row.threadId)).toEqual(["t-other"]);
  });

  it("shows what cannot go under Stays, with its reason", () => {
    const rows = handoffMachineRows(
      facts({
        shells: [
          shell("t-question", { hasPendingUserInput: true }),
          shell("t-approval", { runtime: running, hasPendingApprovals: true }),
          shell("t-assistant", { projectId: ASSISTANT }),
          shell("t-queue", { heldQueuedCount: 2 }),
        ],
      }),
    );
    expect(rows.map((row) => [row.threadId, row.group, row.reason])).toEqual([
      ["t-question", "stays", "Answer it first"],
      ["t-approval", "stays", "Answer it first"],
      ["t-assistant", "stays", "The personal assistant stays on this machine."],
      ["t-queue", "stays", "Its queued messages do not travel in a hand off by hand yet."],
    ]);
  });

  it("ticks every row that can go and none that stays", () => {
    const rows = handoffMachineRows(
      facts({
        shells: [
          shell("t-run", { runtime: running }),
          shell("t-idle"),
          shell("t-question", { hasPendingUserInput: true }),
        ],
      }),
    );
    expect([...tickableHandoffRows(rows)]).toEqual(["t-run", "t-idle"]);
  });
});
