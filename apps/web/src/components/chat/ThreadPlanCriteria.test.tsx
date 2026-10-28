import type { ThreadIncrementCriterion } from "@specweave-studio/contracts";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vite-plus/test";

import {
  criteriaSummary,
  criterionState,
  formatAcceptanceDate,
  ThreadPlanCriteria,
} from "./ThreadPlanCriteria";

const CRITERIA: ThreadIncrementCriterion[] = [
  { id: "AC-01", text: "Search", met: true, state: "verified", tasks: ["T-01"], story: "US-001" },
  { id: "AC-02", text: "Pages", met: true, state: "declared", tasks: ["T-02"], story: "US-001" },
  { id: "AC-03", text: "Filter", met: false, state: "open", tasks: ["T-01", "T-03"] },
  { id: "AC-04", text: "Counts", met: false, state: "uncovered", tasks: [] },
];

const visibleText = (html: string) => html.replace(/<[^>]*>/g, "");

describe("ThreadPlanCriteria", () => {
  it("summarizes strongest first and leaves out empty states", () => {
    expect(criteriaSummary(CRITERIA)).toBe("1 verified · 1 declared only · 1 open · 1 no task");
  });

  it("shows a check only for verified, the covering tasks and the story groups", () => {
    const html = renderToStaticMarkup(<ThreadPlanCriteria criteria={CRITERIA} />);
    expect(html.match(/lucide-shield-check/g)?.length).toBe(1);
    expect(html).not.toContain("lucide-circle-check-big");
    expect(html).toContain('data-plan-criterion-state="declared"');
    expect(html).toContain('aria-label="Covered by T-01, T-03"');
    expect(visibleText(html)).toContain("US-001");
    expect(visibleText(html)).toContain("No story");
    expect(visibleText(html)).toContain("AC-04Countsno task");
  });

  it("reads an older server's bare met flag as declared, never verified", () => {
    expect(criterionState({ id: "AC-01", text: "x", met: true })).toBe("declared");
    expect(criterionState({ id: "AC-01", text: "x", met: false })).toBe("open");
    expect(
      visibleText(
        renderToStaticMarkup(
          <ThreadPlanCriteria criteria={[{ id: "AC-01", text: "x", met: true }]} />,
        ),
      ),
    ).not.toContain("No story");
  });
});

it("shows accepted-skip provenance and mixed acceptance without verified icons or ordinary skip promotion", () => {
  const waiver = {
    check: "wonder-full-shown-when-entitled",
    reason: "No Wonder Full license",
    acceptedBy: "Anton",
    acceptedAt: "2026-10-27T12:00:00Z",
    authorization: "User: keep and accept it as it is",
    by: "worker",
    at: "2026-10-27T12:01:00Z",
  };
  const criteria: ThreadIncrementCriterion[] = [
    {
      id: "AC-01",
      text: "Observed Accept",
      met: true,
      state: "verified",
      acceptance: "met",
      waivers: [],
    },
    { id: "AC-02", text: "Unobserved Decline", met: true, state: "evidenced", waivers: [] },
    {
      id: "AC-03",
      text: "Wonder Full",
      met: true,
      state: "evidenced",
      acceptance: "mixed",
      waivers: [waiver],
    },
    {
      id: "AC-04",
      text: "Only waived",
      met: false,
      state: "skipped",
      acceptance: "skipped-accepted",
      waivers: [waiver],
    },
    {
      id: "AC-05",
      text: "Other work pending",
      met: false,
      state: "open",
      acceptance: "open",
      waivers: [waiver],
    },
    { id: "AC-06", text: "Ordinary skip", met: true, state: "skipped", waivers: [] },
  ];
  const html = renderToStaticMarkup(<ThreadPlanCriteria criteria={criteria} />);
  const text = visibleText(html);
  expect(html.match(/lucide-shield-check/g)).toHaveLength(1);
  expect(text).toContain("Mixed acceptance");
  expect(text).toContain("Skipped (accepted)");
  expect(text).toContain("Accepted by Anton");
  expect(text).toContain("October 27, 2026");
  expect(text).toContain(waiver.authorization);
  expect(text).toContain("other requirements remain open");
  expect(criterionState(criteria[5]!)).toBe("skipped");
  expect(criterionState({ ...criteria[4]!, acceptance: "mixed" })).toBe("open");
  expect(criteriaSummary(criteria)).toContain("1 verified");
});

it("preserves date-only acceptance dates west of UTC while timestamps use local dates", () => {
  const previous = process.env.TZ;
  process.env.TZ = "America/New_York";
  try {
    expect(formatAcceptanceDate("2026-10-27")).toBe("October 27, 2026");
    expect(formatAcceptanceDate("2026-10-27T00:00:00Z")).toBe("October 26, 2026");
  } finally {
    if (previous === undefined) delete process.env.TZ;
    else process.env.TZ = previous;
  }
});
