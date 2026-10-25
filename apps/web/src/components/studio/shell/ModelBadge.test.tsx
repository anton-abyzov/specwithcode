// @vitest-environment jsdom
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vite-plus/test";
import type { OrchestrationV2ThreadShell } from "@specweave-studio/contracts";
vi.mock("../../../state/entities", () => ({ useServerConfigs: () => new Map() }));
vi.mock("./Tip", () => ({ Tip: ({ children }: { children: React.ReactNode }) => children }));
import { ModelBadge, ThreadModelBadge } from "./ModelBadge";

describe("ThreadModelBadge", () => {
  it.each(["fallback", "running", null] as const)("keeps %s identity in one model unit", (kind) => {
    const thread = {
      modelSelection: { instanceId: "claudeAgent", model: "claude-opus-5-5" },
      modelIdentity: {
        current: { instanceId: "codex", model: "gpt-6.1-sol" },
        preferred: kind ? { instanceId: "claudeAgent", model: "claude-opus-5-5" } : null,
        kind,
      },
    } as unknown as OrchestrationV2ThreadShell;
    const host = document.createElement("div");
    host.innerHTML = renderToStaticMarkup(
      <ThreadModelBadge thread={thread} entries={new Map()} variant="chip" focusable />,
    );
    expect(host.children).toHaveLength(1);
    const root = host.firstElementChild!;
    expect(root.classList.contains("sws-model")).toBe(true);
    expect(root.classList.contains("sws-model-chip")).toBe(true);
    expect(root.getAttribute("tabindex")).toBe("0");
    expect(root.querySelector(".sws-model-name")?.textContent).toContain("GPT-6.1");
    expect(root.querySelector(".sws-model-state")?.getAttribute("data-model-state") ?? null).toBe(
      kind === "running" ? "preferred" : kind,
    );
    if (kind)
      expect(root.querySelector(".sws-model-state .sr-only")?.textContent).toContain(
        "Claude Code · Opus 5.5",
      );
    // The provider's word may give way on a short line; its twin keeps it for screen readers.
    expect(root.querySelector("[data-model-provider-name]")?.textContent).toBe("Codex ");
    expect(root.querySelector(".sws-model-provider")?.getAttribute("aria-hidden")).toBe("true");
  });

  const shell = (current: { instanceId: string; model: string }) =>
    ({
      modelSelection: { instanceId: "claudeAgent", model: "claude-opus-5-5" },
      modelIdentity: {
        current,
        preferred: { instanceId: "claudeAgent", model: "claude-opus-5-5" },
        kind: "fallback",
      },
    }) as unknown as OrchestrationV2ThreadShell;
  const render = (current: { instanceId: string; model: string }) => {
    const host = document.createElement("div");
    host.innerHTML = renderToStaticMarkup(
      <ThreadModelBadge thread={shell(current)} entries={new Map()} />,
    );
    return host.firstElementChild!;
  };
  const parts = (root: Element) =>
    [...root.querySelectorAll("[data-row-part]")].map((part) => part.getAttribute("data-row-part"));

  it("keeps a fallback to the running model and its glyph, with no visible home pick", () => {
    for (const current of [
      { instanceId: "codex", model: "gpt-6.1-sol" },
      { instanceId: "claudeAgent", model: "claude-sonnet-5-5" },
    ]) {
      const root = render(current);
      // Only the provider word gives way; the pick is in the tooltip and the sentence.
      expect(parts(root)).toEqual(["provider", "provider"]);
      expect(root.querySelectorAll(".sws-model-mark")).toHaveLength(1);
      const suffix = root.querySelector('.sws-model-state[data-model-state="fallback"]')!;
      expect(suffix.querySelector("[data-fallback-glyph]")).not.toBeNull();
      expect(suffix.textContent).toBe(", fallback for Claude Code · Opus 5.5 (usage limit)");
    }
  });

  it("leaves a plain model badge without fit parts", () => {
    const host = document.createElement("div");
    host.innerHTML = renderToStaticMarkup(
      <ModelBadge entry={null} instanceId="codex" model="gpt-6.1-sol" />,
    );
    expect(host.querySelector("[data-row-part]")).toBeNull();
  });
});
