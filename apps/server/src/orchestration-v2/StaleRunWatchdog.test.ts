import { assert, it } from "@effect/vitest";
import type { OrchestrationV2ThreadProjection } from "@specweave-studio/contracts";
import * as DateTime from "effect/DateTime";

import { staleFinishedRun } from "./StaleRunWatchdog.ts";

const NOW = DateTime.makeUnsafe("2026-10-15T12:00:00.000Z");
const OLD = DateTime.makeUnsafe("2026-10-15T06:00:00.000Z");
const RECENT = DateTime.makeUnsafe("2026-10-15T11:55:00.000Z");

type Projection = Parameters<typeof staleFinishedRun>[0];

const projection = (overrides: Partial<Projection> = {}): Projection =>
  ({
    thread: { updatedAt: OLD },
    runs: [{ id: "run-1", status: "running" }],
    runtimeRequests: [],
    subagents: [],
    turnItems: [
      { runId: "run-1", type: "command_execution", status: "completed", updatedAt: OLD },
      {
        runId: "run-1",
        type: "assistant_message",
        status: "completed",
        streaming: false,
        updatedAt: OLD,
      },
    ],
    ...overrides,
  }) as unknown as Pick<
    OrchestrationV2ThreadProjection,
    "thread" | "runs" | "runtimeRequests" | "turnItems" | "subagents"
  >;

it("returns a running run whose final answer went quiet", () => {
  assert.strictEqual(staleFinishedRun(projection(), NOW)?.id, "run-1");
});

it("leaves a thread with recent activity alone", () => {
  assert.isNull(
    staleFinishedRun(
      projection({ thread: { updatedAt: RECENT } } as unknown as Partial<Projection>),
      NOW,
    ),
  );
});

it("leaves a run waiting on a request alone", () => {
  assert.isNull(
    staleFinishedRun(
      projection({ runtimeRequests: [{ status: "pending" }] } as unknown as Partial<Projection>),
      NOW,
    ),
  );
});

it("leaves a run with a running subagent alone", () => {
  assert.isNull(
    staleFinishedRun(
      projection({
        subagents: [{ runId: "run-1", status: "running" }],
      } as unknown as Partial<Projection>),
      NOW,
    ),
  );
});

it("leaves a run whose latest item is not a final answer alone", () => {
  assert.isNull(
    staleFinishedRun(
      projection({
        turnItems: [
          {
            runId: "run-1",
            type: "assistant_message",
            status: "completed",
            streaming: false,
            updatedAt: DateTime.makeUnsafe("2026-10-15T05:00:00.000Z"),
          },
          { runId: "run-1", type: "command_execution", status: "running", updatedAt: OLD },
        ],
      } as unknown as Partial<Projection>),
      NOW,
    ),
  );
});
