// @vitest-environment jsdom
import { act } from "react";
import { create, type ReactTestInstance, type ReactTestRenderer } from "react-test-renderer";
import { afterEach, describe, expect, it, vi } from "vite-plus/test";

const state = vi.hoisted(() => ({
  config: { cwd: "/Users/you", keybindings: [] } as { cwd: string; keybindings: unknown } | null,
  mayOperate: true,
  scopes: [] as Array<unknown>,
  detached: { until: null as number | null, forget: (() => {}) as () => void },
  detachedKeys: [] as Array<string>,
}));
vi.mock("@effect/atom-react", () => ({ useAtomValue: () => state.config }));
vi.mock("../../state/server", () => ({
  serverEnvironment: { configValueAtom: (environmentId: string) => environmentId },
}));
vi.mock("../../state/session", () => ({
  useEnvironmentScope: (_environmentId: string, scope: unknown) => {
    state.scopes.push(scope);
    return state.mayOperate;
  },
}));
vi.mock("../onboarding/AgentSetupPanel", () => ({
  AgentSetupPanel: () => null,
  useDetachedInstall: (environmentId: string, instanceId: string) => {
    state.detachedKeys.push(`${environmentId}:${instanceId}`);
    return state.detached;
  },
}));

import { AuthTerminalOperateScope } from "@specweave-studio/contracts";

import { AgentSetupPanel } from "../onboarding/AgentSetupPanel";
import {
  CopyCredentialInstall,
  CopyCredentialInstallWatch,
  installAgent,
  LEFT_RUNNING_CHECK_MS,
} from "./CopyCredentialInstall";

const COMMAND = "npm install --global wrangler";
const AGENT = installAgent("wrangler", COMMAND);

let renderer: ReactTestRenderer;
const onEnded = vi.fn();
const mount = (disabled = false) =>
  act(() => {
    renderer = create(
      <CopyCredentialInstall
        environmentId={"m5" as never}
        tool="wrangler"
        command="npm install --global wrangler"
        disabled={disabled}
        onEnded={onEnded}
      />,
    );
  });
const button = (): ReactTestInstance | undefined =>
  renderer.root.findAll(
    (node) =>
      node.props["data-slot"] === "copy-credential-install" && typeof node.type === "string",
  )[0];
const panels = () => renderer.root.findAllByType(AgentSetupPanel);

afterEach(() => {
  act(() => renderer?.unmount());
  state.config = { cwd: "/Users/you", keybindings: [] };
  state.mayOperate = true;
  state.scopes.length = 0;
  state.detached = { until: null, forget: () => {} };
  state.detachedKeys.length = 0;
  onEnded.mockReset();
  vi.useRealTimers();
});

describe("CopyCredentialInstall", () => {
  it("runs nothing until the click, then opens the install in that machine's terminal panel", () => {
    mount();
    expect(panels()).toHaveLength(0);
    expect(state.scopes).toContain(AuthTerminalOperateScope);
    act(() => button()!.props.onClick());
    expect(panels()).toHaveLength(1);
    expect(panels()[0]!.props.session).toEqual({
      environmentId: "m5",
      agent: AGENT,
      agentName: "wrangler",
      cwd: "/Users/you",
      command: "npm install --global wrangler",
      purpose: "install",
      keybindings: [],
    });
    expect(button()!.props.disabled).toBe(true);
    expect(onEnded).not.toHaveBeenCalled();
    // A row that closes or changes mid-install leaves the install to finish on its machine.
    expect(panels()[0]!.props.keepInstallRunning).toBe(true);
  });

  it("offers no second install while one it left is still running, and says so", () => {
    state.detached = { until: Date.now() + 60_000, forget: vi.fn() };
    mount();
    // Filed under the name the panel uses for this tool's install by this command.
    expect(state.detachedKeys).toContain(`m5:${AGENT}`);
    expect(button()!.props.disabled).toBe(true);
    expect(
      renderer.root.findAll(
        (node) =>
          node.props["data-slot"] === "copy-credential-install-running" &&
          typeof node.type === "string",
      ),
    ).toHaveLength(1);
  });

  it("names an install by its tool and its command, so another project's is another install", () => {
    expect(AGENT).toMatch(/^credential-tool-wrangler-[0-9a-z]+$/u);
    expect(installAgent("wrangler", COMMAND)).toBe(AGENT);
    expect(installAgent("wrangler", "cd /Users/you/site && npm install")).not.toBe(AGENT);
    expect(installAgent("wrangler", "cd /Users/you/shop && npm install")).not.toBe(
      installAgent("wrangler", "cd /Users/you/site && npm install"),
    );
  });

  it("forgets a left install when its panel is closed by hand", () => {
    const forget = vi.fn();
    state.detached = { until: null, forget };
    mount();
    act(() => button()!.props.onClick());
    act(() => panels()[0]!.props.onClose());
    expect(forget).toHaveBeenCalledTimes(1);
    expect(button()!.props.disabled).toBe(false);
  });

  it("checks the row again when the install worked, and keeps a failed one's log open", () => {
    mount();
    act(() => button()!.props.onClick());
    act(() => panels()[0]!.props.onEnded(false));
    expect(panels()).toHaveLength(1);
    expect(onEnded).not.toHaveBeenCalled();
    act(() => panels()[0]!.props.onEnded(true));
    expect(panels()).toHaveLength(0);
    expect(onEnded).toHaveBeenCalledTimes(1);
    // Closing the panel by hand checks again too: the person may have finished it there.
    act(() => button()!.props.onClick());
    act(() => panels()[0]!.props.onClose());
    expect(panels()).toHaveLength(0);
    expect(onEnded).toHaveBeenCalledTimes(2);
  });

  it("shows no button to a connection that may not operate that machine's terminal", () => {
    state.mayOperate = false;
    mount();
    expect(button()).toBeUndefined();
    act(() => renderer.unmount());
    state.mayOperate = true;
    state.config = null;
    mount();
    expect(button()).toBeUndefined();
  });

  it("stays disabled while the list is", () => {
    mount(true);
    expect(button()!.props.disabled).toBe(true);
  });
});

describe("CopyCredentialInstallWatch", () => {
  const onCheck = vi.fn();
  const watch = (command: string | null, paused = false) => (
    <CopyCredentialInstallWatch
      environmentId={"m5" as never}
      tool="wrangler"
      command={command}
      paused={paused}
      onCheck={onCheck}
    />
  );
  afterEach(() => onCheck.mockReset());

  it("checks the row every so often until the wait runs out, and not on top of a check", () => {
    vi.useFakeTimers();
    vi.setSystemTime(1_000_000);
    const forget = vi.fn();
    state.detached = { until: 1_000_000 + 4 * LEFT_RUNNING_CHECK_MS - 1, forget };
    act(() => {
      renderer = create(watch(COMMAND));
    });
    expect(renderer.toJSON()).toBeNull();
    expect(state.detachedKeys).toContain(`m5:${AGENT}`);
    act(() => void vi.advanceTimersByTime(LEFT_RUNNING_CHECK_MS));
    act(() => void vi.advanceTimersByTime(LEFT_RUNNING_CHECK_MS));
    expect(onCheck).toHaveBeenCalledTimes(2);
    // The row is being checked already: this turn is passed over.
    act(() => renderer.update(watch(COMMAND, true)));
    act(() => void vi.advanceTimersByTime(LEFT_RUNNING_CHECK_MS));
    expect(onCheck).toHaveBeenCalledTimes(2);
    expect(forget).not.toHaveBeenCalled();
    // An install that never lands gives the button back.
    act(() => renderer.update(watch(COMMAND)));
    act(() => void vi.advanceTimersByTime(LEFT_RUNNING_CHECK_MS));
    expect(forget).toHaveBeenCalledTimes(1);
    expect(onCheck).toHaveBeenCalledTimes(2);
  });

  it("starts nothing when no install was left running", () => {
    vi.useFakeTimers();
    act(() => {
      renderer = create(watch(COMMAND));
    });
    act(() => void vi.advanceTimersByTime(4 * LEFT_RUNNING_CHECK_MS));
    expect(onCheck).not.toHaveBeenCalled();
  });

  it("lets go of the install once the row offers none, under the name it was filed by", () => {
    vi.useFakeTimers();
    vi.setSystemTime(1_000_000);
    const forget = vi.fn();
    state.detached = { until: 1_000_000 + 60_000, forget };
    act(() => {
      renderer = create(watch(COMMAND));
    });
    expect(forget).not.toHaveBeenCalled();
    state.detachedKeys.length = 0;
    // The tool was found: the row offers no install any more.
    act(() => renderer.update(watch(null)));
    expect(forget).toHaveBeenCalledTimes(1);
    expect(new Set(state.detachedKeys)).toEqual(new Set([`m5:${AGENT}`]));
    act(() => void vi.advanceTimersByTime(4 * LEFT_RUNNING_CHECK_MS));
    expect(onCheck).not.toHaveBeenCalled();
  });

  it("forgets at once a wait that ran out while the row was away", () => {
    vi.useFakeTimers();
    vi.setSystemTime(1_000_000);
    const forget = vi.fn();
    state.detached = { until: 999_999, forget };
    act(() => {
      renderer = create(watch(COMMAND));
    });
    expect(forget).toHaveBeenCalledTimes(1);
  });
});
