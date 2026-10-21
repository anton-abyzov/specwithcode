import type { ThreadIncrementCriterion } from "@specweave-studio/contracts";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vite-plus/test";

import { criteriaSummary, criterionState, ThreadPlanCriteria } from "./ThreadPlanCriteria";

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
