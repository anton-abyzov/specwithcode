import type { LimitHandoffCandidatesResult } from "@specweave-studio/contracts";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vite-plus/test";

vi.mock("../../studio/limitHandoff", () => ({ limitHandoff: { candidates: {} } }));
vi.mock("../../state/use-atom-command", () => ({ useAtomCommand: () => vi.fn() }));

import { LimitHandoffCandidateList } from "./LimitHandoffCandidates";

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

describe("LimitHandoffCandidateList", () => {
  it("lists each machine's verdict in order and why the thread waits", () => {
    const html = renderToStaticMarkup(
      <LimitHandoffCandidateList
        result={result({
          candidates: [
            candidate("Minis", "Minis: same Claude account as M4", false),
            candidate("M3", "M3: offline", false),
          ],
          waiting: "No other machine has room: Minis: same Claude account as M4; M3: offline.",
        })}
      />,
    );
    expect(html).toContain("Other machines are tried before this machine&#x27;s models.");
    expect(html.indexOf("1. Minis: same Claude account as M4")).toBeLessThan(
      html.indexOf("2. M3: offline"),
    );
    expect(html).toContain('role="status"');
    expect(html).toContain("No other machine has room");
  });
  it("names the same-machine-first order", () => {
    const html = renderToStaticMarkup(
      <LimitHandoffCandidateList
        result={result({
          order: "same-machine-first",
          candidates: [candidate("Minis", "Minis: Claude has room (40% used)", true)],
        })}
      />,
    );
    expect(html).toContain("This machine&#x27;s models are tried before other machines.");
    expect(html).not.toContain('role="status"');
  });
  it("says when this server can't move threads yet", () => {
    const html = renderToStaticMarkup(
      <LimitHandoffCandidateList
        result={result({
          available: false,
          candidates: [candidate("Minis", "Minis: the paired machines aren't loaded yet", false)],
        })}
      />,
    );
    expect(html).toContain("This server can&#x27;t move threads to another machine yet.");
  });
  it("renders nothing without machine targets", () => {
    expect(renderToStaticMarkup(<LimitHandoffCandidateList result={result({})} />)).toBe("");
  });
});
