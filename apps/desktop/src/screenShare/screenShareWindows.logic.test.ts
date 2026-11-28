import { describe, expect, it } from "vite-plus/test";

import {
  bannerHtml,
  bannerPosition,
  displayName,
  formatCode,
  formatElapsed,
  parseWindowAction,
  promptHtml,
} from "./screenShareWindows.logic.ts";

const SID = "0f1e2d3c-4b5a-4978-8695-a4b3c2d1e0f9";
const ask = {
  sid: SID,
  label: "Work laptop",
  shortId: "7F3A",
  stage: "ask" as const,
  expiresAt: 1_795_000_060_000,
};

describe("the prompt page", () => {
  it("names the device and its ID and offers Deny, Allow once and Always allow", () => {
    const html = promptHtml(ask);
    expect(html).toContain("Work laptop (ID 7F3A) wants to view this Mac's screen");
    for (const id of ["deny", "once", "always"]) expect(html).toContain(`id="${id}"`);
    expect(html).toContain("Touch ID or your password");
    expect(html).not.toContain('id="code"');
    expect(html).toContain(`data-sid="${SID}"`);
    expect(html).toContain('data-expires="1795000060000"');
  });

  it("shows the code on first use, and after allowing only the code and Cancel", () => {
    const first = promptHtml({ ...ask, code: "482913" });
    expect(first).toContain(">482 913<");
    expect(first).toContain('id="once"');
    const typing = promptHtml({ ...ask, code: "482913", stage: "code" });
    expect(typing).toContain(">482 913<");
    expect(typing).toContain("Type this code on that device");
    expect(typing).not.toContain('id="once"');
    expect(typing).not.toContain('id="always"');
    expect(typing).toContain('id="deny"');
  });

  it("shows a name the device gives itself now only as a second line", () => {
    const html = promptHtml({ ...ask, claimedLabel: "Anton's MacBook Pro" });
    expect(html).toContain('<h1 id="title">Work laptop (ID 7F3A)');
    expect(html).toContain('It now calls itself "Anton&#39;s MacBook Pro"');
  });

  it("escapes a name that carries markup, and runs no script of its own", () => {
    const html = promptHtml({
      ...ask,
      label: `<img src=x onerror=alert(1)>"'\``,
      shortId: `"><script>`,
      claimedLabel: "</p><script>alert(2)</script>",
    });
    expect(html).not.toMatch(/<img|<script|onerror=alert\(1\)>/);
    expect(html).toContain("&#60;img src=x onerror=alert(1)&#62;");
    expect(html).toContain("default-src 'none'");
    expect(promptHtml(ask)).not.toContain("<script");
  });

  it("keeps a name to one short line with nothing that reorders text", () => {
    expect(displayName("Work\nlaptop‮  evil")).toBe("Work laptop evil");
    expect(displayName("x".repeat(200))).toHaveLength(60);
    expect(displayName(" ​ ")).toBe("Unnamed device");
  });
});

describe("the banner page", () => {
  it("says who is viewing and has Stop", () => {
    const html = bannerHtml({
      label: "Work <laptop>",
      shortId: "7F3A",
      startedAt: 1_795_000_000_000,
    });
    expect(html).toContain("Work &#60;laptop&#62; (ID 7F3A) is viewing this screen");
    expect(html).toContain('id="stop"');
    expect(html).toContain('data-started="1795000000000"');
    expect(html).not.toContain("<script");
  });
  it("sits at the top centre of the work area", () => {
    expect(bannerPosition({ x: 0, y: 38, width: 1512 }, { width: 520 })).toEqual({ x: 496, y: 46 });
    expect(bannerPosition({ x: 1512, y: 0, width: 2560 }, { width: 520 })).toEqual({
      x: 2532,
      y: 8,
    });
  });
});

describe("what the windows may send", () => {
  it("accepts the three answers for a session and Stop, and nothing else", () => {
    expect(parseWindowAction({ window: "prompt", sid: SID, answer: "once" })).toEqual({
      window: "prompt",
      sid: SID,
      answer: "once",
    });
    expect(parseWindowAction({ window: "banner", action: "stop" })).toEqual({
      window: "banner",
      action: "stop",
    });
    for (const bad of [
      null,
      "once",
      { window: "prompt", answer: "once" },
      { window: "prompt", sid: SID, answer: "allow" },
      { window: "prompt", sid: 7, answer: "once" },
      { window: "banner", action: "enable" },
      { window: "settings", action: "stop" },
    ])
      expect(parseWindowAction(bad)).toBeNull();
  });
});

describe("small formats", () => {
  it("formats the code and the elapsed time", () => {
    expect(formatCode("482913")).toBe("482 913");
    expect(formatElapsed(0)).toBe("00:00");
    expect(formatElapsed(133_000)).toBe("02:13");
    expect(formatElapsed(3_733_000)).toBe("1:02:13");
    expect(formatElapsed(-5)).toBe("00:00");
  });
});

describe("control wording (1519)", () => {
  const view = {
    sid: "s",
    label: "Work <laptop>",
    shortId: "7F3A",
    stage: "ask" as const,
    kind: "control" as const,
    code: "482913",
    expiresAt: 1,
  };

  it("asks to control with Deny and Always allow control only, and never shows a code", () => {
    const html = promptHtml(view);
    expect(html).toContain("Work &#60;laptop&#62; (ID 7F3A) wants to control this Mac");
    expect(html).toContain('<button id="deny">Deny</button>');
    expect(html).toContain('<button id="always" class="primary">Always allow control</button>');
    expect(html).not.toContain('id="once"');
    expect(html).not.toContain("482");
    expect(html).toContain('data-kind="control"');
  });

  it("the banner says controlling while it controls", () => {
    expect(
      bannerHtml({ label: "Work laptop", shortId: "7F3A", startedAt: 0, controlling: true }),
    ).toContain("is controlling this screen");
    expect(bannerHtml({ label: "Work laptop", shortId: "7F3A", startedAt: 0 })).toContain(
      "is viewing this screen",
    );
  });
});
