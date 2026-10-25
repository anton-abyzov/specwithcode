// @vitest-environment jsdom
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vite-plus/test";
import type { OrchestrationV2ThreadShell } from "@specweave-studio/contracts";
vi.mock("../../../state/entities", () => ({ useServerConfigs: () => new Map() }));
vi.mock("./Tip", () => ({ Tip: ({ children }: { children: React.ReactNode }) => children }));
import { ThreadModelBadge } from "./ModelBadge";

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
      expect(root.querySelector(".sr-only")?.textContent).toContain("Claude Code · Opus 5.5");
  });
});
