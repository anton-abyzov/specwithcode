import type { DocumentSessionActivity } from "@specweave-studio/contracts";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vite-plus/test";

import { DocumentAccessList, DocumentActivityList, DocumentHeader } from "./DocumentHeader";
import type { PresenceEntry } from "./presence";

const PRESENCE: ReadonlyArray<PresenceEntry> = [
  { id: "w1", kind: "window", name: "You", color: 0, self: true, viewOnly: false },
  { id: "w2", kind: "window", name: "Window 2", color: 1, self: false, viewOnly: true },
  { id: "a1", kind: "agent", name: "Planner", color: 2, self: false, viewOnly: false },
];

const ACTIVITY: ReadonlyArray<DocumentSessionActivity> = [
  {
    id: 1,
    at: "2026-11-25T10:00:00.000Z",
    by: { id: "w2", kind: "window" },
    cells: 1,
    first: "B2",
    layout: false,
  },
  {
    id: 2,
    at: "2026-11-25T10:01:00.000Z",
    by: { id: "gone", kind: "agent", label: "Planner" },
    cells: 4,
    first: "A1",
    layout: true,
  },
  {
    id: 3,
    at: "2026-11-25T10:02:00.000Z",
    by: { id: "file", kind: "file" },
    cells: 0,
    layout: true,
  },
];

const header = (access: "edit" | "view", presence = PRESENCE) =>
  renderToStaticMarkup(
    <DocumentHeader
      kind="sheet"
      title="Budget"
      presence={presence}
      activity={ACTIVITY}
      access={access}
    />,
  );

describe("the shared document header", () => {
  it("carries the kind, the title, presence, Comments, Versions and Share, in that order", () => {
    const html = header("edit");
    const order = [
      'data-testid="document-kind"',
      'data-testid="document-title"',
      'data-testid="document-presence"',
      'data-testid="document-comments"',
      'data-testid="document-versions"',
      'data-testid="document-share"',
    ].map((part) => html.indexOf(part));
    expect(order.every((at) => at >= 0)).toBe(true);
    expect(order).toEqual([...order].sort((a, b) => a - b));
    expect(html).toContain(">Sheet<");
    expect(html).toContain(">Budget<");
    expect(html).toContain('aria-label="Version history"');
    expect(html).toContain('aria-label="Share"');
  });

  it("draws everyone on the document in their colour, agents as agents", () => {
    const html = header("edit");
    expect(html.match(/class="document-presence-dot"/g)).toHaveLength(3);
    expect(html).toContain('data-presence-id="a1"');
    expect(html).toContain('data-presence-kind="agent"');
    expect(html).toContain('data-presence-color="2"');
    expect(html).toContain('aria-label="Window 2"');
  });

  it("counts the participants it has no room for", () => {
    const many = Array.from({ length: 8 }, (_, index) => ({
      ...PRESENCE[1]!,
      id: `w${index}`,
      name: `Window ${index}`,
    }));
    const html = header("edit", many);
    expect(html.match(/class="document-presence-dot"/g)).toHaveLength(5);
    expect(html).toContain("+3");
  });

  it("says when this window can only view", () => {
    expect(header("view")).toContain('data-testid="document-view-only"');
    expect(header("edit")).not.toContain('data-testid="document-view-only"');
  });

  it("keeps Comments off where the kind has none yet", () => {
    expect(header("edit")).toMatch(
      /data-testid="document-comments"[^>]*disabled|disabled[^>]*data-testid="document-comments"/,
    );
  });
});

describe("version history", () => {
  it("lists who changed what, newest first", () => {
    const html = renderToStaticMarkup(
      <DocumentActivityList activity={ACTIVITY} presence={PRESENCE} />,
    );
    const rows = html.split("<li").slice(1);
    expect(rows).toHaveLength(3);
    expect(rows[0]).toContain("The file on disk");
    expect(rows[0]).toContain("changed the layout");
    expect(rows[1]).toContain("Planner");
    expect(rows[1]).toContain("changed 4 cells and the layout");
    expect(rows[2]).toContain("Window 2");
    expect(rows[2]).toContain("changed B2");
  });

  it("says so when nothing has changed", () => {
    expect(renderToStaticMarkup(<DocumentActivityList activity={[]} presence={[]} />)).toContain(
      "No changes since this document was opened.",
    );
  });
});

describe("Share", () => {
  it("lists who can open the document and offers nothing to change", () => {
    const html = renderToStaticMarkup(<DocumentAccessList access="view" agents={["Planner"]} />);
    expect(html.match(/data-access-row=/g)).toHaveLength(3);
    expect(html).toContain("This window");
    expect(html).toContain("Can view");
    expect(html).toContain("Your agents (Planner)");
    expect(html).not.toMatch(/<button|<input|<select|<a /);
  });
});
