/**
 * 1390 AC-39: when every machine is out of the thread's track, the automatic
 * start opens the progress view's no-move state by itself, once per episode,
 * and the limit banner keeps its own line.
 */
import type { EnvironmentId, LimitHandoffCandidatesResult } from "@specweave-studio/contracts";
import { renderToStaticMarkup } from "react-dom/server";
import { beforeEach, describe, expect, it, vi } from "vite-plus/test";

const noMove = vi.hoisted(() => vi.fn());
vi.mock("../../studio/limitHandoff", () => ({ limitHandoff: { candidates: {} } }));
vi.mock("../../state/use-atom-command", () => ({ useAtomCommand: () => vi.fn() }));
vi.mock("../handoff/HandOffThreadDialog", () => ({ requestHandOffThread: vi.fn() }));
vi.mock("../handoff/HandOffProgress", () => ({
  requestHandOffProgress: vi.fn(),
  requestHandOffNoMove: noMove,
}));
vi.mock("../ui/button", () => ({ Button: "button" }));
vi.mock("../ui/tooltip", () => ({
  Tooltip: ({ children }: { children: unknown }) => <>{children as never}</>,
  TooltipTrigger: ({ render }: { render: unknown }) => <>{render as never}</>,
  TooltipPopup: ({ children }: { children: unknown }) => <div>{children as never}</div>,
}));

import { act, create, type ReactTestRenderer } from "react-test-renderer";
import { trackOutView } from "../handoff/handOffProgress.logic";
import { LimitHandoffCandidateList, trackNoMove, useTrackNoMove } from "./LimitHandoffCandidates";

type Decision = NonNullable<LimitHandoffCandidatesResult["track"]>;
const environmentId = "env-m4" as EnvironmentId;

const decision = (patch: Partial<Decision> = {}): Decision =>
  ({
    threadId: "thread-1",
    track: "daily",
    machineLabel: "M4",
    trackOut: true,
    reason: "Daily track out of tokens on M4",
    target: null,
    everyMachineOut: true,
    earliestReset: { machineLabel: "Minis", at: "2026-10-20T22:30:00.000Z" },
    recheckAt: "2026-10-20T22:31:00.000Z",
    machines: [
      {
        environmentId: "env-minis",
        machineLabel: "Minis",
        state: "out",
        line: "Minis: out",
        resetsAt: "2026-10-20T22:30:00.000Z",
      },
      {
        environmentId: "env-m5",
        machineLabel: "M5",
        state: "out",
        line: "M5: out",
        resetsAt: "2026-10-21T03:00:00.000Z",
      },
      {
        environmentId: "env-m3",
        machineLabel: "M3",
        state: "unreachable",
        line: "M3: unreachable",
        resetsAt: null,
      },
    ],
    decidedAt: "2026-10-20T14:02:00.000Z",
    ...patch,
  }) as unknown as Decision;

describe("trackNoMove", () => {
  it("names the track, the thread staying and each out machine's reset", () => {
    const state = trackNoMove(decision(), "Shop");
    expect(state).toEqual({
      projectName: "Shop",
      trackOut: {
        track: "Daily",
        staying: 1,
        resets: [
          { machineLabel: "Minis", resetsAt: "2026-10-20T22:30:00.000Z" },
          { machineLabel: "M5", resetsAt: "2026-10-21T03:00:00.000Z" },
        ],
      },
    });
    expect(trackOutView(state!.trackOut).reset).toEqual({
      machineLabel: "Minis",
      resetsAt: "2026-10-20T22:30:00.000Z",
    });
  });

  it("keeps the earliest reset when no out machine reported it", () => {
    const state = trackNoMove(
      decision({
        machines: [],
        earliestReset: { machineLabel: "Minis", at: "2026-10-20T22:30:00.000Z" },
      }),
      "Shop",
    );
    expect(state?.trackOut.resets).toEqual([
      { machineLabel: "Minis", resetsAt: "2026-10-20T22:30:00.000Z" },
    ]);
    const unknown = trackNoMove(decision({ machines: [], earliestReset: null }), "Shop");
    expect(unknown && trackOutView(unknown.trackOut).reset).toBeNull();
  });

  it("is null while a machine has room, after a move, or without a decision", () => {
    expect(trackNoMove(decision({ everyMachineOut: false }), "Shop")).toBeNull();
    expect(
      trackNoMove(
        decision({ target: { machineLabel: "Minis" } as unknown as Decision["target"] }),
        "Shop",
      ),
    ).toBeNull();
    expect(trackNoMove(null, "Shop")).toBeNull();
    expect(trackNoMove(undefined, "Shop")).toBeNull();
  });
});

describe("useTrackNoMove", () => {
  beforeEach(() => noMove.mockReset());

  function Probe(props: { track: Decision | null }) {
    useTrackNoMove(environmentId, props.track, "Shop");
    return null;
  }

  it("opens the no-move view once per episode, not on every refresh", () => {
    let renderer!: ReactTestRenderer;
    act(() => {
      renderer = create(<Probe track={decision()} />);
    });
    expect(noMove).toHaveBeenCalledTimes(1);
    expect(noMove).toHaveBeenCalledWith(environmentId, trackNoMove(decision(), "Shop"));

    // The 30-second refresh decides again: the same episode opens nothing more.
    act(() => renderer.update(<Probe track={decision({ decidedAt: "2026-10-20T14:02:30.000Z" })} />));
    expect(noMove).toHaveBeenCalledTimes(1);

    // A machine has room, then the track runs out again: a new episode.
    act(() => renderer.update(<Probe track={decision({ everyMachineOut: false })} />));
    act(() => renderer.update(<Probe track={decision({ decidedAt: "2026-10-20T15:00:00.000Z" })} />));
    expect(noMove).toHaveBeenCalledTimes(2);
    act(() => renderer.unmount());
  });

  it("opens nothing while a machine has room", () => {
    let renderer!: ReactTestRenderer;
    act(() => {
      renderer = create(<Probe track={decision({ everyMachineOut: false })} />);
    });
    act(() => renderer.update(<Probe track={null} />));
    expect(noMove).not.toHaveBeenCalled();
    act(() => renderer.unmount());
  });

  it("keeps the limit banner's own line", () => {
    const html = renderToStaticMarkup(
      <LimitHandoffCandidateList
        result={
          {
            available: true,
            order: "this-machine-first",
            thresholdPercent: 95,
            candidates: [],
            waiting: "Daily track is out on every machine.",
            track: decision(),
            checkedAt: "2026-10-20T14:02:00.000Z",
          } as unknown as LimitHandoffCandidatesResult
        }
        onMove={() => {}}
      />,
    );
    expect(html).toContain("Daily track is out on every machine");
    expect(html).toContain("Next reset: Minis at");
  });
});
