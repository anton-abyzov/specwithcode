// @vitest-environment jsdom
import type { EnvironmentId, ScopedThreadRef, ThreadId } from "@specweave-studio/contracts";
import { act, type ReactNode } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vite-plus/test";

let resolveOpen: ((value: { _tag: "Success"; value: unknown }) => void) | null = null;
const openTerminal = vi.fn(
  () =>
    new Promise<{ _tag: "Success"; value: unknown }>((resolve) => {
      resolveOpen = resolve;
    }),
);
vi.mock("../../state/use-atom-command", () => ({ useAtomCommand: () => openTerminal }));

const { useClaudeShip } = await import("./useClaudeShip");

let host: HTMLDivElement;
let root: Root;
let hook: ReturnType<typeof useClaudeShip>;

function Harness({ thread = "thread-a" }: { readonly thread?: string }) {
  hook = useClaudeShip({
    environmentId: "env" as EnvironmentId,
    threadId: thread as ThreadId,
    threadTarget: { environmentId: "env", threadId: thread } as unknown as ScopedThreadRef,
    cwd: `/work/${thread}`,
    fallbackCwd: "/work/project-root",
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
  resolveOpen = null;
  openTerminal.mockClear();
});

it("clears the draft of the thread that asked, not the one shown when the terminal opens", async () => {
  const clearThreadA = vi.fn();
  const clearThreadB = vi.fn();
  hook.composer.clearDraft = clearThreadA;
  act(() => {
    hook.intercept("/ship", vi.fn());
  });
  act(() =>
    document
      .querySelector<HTMLButtonElement>('[data-testid="claude-ship-open-terminal"]')
      ?.click(),
  );
  expect(openTerminal).toHaveBeenCalledTimes(1);

  // The view moved to thread B while the open was in flight.
  hook.composer.clearDraft = clearThreadB;
  await act(async () => {
    resolveOpen?.({ _tag: "Success", value: undefined });
  });

  expect(clearThreadA).toHaveBeenCalledTimes(1);
  // The composer checks this text, so a newer draft typed meanwhile is kept.
  expect(clearThreadA).toHaveBeenCalledWith("/ship");
  expect(clearThreadB).not.toHaveBeenCalled();
});

it("drops a card left open when the view moves to another thread", () => {
  const sendAsWritten = vi.fn();
  act(() => {
    hook.intercept("/ship", sendAsWritten);
  });
  const dialog = () => document.querySelector('[data-testid="claude-ship-dialog"]');
  expect(dialog()).not.toBeNull();

  act(() => root.render(<Harness thread="thread-b" />));
  expect(dialog()).toBeNull();

  // Back on the first thread, the old card and its pending send are gone.
  act(() => root.render(<Harness thread="thread-a" />));
  expect(dialog()).toBeNull();
  expect(openTerminal).not.toHaveBeenCalled();
  expect(sendAsWritten).not.toHaveBeenCalled();
});

it("leaves a card opened on the next thread alone when the last thread's open finishes", async () => {
  hook.composer.clearDraft = vi.fn();
  act(() => {
    hook.intercept("/ship", vi.fn());
  });
  const openButton = () =>
    document.querySelector<HTMLButtonElement>('[data-testid="claude-ship-open-terminal"]');
  act(() => openButton()?.click());
  expect(openTerminal).toHaveBeenCalledTimes(1);

  act(() => root.render(<Harness thread="thread-b" />));
  act(() => {
    hook.intercept("/steward", vi.fn());
  });
  // Thread B's card is its own: not stuck in thread A's opening state.
  expect(openButton()?.disabled).toBe(false);

  await act(async () => {
    resolveOpen?.({ _tag: "Success", value: undefined });
  });
  expect(document.querySelector('[data-testid="claude-ship-dialog"]')).not.toBeNull();
  expect(openButton()?.disabled).toBe(false);
});

it("opens only in the thread's own folder, never the project root as a fallback", async () => {
  act(() => {
    hook.intercept("/ship", vi.fn());
  });
  act(() =>
    document
      .querySelector<HTMLButtonElement>('[data-testid="claude-ship-open-terminal"]')
      ?.click(),
  );
  const request = (openTerminal.mock.calls[0] as unknown as [{ input: Record<string, unknown> }])[0];
  expect(request.input.cwd).toBe("/work/thread-a");
  expect(request.input).not.toHaveProperty("fallbackCwd");
  await act(async () => {
    resolveOpen?.({ _tag: "Success", value: undefined });
  });
});
