import type { HtmlRenderReference } from "@specweave-studio/shared/htmlRender";
import { describe, expect, it } from "vite-plus/test";

import type { TimelineEntry } from "../../session-logic";
import { replacedHtmlRenderEntryIds } from "./MessagesTimeline.logic";

const render = (id: string, htmlRender: Omit<HtmlRenderReference, "attachmentId" | "height">) =>
  ({
    id,
    kind: "html-render",
    createdAt: "2026-11-27T06:00:00.000Z",
    runId: null,
    htmlRender: { attachmentId: `${id}.html`, height: 600, ...htmlRender },
  }) as unknown as TimelineEntry;

describe("replacedHtmlRenderEntryIds", () => {
  it("marks every report but the newest of each title, case and spaces aside", () => {
    const replaced = replacedHtmlRenderEntryIds([
      render("a", { title: "Whiteboard guide" }),
      render("b", { title: "Release notes" }),
      render("c", { title: " whiteboard guide " }),
      render("d", { title: "Whiteboard guide", stage: true }),
    ]);
    expect([...replaced].sort()).toEqual(["a", "c"]);
  });

  it("leaves diagrams alone, since a thread may hold several alike", () => {
    const replaced = replacedHtmlRenderEntryIds([
      render("a", { title: "Flow", kind: "visual" }),
      render("b", { title: "Flow", kind: "visual" }),
    ]);
    expect(replaced.size).toBe(0);
  });
});
