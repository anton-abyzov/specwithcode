import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vite-plus/test";

import { TeamRulesInert, TeamRulesLockNote } from "./TeamRulesLock";

const lock = { setBy: "Set by Acme", message: "Acme's rules turn off phones on this machine." };

describe("TeamRulesInert", () => {
  it("adds no markup to a free control", () => {
    expect(
      renderToStaticMarkup(
        <TeamRulesInert lock={null}>
          <button type="button">Pair</button>
        </TeamRulesInert>,
      ),
    ).toBe('<button type="button">Pair</button>');
  });

  it("makes a locked control inert and keeps it visible", () => {
    const markup = renderToStaticMarkup(
      <TeamRulesInert lock={lock}>
        <button type="button">Pair</button>
      </TeamRulesInert>,
    );
    expect(markup).toContain("inert");
    expect(markup).toContain("Pair");
  });

  it("names who locked it and why", () => {
    const markup = renderToStaticMarkup(<TeamRulesLockNote lock={lock} />);
    expect(markup).toContain("Set by Acme");
    expect(markup).toContain("Acme&#x27;s rules turn off phones");
  });
});
