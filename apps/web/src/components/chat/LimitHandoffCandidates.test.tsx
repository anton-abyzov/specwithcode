import type { LimitHandoffCandidatesResult } from "@specweave-studio/contracts";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vite-plus/test";

vi.mock("../../studio/limitHandoff", () => ({ limitHandoff: { candidates: {} } }));
vi.mock("../../state/use-atom-command", () => ({ useAtomCommand: () => vi.fn() }));
vi.mock("../handoff/HandOffThreadDialog", () => ({ requestHandOffThread: vi.fn() }));
vi.mock("../ui/button", () => ({ Button: "button" }));
vi.mock("../ui/tooltip", () => ({
  Tooltip: ({ children }: { children: unknown }) => <>{children as never}</>,
  TooltipTrigger: ({ render }: { render: unknown }) => <>{render as never}</>,
  TooltipPopup: ({ children }: { children: unknown }) => (
    <div data-slot="tooltip">{children as never}</div>
  ),
}));

import { act, create, type ReactTestRenderer } from "react-test-renderer";
import { LimitHandoffCandidateList, limitHandoffOrderTip } from "./LimitHandoffCandidates";

const candidate = (
  label: string,
  text: string,
  eligible: boolean,
): LimitHandoffCandidatesResult["candidates"][number] =>
  ({
    environmentId: `env-${label}`,
    machineLabel: label,
    modelSelection: { instanceId: "claudeAgent", model: "claude-opus-5-5" },
    eligible,
    reason: eligible ? "eligible" : "offline",
    text,
    usedPercent: null,
    resetsAt: null,
  }) as unknown as LimitHandoffCandidatesResult["candidates"][number];

const result = (patch: Partial<LimitHandoffCandidatesResult>): LimitHandoffCandidatesResult =>
  ({
    available: true,
    order: "other-machine-first",
    thresholdPercent: 95,
    candidates: [],
    waiting: null,
    checkedAt: "2026-10-20T20:00:00.000Z",
    ...patch,
  }) as LimitHandoffCandidatesResult;

const noop = () => {};

describe("LimitHandoffCandidateList", () => {
  it("offers one Move button for the first machine that can take the thread", async () => {
    vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
    const onMove = vi.fn();
    const value = result({
      candidates: [
        candidate("Minis", "Minis: same Claude account as M4", false),
        candidate("M3", "M3: Claude has room (40% used)", true),
        candidate("M1", "M1: Claude has room (10% used)", true),
      ],
    });
    let renderer!: ReactTestRenderer;
    await act(() => {
      renderer = create(<LimitHandoffCandidateList result={value} onMove={onMove} />);
    });
    const buttons = renderer.root.findAllByType("button" as never);
    expect(buttons).toHaveLength(1);
    expect(buttons[0]!.findByType("span" as never).children).toEqual(["Move to M3"]);
    // The order and every machine's verdict live in the Tooltip primitive (hover and
    // keyboard focus), not a native title and not a numbered list.
    expect(buttons[0]!.props.title).toBeUndefined();
    expect(renderer.root.findByProps({ "data-slot": "tooltip" }).children).toEqual([
      "Other machines are tried before this machine's models.\n" +
        "Minis: same Claude account as M4\nM3: Claude has room (40% used)\nM1: Claude has room (10% used)",
    ]);
    const html = renderToStaticMarkup(<LimitHandoffCandidateList result={value} onMove={noop} />);
    expect(html).not.toContain("<ol");
    expect(html).not.toContain("1. ");
    buttons[0]!.props.onClick();
    // The move carries the model the verdict was for, not just the machine.
    expect(onMove).toHaveBeenCalledExactlyOnceWith(value.candidates[1]);
    await act(() => renderer.unmount());
    vi.unstubAllGlobals();
  });

  it("says why the thread waits when no machine can take it", () => {
    const html = renderToStaticMarkup(
      <LimitHandoffCandidateList
        result={result({
          candidates: [
            candidate("Minis", "Minis: same Claude account as M4", false),
            candidate("M3", "M3: offline", false),
          ],
          waiting: "No other machine has room: Minis: same Claude account as M4; M3: offline.",
        })}
        onMove={noop}
      />,
    );
    expect(html).not.toContain("<button");
    expect(html).toContain('role="status"');
    expect(html).toContain("No other machine has room");
    // Each verdict is in plain view, reachable without hover.
    expect(html).not.toContain("title=");
    expect(html).toContain("<li>Minis: same Claude account as M4</li>");
    expect(html).toContain("<li>M3: offline</li>");
  });

  it("names the same-machine-first order in the tooltip", () => {
    expect(
      limitHandoffOrderTip(
        result({
          order: "same-machine-first",
          candidates: [candidate("Minis", "Minis: Claude has room (40% used)", true)],
        }),
      ),
    ).toBe(
      "This machine's models are tried before other machines.\nMinis: Claude has room (40% used)",
    );
  });

  it("says when this server can't move threads yet", () => {
    const html = renderToStaticMarkup(
      <LimitHandoffCandidateList
        result={result({
          available: false,
          candidates: [candidate("Minis", "Minis: the paired machines aren't loaded yet", true)],
        })}
        onMove={noop}
      />,
    );
    expect(html).toContain("This server can&#x27;t move threads to another machine yet.");
    expect(html).not.toContain("<button");
  });

  it("renders nothing without machine targets", () => {
    expect(
      renderToStaticMarkup(<LimitHandoffCandidateList result={result({})} onMove={noop} />),
    ).toBe("");
  });
});
