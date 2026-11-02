import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vite-plus/test";

import { TeamRulesSectionView } from "./TeamRulesSection";

describe("TeamRulesSectionView", () => {
  it("names the owner and links only an https contact", () => {
    const safe = renderToStaticMarkup(
      <TeamRulesSectionView
        summary={{
          status: "active",
          owner: "Acme",
          contact: "https://it.acme.example/ai",
          ceiling: "approval-required",
        }}
      />,
    );
    expect(safe).toContain("Set by Acme");
    expect(safe).toContain('href="https://it.acme.example/ai"');
    expect(safe).toContain("Broadest permission");

    const unsafe = renderToStaticMarkup(
      <TeamRulesSectionView
        summary={{ status: "active", owner: "Acme", contact: "javascript:alert(1)" }}
      />,
    );
    expect(unsafe).not.toContain("href=");
  });

  it("shows why agents are paused during a hold", () => {
    const markup = renderToStaticMarkup(
      <TeamRulesSectionView summary={{ status: "hold", issues: ["version: expected 1"] }} />,
    );
    expect(markup).toContain("Agents are paused");
    expect(markup).toContain("version: expected 1");
  });
});
