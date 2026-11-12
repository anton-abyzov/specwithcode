import type { ReactElement, ReactNode } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vite-plus/test";

import type { ThreadPlanCompact } from "../../studio/threadPlanProgress";
import { PlanProgressChip } from "./PlanProgressChip";

// The real tooltip only renders its popup on hover; this keeps its label in the markup.
vi.mock("./shell/Tip", () => ({
  Tip: (props: { label: ReactNode; children: ReactElement }) => (
    <span data-tip={String(props.label)}>{props.children}</span>
  ),
}));

const PLAN: ThreadPlanCompact = {
  source: "increment",
  label: "0996-connect-launches",
  completed: 3,
  total: 5,
  current: "Reader",
  next: null,
  criteria: { verified: 2, total: 4 },
};

const visibleText = (html: string) =>
  html
    .replace(/<span class="sr-only">.*?<\/span>/g, "")
    .replace(/<[^>]*>/g, "")
    .replace(/&quot;/g, '"');

describe("PlanProgressChip", () => {
  it("shows the criteria count after the task count where there is room", () => {
    const html = renderToStaticMarkup(<PlanProgressChip plan={PLAN} />);
    expect(visibleText(html)).toBe("0996 · 3/5 · AC 2/4");
    expect(html).toContain('data-plan-progress="3/5"');
    expect(html).toContain('data-plan-ac="2/4"');
    expect(html).toContain(
      'data-tip="Increment 0996-connect-launches: 3 of 5 tasks done. 2 of 4 acceptance criteria verified. Now: Reader."',
    );
  });

  it("keeps a narrow row's text and leaves the count to the tooltip and description", () => {
    const html = renderToStaticMarkup(<PlanProgressChip plan={PLAN} showCriteria={false} />);
    expect(visibleText(html)).toBe("0996 · 3/5");
    expect(html).not.toContain("data-plan-ac-segment");
    expect(html).toContain('data-plan-ac="2/4"');
    expect(html).toContain("2 of 4 acceptance criteria verified.");
  });

  it("adds nothing for a plan without criteria", () => {
    const { criteria: _criteria, ...plain } = PLAN;
    const html = renderToStaticMarkup(<PlanProgressChip plan={plain} tip={false} />);
    expect(visibleText(html)).toBe("0996 · 3/5");
    expect(html).not.toContain("data-plan-ac");
    expect(html).not.toContain("acceptance criteria");
  });

  it("ties the done colour to tasks only", () => {
    const tasksDone = { ...PLAN, completed: 5 };
    expect(renderToStaticMarkup(<PlanProgressChip plan={tasksDone} />)).toContain(
      "text-success-foreground",
    );
    const criteriaDone = { ...PLAN, criteria: { verified: 4, total: 4 } };
    const html = renderToStaticMarkup(<PlanProgressChip plan={criteriaDone} />);
    expect(html).not.toContain("text-success-foreground");
    expect(visibleText(html)).toBe("0996 · 3/5 · AC 4/4");
  });
});
