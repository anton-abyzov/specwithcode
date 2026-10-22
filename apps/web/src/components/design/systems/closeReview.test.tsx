// @vitest-environment jsdom
/** Regression tests for the 0973 closing review: the rescan wording (AC-05) and lineage text. */
import type { EnvironmentId, ProjectId } from "@specweave-studio/contracts";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it } from "vite-plus/test";

import { DesignSystemsSettingsView } from "./DesignSystemsSettingsView";
import { FIGMA_OFF, PROJECTS, SYSTEMS } from "./fixtureData";
import { isRescannable, lineageText, systemKey } from "./reviewModel";

let container: HTMLDivElement;
let root: Root;

beforeEach(() => {
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
});

afterEach(() => {
  act(() => root.unmount());
  container.remove();
});

describe("rescan (AC-05)", () => {
  it('says "No changes" when every source hash matches', () => {
    const system = SYSTEMS.find(isRescannable)!;
    act(() =>
      root.render(
        <DesignSystemsSettingsView
          systems={SYSTEMS}
          systemsError={null}
          problems={[]}
          proposals={[]}
          projects={PROJECTS}
          now={0}
          canWrite
          rescans={{ [systemKey(system)]: { status: "unchanged" } }}
          threadTitleFor={() => null}
          onRescan={() => undefined}
          onOpenProposal={() => undefined}
          onNew={() => undefined}
          figma={{ status: FIGMA_OFF, error: null, checking: false, onCheck: () => undefined }}
        />,
      ),
    );
    const notes = [...container.querySelectorAll('[data-testid="rescan-note"]')];
    expect(notes.map((note) => note.textContent)).toEqual(["No changes"]);
  });
});

describe("lineage", () => {
  const owner = {
    kind: "project" as const,
    environmentId: "env" as EnvironmentId,
    projectId: "acme" as ProjectId,
  };

  it("names the upstream, and says when the owner does not hold it", () => {
    expect(lineageText({})).toBe("");
    expect(
      lineageText({
        derivedFromLabel: "Weave",
        derivedFrom: { owner, systemId: "weave" as never },
      }),
    ).toBe("Derived from Weave.");
    expect(lineageText({ derivedFromLabel: "Weave" })).toBe(
      "Derived from Weave (not among this owner's design systems).",
    );
  });
});
