import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vite-plus/test";

import { ThreadBlockerNote } from "./ThreadBlockerNote";

describe("ThreadBlockerNote", () => {
  it("shows the whole blocker the thread waits on", () => {
    const blocker = "Ship 1.0.20 today, or wait for the Windows signer?";
    const html = renderToStaticMarkup(<ThreadBlockerNote blocker={blocker} />);
    expect(html).toContain("data-thread-blocker");
    expect(html).toContain("Blocked: ");
    expect(html).toContain(blocker);
    expect(html).not.toContain("Show more");
  });

  it("paints an opaque card so timeline rows never show through", () => {
    const html = renderToStaticMarkup(<ThreadBlockerNote blocker="Waiting on review" />);
    expect(html).toContain("lane-surface");
    expect(html).not.toMatch(/(?:^|\s)bg-(?:card|warning)\/\d+/);
  });

  it("folds a long blocker to one line and keeps the full text", () => {
    const blocker = "The repo has two stashes I left alone. ".repeat(10);
    const html = renderToStaticMarkup(<ThreadBlockerNote blocker={blocker} />);
    expect(html).toContain("line-clamp-1");
    expect(html).toContain("Show more");
    expect(html).toContain(blocker.trim());
  });

  it("folds anything longer than about one line", () => {
    const blocker =
      "You need to pick an option on the card; I recommend Build as proposed, then I branch.";
    const longer = `${blocker} After you approve, I ask the holder first.`;
    expect(renderToStaticMarkup(<ThreadBlockerNote blocker={blocker} />)).not.toContain(
      "line-clamp-1",
    );
    expect(renderToStaticMarkup(<ThreadBlockerNote blocker={longer} />)).toContain("line-clamp-1");
  });
});
