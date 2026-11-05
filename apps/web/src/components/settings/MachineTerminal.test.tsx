import { AuthTerminalOperateScope, EnvironmentId } from "@specweave-studio/contracts";
import { beforeEach, describe, expect, it, vi } from "vite-plus/test";
import { visitElements } from "../../test/reactElementTree";
import { reactHookHarness as hooks } from "../../test/reactHookHarness";

const runtime = vi.hoisted(() => ({
  scopes: new Set<string>(),
  config: null as { keybindings: unknown[] } | null,
  close: vi.fn(),
}));
vi.mock("react", async (importOriginal) => {
  const actual = await importOriginal<typeof import("react")>();
  const { reactHookHarness } = await import("../../test/reactHookHarness");
  return {
    ...actual,
    useSyncExternalStore: (_subscribe: unknown, getSnapshot: () => unknown) => getSnapshot(),
    useMemo: reactHookHarness.useMemo,
    useCallback: reactHookHarness.useCallback,
  };
});
vi.mock("react/compiler-runtime", async () => ({
  c: (await import("../../test/reactHookHarness")).reactHookHarness.useMemoCache,
}));
vi.mock("@effect/atom-react", () => ({ useAtomValue: () => runtime.config }));
vi.mock("../../state/server", () => ({
  serverEnvironment: { configValueAtom: () => ({}) },
}));
vi.mock("../../state/session", () => ({
  useEnvironmentScope: (_environmentId: string, scope: string) => runtime.scopes.has(scope),
  readEnvironmentScope: (_environmentId: string, scope: string) => runtime.scopes.has(scope),
}));
vi.mock("../../state/terminal", () => ({ terminalEnvironment: { close: {} } }));
vi.mock("../../state/use-atom-command", () => ({ useAtomCommand: () => runtime.close }));
vi.mock("../../hooks/useLocalStorage", () => ({ useLocalStorage: () => [false, vi.fn()] }));
vi.mock("../ThreadTerminalDrawer", () => ({
  TerminalViewport: function TerminalViewport() {
    return null;
  },
}));

import { TerminalViewport } from "../ThreadTerminalDrawer";
import {
  MACHINE_TERMINAL_THREAD_ID,
  MachineTerminal,
  MachineTerminalButton,
  machineTerminalId,
  useCloseMachineTerminal,
} from "./MachineTerminal";

const m1 = EnvironmentId.make("env-m1");

beforeEach(() => {
  hooks.reset();
  runtime.scopes.clear();
  runtime.config = null;
  runtime.close.mockReset();
});

describe("machine terminal", () => {
  it("is offered only when this connection may operate terminals on that machine", () => {
    const button = () =>
      MachineTerminalButton({
        environmentId: m1,
        environmentLabel: "Mac M1",
        open: false,
        onOpenChange: vi.fn(),
      });
    expect(button()).toBeNull();
    runtime.scopes.add(AuthTerminalOperateScope);
    expect(
      visitElements(button(), (element) =>
        [element.props.children].flat().some((child) => child === "Terminal on Mac M1"),
      ),
    ).not.toBeNull();
  });

  it("starts this device's shell in the machine's home folder and reattaches to it", () => {
    runtime.scopes.add(AuthTerminalOperateScope);
    runtime.config = { keybindings: [] };
    hooks.beginRender();
    const tree = MachineTerminal({
      environmentId: m1,
      environmentLabel: "Mac M1",
      onClose: vi.fn(),
    });
    const viewport = visitElements(tree, (element) => element.type === TerminalViewport);
    expect(viewport?.props).toMatchObject({
      threadId: MACHINE_TERMINAL_THREAD_ID,
      cwd: "~",
      fallbackCwd: "~",
      terminalLabel: "Terminal on Mac M1",
    });
    expect(viewport?.props.terminalId).toMatch(/^machine-/);
    // Reopening (or a reconnect remount) uses the same shell, not a new one.
    hooks.beginRender();
    const again = MachineTerminal({
      environmentId: m1,
      environmentLabel: "Mac M1",
      onClose: vi.fn(),
    });
    expect(
      visitElements(again, (element) => element.type === TerminalViewport)?.props.terminalId,
    ).toBe(viewport?.props.terminalId);
    expect(runtime.close).not.toHaveBeenCalled();
  });

  it("ends the shell on close only while terminal access remains", () => {
    hooks.beginRender();
    const close = useCloseMachineTerminal();
    close(m1);
    expect(runtime.close).not.toHaveBeenCalled();
    runtime.scopes.add(AuthTerminalOperateScope);
    close(m1);
    expect(runtime.close).toHaveBeenCalledWith({
      environmentId: m1,
      input: {
        threadId: MACHINE_TERMINAL_THREAD_ID,
        terminalId: machineTerminalId(),
        deleteHistory: true,
      },
    });
  });

  it("shows no shell once terminal access is gone", () => {
    runtime.config = { keybindings: [] };
    hooks.beginRender();
    const tree = MachineTerminal({
      environmentId: m1,
      environmentLabel: "Mac M1",
      onClose: vi.fn(),
    });
    expect(visitElements(tree, (element) => element.type === TerminalViewport)).toBeNull();
  });
});
