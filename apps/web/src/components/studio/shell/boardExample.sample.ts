/**
 * The example board beside the Board tab's explainer (1396 AC-14): five
 * fictional increments shaped like the board fixture's, at a fixed `now`,
 * and the four frames of its one play. One card moves from Planned to Active
 * (a working thread appears), to In review (its pull request appears), to
 * Done. In every frame each card sits in the column its evidence says.
 */
import type { ProjectBoardCard } from "@specweave-studio/contracts";
import type { EnvironmentThreadShell } from "@specweave-studio/client-runtime/state/shell";

import type { BoardThread } from "./BoardThreads";

export const BOARD_EXAMPLE_NOW = Date.parse("2026-11-14T18:00:00Z");
const ago = (minutes: number) => new Date(BOARD_EXAMPLE_NOW - minutes * 60_000).toISOString();
const pull = (number: number) => `https://example.invalid/pull/${number}`;

/** The card that moves. */
export const BOARD_EXAMPLE_MOVER = "0004-export-reports";
/** Frames 0 to 3: Planned, Active, In review, Done. */
export const BOARD_EXAMPLE_FRAMES = 4;
export const BOARD_EXAMPLE_LAST_FRAME = BOARD_EXAMPLE_FRAMES - 1;
/** How long each frame holds while it plays. */
export const BOARD_EXAMPLE_STEP_MS = 1_600;

function card(
  incrementId: string,
  title: string,
  column: ProjectBoardCard["column"],
  done: number,
  total: number,
  extra: Partial<ProjectBoardCard> = {},
): ProjectBoardCard {
  return {
    incrementId,
    title,
    status: column === "done" ? "completed" : "active",
    column,
    tasks: { total, done, active: column === "active" ? 1 : 0 },
    blocked: false,
    paused: false,
    pausedReason: null,
    blockedTasks: 0,
    blockers: [],
    columnReason: "status",
    updatedAt: ago(30),
    pullRequests: [],
    specPath: null,
    ...extra,
  };
}

function working(id: string, title: string, minutes: number): BoardThread {
  const thread = {
    id,
    environmentId: "example",
    projectId: "example",
    title,
    updatedAt: ago(minutes),
  } as unknown as EnvironmentThreadShell;
  return {
    thread,
    tone: "working",
    status: "Working",
    updatedAt: ago(minutes),
    machine: {
      ownerMachineId: "example",
      executionMachineId: "example",
      state: "running",
      moved: false,
      label: "",
      description: "",
    },
    color: "0",
    binding: null,
    boundTaskId: null,
    boundAt: null,
  };
}

/** The cards that stay where they are. */
const STILL: ReadonlyArray<ProjectBoardCard> = [
  card("0005-onboarding-tour", "Onboarding tour", "planned", 0, 4, { updatedAt: ago(240) }),
  card("0003-search-filters", "Search filters", "active", 3, 6, { updatedAt: ago(12) }),
  card("0002-dark-mode", "Dark mode", "review", 7, 7, {
    pullRequests: [pull(42)],
    updatedAt: ago(55),
  }),
  card("0001-passkey-sign-in", "Passkey sign-in", "done", 5, 5, {
    pullRequests: [pull(37)],
    updatedAt: ago(1_440),
  }),
];

const STILL_THREADS: ReadonlyArray<readonly [string, BoardThread]> = [
  ["0003-search-filters", working("example-search", "Search filters", 4)],
];

export interface BoardExampleFrame {
  readonly cards: ReadonlyArray<ProjectBoardCard>;
  readonly threads: ReadonlyMap<string, ReadonlyArray<BoardThread>>;
}

/** The board at one frame of the play. */
export function boardExampleFrame(frame: number): BoardExampleFrame {
  const step = Math.max(0, Math.min(BOARD_EXAMPLE_LAST_FRAME, Math.trunc(frame)));
  const title = "Export reports as CSV";
  const mover =
    step === 0
      ? card(BOARD_EXAMPLE_MOVER, title, "planned", 0, 5, { updatedAt: ago(90) })
      : step === 1
        ? card(BOARD_EXAMPLE_MOVER, title, "active", 2, 5, { updatedAt: ago(2) })
        : step === 2
          ? card(BOARD_EXAMPLE_MOVER, title, "review", 5, 5, {
              pullRequests: [pull(48)],
              updatedAt: ago(1),
            })
          : card(BOARD_EXAMPLE_MOVER, title, "done", 5, 5, {
              pullRequests: [pull(48)],
              updatedAt: ago(0),
            });
  const threads = new Map<string, ReadonlyArray<BoardThread>>(
    STILL_THREADS.map(([id, entry]) => [id, [entry]]),
  );
  // Only while the work is under way does a thread show on the card.
  if (step === 1) threads.set(BOARD_EXAMPLE_MOVER, [working("example-export", title, 1)]);
  return { cards: [mover, ...STILL], threads };
}
