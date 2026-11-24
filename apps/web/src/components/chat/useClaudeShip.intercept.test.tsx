// @vitest-environment jsdom
import type { EnvironmentId } from "@specweave-studio/contracts";
import { act, type ReactNode } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vite-plus/test";

vi.mock("../../state/use-atom-command", () => ({ useAtomCommand: () => vi.fn() }));

const { useClaudeShip } = await import("./useClaudeShip");

let host: HTMLDivElement;
let root: Root;
let hook: ReturnType<typeof useClaudeShip>;

function Harness() {
  hook = useClaudeShip({
    environmentId: "env" as EnvironmentId,
    threadId: null,
    threadTarget: null,
    cwd: null,
    fallbackCwd: null,
    worktreePath: null,
    providerInstanceId: null,
    sessionId: null,
    cliVersion: "2.1.331",
    binaryPath: "claude",
    platformOs: "darwin",
    runtimeMode: "auto",
    interactionMode: "default",
    hasTerminalWriteAccess: () => true,
    allocateTerminalId: () => "t-1",
    env: undefined,
    showTerminal: () => {},
    dropTerminal: () => {},
  });
  return hook.dialog as ReactNode;
}

beforeEach(() => {
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  host = document.createElement("div");
  document.body.append(host);
  root = createRoot(host);
  act(() => root.render(<Harness />));
});

afterEach(() => {
  act(() => root.unmount());
  host.remove();
});

const sendAnyway = () =>
  document.querySelector<HTMLButtonElement>('[data-testid="claude-ship-send-anyway"]');

it("leaves other drafts to the composer", () => {
  expect(hook.intercept("/shipit", vi.fn())).toBe(false);
});

it("sends the intercepted draft as written once, and still takes the next one", () => {
  const first = vi.fn();
  let taken = false;
  act(() => {
    taken = hook.intercept("/ship", first);
  });
  expect(taken).toBe(true);
  act(() => sendAnyway()?.click());
  expect(first).toHaveBeenCalledTimes(1);
  expect(sendAnyway()).toBeNull();

  // No time window: a later send that is not the replay opens the card again.
  const second = vi.fn();
  act(() => {
    taken = hook.intercept("/steward 12", second);
  });
  expect(taken).toBe(true);
  expect(second).not.toHaveBeenCalled();
  expect(first).toHaveBeenCalledTimes(1);
});
