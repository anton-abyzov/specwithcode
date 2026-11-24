// @vitest-environment jsdom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vite-plus/test";

import { ClaudeShipDialog } from "./ClaudeShipDialog";
import { claudeShipPlan, parseClaudeShipCommand } from "./claudeShip.logic";

let host: HTMLDivElement;
let root: Root;

beforeEach(() => {
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  host = document.createElement("div");
  document.body.append(host);
  root = createRoot(host);
});

afterEach(() => {
  act(() => root.unmount());
  host.remove();
  document.body.innerHTML = "";
});

const base = {
  cliVersion: "2.1.331",
  interactionMode: "default",
  runtimeMode: "auto" as const,
  platform: "darwin",
  sessionId: "0f6c8a5e-1111-4222-8333-444455556666",
};

function render(
  planInput: Parameters<typeof claudeShipPlan>[0],
  onOpenTerminal = vi.fn(),
  onSendAnyway = vi.fn(),
) {
  act(() => {
    root.render(
      <ClaudeShipDialog
        open
        onOpenChange={() => {}}
        line={parseClaudeShipCommand("/ship low 41")!}
        plan={claudeShipPlan(planInput)}
        opening={false}
        error={null}
        onOpenTerminal={onOpenTerminal}
        onSendAnyway={onSendAnyway}
      />,
    );
  });
  const dialog = document.querySelector<HTMLElement>('[data-testid="claude-ship-dialog"]')!;
  const open = document.querySelector<HTMLButtonElement>(
    '[data-testid="claude-ship-open-terminal"]',
  )!;
  const sendAnyway = document.querySelector<HTMLButtonElement>(
    '[data-testid="claude-ship-send-anyway"]',
  )!;
  return { dialog, open, onOpenTerminal, sendAnyway, onSendAnyway };
}

it("shows the exact line to type and opens the terminal", () => {
  const { dialog, open, onOpenTerminal } = render(base);
  expect(dialog.textContent).toContain("Ship with Claude Code");
  expect(document.querySelector('[data-testid="claude-ship-line"]')?.textContent).toBe(
    "/ship low 41",
  );
  expect(document.querySelector('[data-testid="claude-ship-notes"]')).toBeNull();
  expect(open.disabled).toBe(false);
  act(() => open.click());
  expect(onOpenTerminal).toHaveBeenCalledTimes(1);
});

it("blocks an outdated Claude Code and says how to update", () => {
  const { dialog, open } = render({ ...base, cliVersion: "2.1.302" });
  expect(dialog.textContent).toContain("Claude Code 2.1.302 is installed");
  expect(dialog.textContent).toContain("claude update");
  expect(open.disabled).toBe(true);
});

it("explains full access, plan mode and a new session without blocking", () => {
  const { dialog, open } = render({
    ...base,
    runtimeMode: "full-access",
    interactionMode: "plan",
    sessionId: null,
  });
  const kinds = [...dialog.querySelectorAll("[data-kind]")].map((node) =>
    node.getAttribute("data-kind"),
  );
  expect(kinds).toEqual(["plan", "full-access", "new-session"]);
  expect(dialog.textContent).toContain("auto mode");
  expect(open.disabled).toBe(false);
});

it("can still send the line to Claude, for a custom command of the same name", () => {
  const { sendAnyway, onSendAnyway } = render({ ...base, cliVersion: "2.1.302" });
  expect(sendAnyway.disabled).toBe(false);
  act(() => sendAnyway.click());
  expect(onSendAnyway).toHaveBeenCalledTimes(1);
});
