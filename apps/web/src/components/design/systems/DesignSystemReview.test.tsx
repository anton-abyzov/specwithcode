// @vitest-environment jsdom
import type { DesignSystemConfirmInput } from "@specweave-studio/contracts";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vite-plus/test";

import { ACME_PROPOSAL, WEAVE_PROPOSAL } from "./fixtureData";
import { DesignSystemReview, type DesignSystemReviewProps } from "./DesignSystemReview";

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

function render(overrides: Partial<DesignSystemReviewProps> = {}) {
  const onConfirm = vi.fn<(input: DesignSystemConfirmInput) => void>();
  const onDiscard = vi.fn();
  act(() =>
    root.render(
      <DesignSystemReview
        proposal={WEAVE_PROPOSAL}
        ownerLabel="Atlas web"
        onConfirm={onConfirm}
        onDiscard={onDiscard}
        {...overrides}
      />,
    ),
  );
  return { onConfirm, onDiscard };
}

const $ = <T extends Element = HTMLElement>(selector: string) =>
  container.querySelector<T>(selector);
const click = (element: Element | null) => {
  expect(element).not.toBeNull();
  act(() => (element as HTMLElement).click());
};
const confirmButton = () => $<HTMLButtonElement>('[data-testid="review-confirm"]')!;

describe("DesignSystemReview", () => {
  it("groups tokens by change with unchanged collapsed behind a count", () => {
    render();
    const groups = [...container.querySelectorAll<HTMLElement>('[data-testid="review-group"]')];
    expect(groups.map((group) => group.dataset.group)).toEqual(["New", "Changed", "Removed"]);
    expect(
      container.querySelectorAll('[data-testid="token-row"][data-change="unchanged"]'),
    ).toHaveLength(0);
    const toggle = $('[data-testid="review-unchanged-toggle"]')!;
    expect(toggle.textContent).toContain("4 unchanged");
    click(toggle);
    expect(
      container.querySelectorAll('[data-testid="token-row"][data-change="unchanged"]'),
    ).toHaveLength(4);
    // Changed tokens show the value before and after.
    const accent = $('[data-testid="token-row"][data-name="wv-accent"]')!;
    expect(accent.querySelector('[data-testid="token-diff"]')?.textContent).toContain("#3b6cf6");
    expect(accent.querySelector('[data-testid="token-diff"]')?.textContent).toContain("#2f62f0");
    expect(accent.querySelectorAll('[data-testid="token-swatch"]').length).toBeGreaterThan(0);
    // Painted with background-color only, which cannot load an image.
    for (const swatch of accent.querySelectorAll<HTMLElement>('[data-testid="token-swatch"]')) {
      expect(swatch.style.backgroundColor).not.toBe("");
      expect(swatch.style.backgroundImage).toBe("");
    }
  });

  it("shows findings with their location and line", () => {
    render();
    const findings = [...container.querySelectorAll<HTMLElement>('[data-testid="review-finding"]')];
    expect(findings.map((finding) => finding.dataset.severity)).toEqual(["warning", "info"]);
    expect(findings[0]!.textContent).toContain("--wv-scrim only in vskill-platform copy");
    expect(findings[0]!.textContent).toContain("vskill-platform/src/styles/weave.css:88");
  });

  it("sends unticked tokens and components as excludes", () => {
    const { onConfirm } = render();
    click($('[aria-label="Include wv-scrim"]'));
    click($('[aria-label="Include wv-shadow-soft"]'));
    click(
      [...container.querySelectorAll("button")].find((b) =>
        b.textContent?.startsWith("Components"),
      ) ?? null,
    );
    click($('[aria-label="Include .wv-btn"]'));
    expect($('[data-testid="review-summary"]')!.textContent).toBe(
      "5 changes will be written to Atlas web.",
    );
    click(confirmButton());
    expect(onConfirm).toHaveBeenCalledWith({
      proposalId: "prop_weave",
      excludeTokens: ["wv-scrim", "wv-shadow-soft"],
      excludeComponents: ["css:.wv-btn"],
    });
  });

  it("lists brand files on their own tab and sends unticked ones as excludes", () => {
    const sha256 = "a".repeat(64);
    const { onConfirm } = render({
      proposal: {
        ...WEAVE_PROPOSAL,
        files: [
          { source: "packages/kit/README.md", path: "README.md", bytes: 120, sha256 },
          {
            source: "apps/site/public/brand/mark.svg",
            path: "assets/Brand/mark.svg",
            bytes: 2048,
            sha256,
          },
        ],
      },
    });
    click(
      [...container.querySelectorAll("button")].find((b) => b.textContent === "Files (2)") ?? null,
    );
    const rows = [...container.querySelectorAll('[data-testid="file-row"]')];
    expect(rows.map((row) => row.getAttribute("data-path"))).toEqual([
      "README.md",
      "assets/Brand/mark.svg",
    ]);
    expect(rows[1]!.textContent).toContain("apps/site/public/brand/mark.svg");
    expect(rows[1]!.textContent).toContain("2 KB");
    click($('[aria-label="Include assets/Brand/mark.svg"]'));
    click(confirmButton());
    expect(onConfirm).toHaveBeenCalledWith(
      expect.objectContaining({ excludeFiles: ["assets/Brand/mark.svg"] }),
    );
  });

  it("disables Confirm when nothing ticked would change the system", () => {
    render();
    for (const group of ["new", "changed", "removed"])
      click($(`[aria-label="Include all ${group}"]`));
    click(
      [...container.querySelectorAll("button")].find((b) =>
        b.textContent?.startsWith("Components"),
      ) ?? null,
    );
    click($('[aria-label="Include all new"]'));
    click($('[aria-label="Include all changed"]'));
    expect(confirmButton().disabled).toBe(true);
    expect($('[data-testid="review-summary"]')!.textContent).toBe(
      "Nothing ticked changes the system.",
    );
    click($('[aria-label="Include .wv-tooltip"]'));
    expect(confirmButton().disabled).toBe(false);
  });

  it("names a new system from the editable name field", () => {
    const { onConfirm } = render({ proposal: ACME_PROPOSAL, ownerLabel: "Borealis API" });
    const input = $<HTMLInputElement>("input")!;
    expect(input.value).toBe("Acme UI");
    act(() => {
      Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!.call(
        input,
        "Acme UI kit",
      );
      input.dispatchEvent(new Event("input", { bubbles: true }));
    });
    expect(confirmButton().textContent).toBe("Create design system");
    click(confirmButton());
    expect(onConfirm.mock.calls[0]![0]).toEqual({
      proposalId: "prop_acme",
      excludeTokens: [],
      excludeComponents: [],
      name: "Acme UI kit",
    });
  });

  it("shows a conflict plainly and still lets the user discard", () => {
    const { onDiscard } = render({
      error:
        "This design system changed after the proposal was made (it is now at revision 5). Discard this proposal and rescan or import again to review the latest version.",
    });
    expect($('[role="alert"]')!.textContent).toContain("it is now at revision 5");
    click(
      [...container.querySelectorAll("button")].find((b) => b.textContent === "Discard") ?? null,
    );
    expect(onDiscard).toHaveBeenCalledOnce();
  });
});
