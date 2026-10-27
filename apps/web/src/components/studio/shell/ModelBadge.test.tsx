// @vitest-environment jsdom
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vite-plus/test";
import type { OrchestrationV2ThreadShell } from "@specweave-studio/contracts";
vi.mock("../../../state/entities", () => ({ useServerConfigs: () => new Map() }));
vi.mock("./Tip", () => ({ Tip: ({ children }: { children: React.ReactNode }) => children }));
import { ModelBadge, modelConnection, ThreadModelBadge } from "./ModelBadge";

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
  const render = (current: { instanceId: string; model: string }, header = false) => {
    const host = document.createElement("div");
    host.innerHTML = renderToStaticMarkup(
      <ThreadModelBadge thread={shell(current)} entries={new Map()} header={header} />,
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
      // Only the provider word may give way; the pick is in the tooltip and the sentence.
      expect(parts(root)).toEqual(["provider", "provider"]);
      expect(root.hasAttribute("data-row-line")).toBe(false);
      expect(root.querySelectorAll(".sws-model-mark")).toHaveLength(1);
      const suffix = root.querySelector('.sws-model-state[data-model-state="fallback"]')!;
      expect(suffix.querySelector("[data-fallback-glyph]")).not.toBeNull();
      expect(suffix.textContent).toBe(", fallback for Claude Code · Opus 5.5 (usage limit)");
    }
  });

  it.each([false, true])("tells a usage pre-switch from a limit stop (header %s)", (header) => {
    const thread = shell({ instanceId: "codex", model: "gpt-6-astra" });
    const preswitched = {
      ...thread,
      modelIdentity: { ...thread.modelIdentity!, preswitched: true },
    } as OrchestrationV2ThreadShell;
    const host = document.createElement("div");
    host.innerHTML = renderToStaticMarkup(
      <ThreadModelBadge thread={preswitched} entries={new Map()} header={header} />,
    );
    expect(host.querySelector(".sws-model-state .sr-only")?.textContent).toBe(
      ", fallback for Claude Code · Opus 5.5 (near its usage limit)",
    );
  });

  it("lets only the header's chip leave the name out of sight", () => {
    const root = render({ instanceId: "codex", model: "gpt-6-astra" }, true);
    expect(root.getAttribute("data-row-line")).toBe("header");
    expect(parts(root)).toEqual(["provider", "provider", "name"]);
  });

  it("names a connection only beside another that reads as the same provider", () => {
    type Entries = Parameters<typeof modelConnection>[0];
    type Entry = Entries extends ReadonlyMap<string, infer E> ? E : never;
    const entry = (instanceId: string, driverKind: string, displayName: string, more = {}) =>
      [
        instanceId,
        {
          instanceId,
          driverKind,
          displayName,
          isDefault: false,
          enabled: true,
          models: [],
          ...more,
        } as unknown as Entry,
      ] as const;
    const codex = entry("codex", "codex", "Codex", { isDefault: true });
    const work = entry("codex_work", "codex", "Codex Work");
    const gemini = entry("gemini", "acpRegistry", "Gemini CLI", { acpRegistryAgentId: "gemini" });
    const both: Entries = new Map([codex, work, gemini]);
    expect(modelConnection(both, "codex_work")).toBe("Codex Work");
    expect(modelConnection(both, "codex")).toBe("Codex");
    // A lone registry agent is the only way to its provider: its name adds nothing.
    expect(modelConnection(both, "gemini")).toBeNull();
    expect(modelConnection(new Map([codex]), "codex")).toBeNull();
    // A connection just removed stays a moment, disabled; it leaves Codex alone again.
    const removed = entry("codex_work", "codex", "Codex Work", { enabled: false });
    expect(modelConnection(new Map([codex, removed]), "codex")).toBeNull();
    expect(modelConnection(both, "devin")).toBeNull();
  });

  it("leaves a plain model badge without fit parts", () => {
    const host = document.createElement("div");
    host.innerHTML = renderToStaticMarkup(
      <ModelBadge entry={null} instanceId="codex" model="gpt-6.1-sol" />,
    );
    expect(host.querySelector("[data-row-part]")).toBeNull();
  });
});
