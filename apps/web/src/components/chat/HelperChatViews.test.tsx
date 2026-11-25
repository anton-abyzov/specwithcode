import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vite-plus/test";

import { HelperChatBlockersView } from "./HelperChatBlockers";
import { HelperChatBreadcrumbView } from "./HelperChatBreadcrumb";

describe("a helper chat's header", () => {
  it("names the requesting project and machine, never No project", () => {
    const html = renderToStaticMarkup(
      <HelperChatBreadcrumbView
        helper={{ projectName: "specweave", fromMachine: "M5" }}
        onOpen={() => {}}
      />,
    );
    expect(html).toContain("data-helper-chat-origin");
    expect(html).toContain("specweave");
    expect(html).toContain("· on M5");
    expect(html).toContain("open the thread that asked for this");
    expect(html).not.toContain("No project");
  });
});

describe("blocked helpers in the thread that started them", () => {
  it("lists each blocked helper with its blocker and an Open link", () => {
    const html = renderToStaticMarkup(
      <HelperChatBlockersView
        blocked={[
          {
            helper: {
              environmentId: "win",
              id: "helper",
              title: "Git push credentials check on win",
            },
            blocker: "On win: run gh auth login --hostname github.com.",
          },
        ]}
        onOpen={() => {}}
      />,
    );
    expect(html).toContain("data-helper-chat-blockers");
    expect(html).toContain("Git push credentials check on win is blocked:");
    expect(html).toContain("On win: run gh auth login --hostname github.com.");
    expect(html).toContain(">Open<");
    expect(html).toContain("lane-surface");
  });

  it("renders nothing while no helper is blocked", () => {
    expect(renderToStaticMarkup(<HelperChatBlockersView blocked={[]} onOpen={() => {}} />)).toBe(
      "",
    );
  });
});
