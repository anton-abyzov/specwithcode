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
  });
});
