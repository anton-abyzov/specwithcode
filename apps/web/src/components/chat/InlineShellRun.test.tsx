import {
  applyTerminalAttachStreamEvent,
  combineTerminalSessionState,
  EMPTY_TERMINAL_BUFFER_STATE,
  EMPTY_TERMINAL_SESSION_STATE,
  type TerminalSessionState,
} from "@specweave-studio/client-runtime/state/terminal";
import {
  EnvironmentId,
  ThreadId,
  type AuthEnvironmentScope,
  type RuntimeMode,
} from "@specweave-studio/contracts";
import { act, type ComponentProps, type ReactNode } from "react";
import { create, type ReactTestRenderer } from "react-test-renderer";
import { afterEach, beforeEach, describe, expect, it, vi } from "vite-plus/test";

const commands = vi.hoisted(() => ({
  open: vi.fn(async (_value: unknown) => ({ _tag: "Success" as const, value: null })),
  write: vi.fn(async (_value: unknown) => ({ _tag: "Success" as const, value: null })),
  close: vi.fn(async (_value: unknown) => ({ _tag: "Success" as const, value: null })),
}));
const terminal = vi.hoisted(() => ({
  state: null as TerminalSessionState | null,
  known: [] as string[],
}));

vi.mock("@effect/atom-react", () => ({ useAtomValue: () => null }));
vi.mock("../../hooks/useTheme", () => ({ useTheme: () => ({ resolvedTheme: "dark" }) }));
vi.mock("../../hooks/useSettings", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../hooks/useSettings")>();
  const settings = actual.getClientSettings();
  return {
    ...actual,
    useClientSettings: (select?: (value: typeof settings) => unknown) =>
      select ? select(settings) : settings,
  };
});
vi.mock("../ui/tooltip", async () => {
  const { cloneElement, isValidElement } = await import("react");
  return {
    Tooltip: ({ children }: { children: ReactNode }) => <>{children}</>,
    TooltipTrigger({
      render,
      children,
    }: ComponentProps<typeof import("../ui/tooltip").TooltipTrigger>) {
      if (!isValidElement(render)) return <>{children}</>;
      return children === undefined ? render : cloneElement(render, undefined, children);
    },
    TooltipPopup: () => null,
  };
});
vi.mock("../../state/use-atom-query-runner", () => ({ useAtomQueryRunner: () => vi.fn() }));
vi.mock("../../state/use-atom-command", () => ({
  useAtomCommand: (_command: unknown, label: string) =>
    label === "terminal open"
      ? commands.open
      : label === "terminal write"
        ? commands.write
        : label === "terminal close"
          ? commands.close
          : vi.fn(),
}));
vi.mock("../../state/session", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../state/session")>();
  const { AuthStandardClientScopes } = await import("@specweave-studio/contracts");
  const grantedScopes = new Set<AuthEnvironmentScope>(AuthStandardClientScopes);
  const hasScope = (environmentId: EnvironmentId | null, scope: AuthEnvironmentScope) =>
    environmentId !== null && grantedScopes.has(scope);
  return {
    ...actual,
    useEnvironmentScope: hasScope,
    readEnvironmentScope: hasScope,
    usePreparedConnection: () => ({ _tag: "Loading" }),
  };
});
vi.mock("../../state/environments", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../state/environments")>()),
  useEnvironment: (environmentId: string | null) =>
    environmentId === null ? null : { label: "MacBook M4MAX" },
}));
vi.mock("../../state/terminalSessions", () => ({
  useKnownTerminalSessions: (input: { environmentId: string | null }) =>
    input.environmentId === null
      ? null
      : terminal.known.map((terminalId) => ({ target: { terminalId } })),
  useAttachedTerminalSession: (input: { terminal: unknown }) =>
    input.terminal === null ? EMPTY_TERMINAL_SESSION_STATE : terminal.state,
}));
vi.mock("../../state/entities", () => ({
  readThreadShell: () => null,
  useProjects: () => [],
  useServerConfigs: () => new Map(),
}));
vi.mock("../../remoteOpen", () => ({
  useRemoteOpenResolution: () => ({ state: { mode: "local-exec" }, isResolved: true }),
}));
vi.mock("../../editorPreferences", () => ({
  useOpenInPreferredEditor: () => vi.fn(),
  usePreferredEditor: () => [null, vi.fn()],
}));
vi.mock("~/lib/openPullRequestLink", () => ({
  findProjectOnChangeRequestHost: () => undefined,
  parseChangeRequestUrl: () => null,
  resolvePullRequestPreviewTarget: () => null,
  useOpenChangeRequestLink: () => vi.fn(),
}));

import ChatMarkdown from "../ChatMarkdown";
import { Button } from "../ui/button";
import { ShellRunTargetContext, type ShellRunTarget } from "./InlineShellRun";
import { inlineRunTerminalId } from "./shellCodeBlocks";

const COMMAND =
  "cd ~/Downloads/specwithcode-browser-cws && mkdir -p unpacked && unzip -o *.zip -d unpacked";

function target(runtimeMode: RuntimeMode): ShellRunTarget {
  return {
    environmentId: EnvironmentId.make("env-local"),
    threadId: ThreadId.make("thread-1"),
    cwd: "/work/project",
    worktreePath: null,
    runtimeMode,
  };
}

function exitedSession(
  output: string,
  exitCode: number,
  exitSignal: number | null = null,
): TerminalSessionState {
  const buffer = applyTerminalAttachStreamEvent(EMPTY_TERMINAL_BUFFER_STATE, {
    type: "snapshot",
    snapshot: {
      threadId: "thread-1",
      terminalId: inlineRunTerminalId(COMMAND),
      cwd: "/work/project",
      worktreePath: null,
      status: "exited",
      pid: null,
      history: output,
      exitCode,
      exitSignal,
      label: "zsh",
      updatedAt: "2026-10-17T23:55:00.000Z",
    },
  });
  return combineTerminalSessionState(null, buffer);
}

function runningSession(): TerminalSessionState {
  return { ...exitedSession("unzipping…\r\n", 0), status: "running", exitCode: null };
}

function buttons(renderer: ReactTestRenderer) {
  return renderer.root.findAllByType(Button);
}

function button(renderer: ReactTestRenderer, label: string) {
  const found = buttons(renderer).find(
    (instance) =>
      instance.props["aria-label"] === label ||
      textOf(instance.props.children as ReactNode) === label,
  );
  if (!found) throw new Error(`Missing button: ${label}`);
  return found.props as ComponentProps<typeof Button>;
}

function textOf(node: ReactNode): string {
  if (typeof node === "string") return node;
  if (Array.isArray(node)) return node.map(textOf).join("");
  return "";
}

async function render(text: string, runTarget: ShellRunTarget | null, isStreaming = false) {
  let renderer: ReactTestRenderer | undefined;
  await act(async () => {
    renderer = create(
      <ShellRunTargetContext value={runTarget}>
        <ChatMarkdown cwd="/work/project" text={text} isStreaming={isStreaming} />
      </ShellRunTargetContext>,
    );
  });
  return renderer!;
}

describe("inline shell code block runs", () => {
  beforeEach(() => {
    vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
    terminal.state = EMPTY_TERMINAL_SESSION_STATE;
    terminal.known = [];
    commands.open.mockClear();
    commands.write.mockClear();
    commands.close.mockClear();
  });
  afterEach(() => vi.unstubAllGlobals());

  it("labels an unlabeled command as bash and runs it on click under Full access", async () => {
    const renderer = await render("```\n" + COMMAND + "\n```", target("full-access"));
    const block = renderer.root.findByProps({ "data-language": "bash" });
    expect(block).toBeDefined();
    expect(commands.open).not.toHaveBeenCalled();

    await act(async () => button(renderer, "Run command").onClick?.({} as never));

    expect(commands.open).toHaveBeenCalledExactlyOnceWith({
      environmentId: "env-local",
      input: expect.objectContaining({
        threadId: "thread-1",
        terminalId: inlineRunTerminalId(COMMAND),
        cwd: "/work/project",
        command: COMMAND,
      }),
    });
  });

  it("asks before running under Supervised and runs only after the confirmation", async () => {
    const renderer = await render("```bash\n" + COMMAND + "\n```", target("approval-required"));

    await act(async () => button(renderer, "Run command").onClick?.({} as never));
    expect(commands.open).not.toHaveBeenCalled();
    const confirm = renderer.root.findByProps({ "data-shell-run": "confirm" });
    expect(textOf(confirm.findByType("span").props.children as ReactNode)).toContain(
      "MacBook M4MAX in /work/project",
    );

    await act(async () => button(renderer, "Cancel").onClick?.({} as never));
    expect(renderer.root.findAllByProps({ "data-shell-run": "confirm" })).toHaveLength(0);
    expect(commands.open).not.toHaveBeenCalled();

    await act(async () => button(renderer, "Run command").onClick?.({} as never));
    const confirmRun = renderer.root.findByProps({ "data-shell-run-confirm": "" });
    await act(async () => confirmRun.props.onClick?.({} as never));
    expect(commands.open).toHaveBeenCalledOnce();
  });

  it("shows output and the exit code under the block, and clears it", async () => {
    terminal.known = [inlineRunTerminalId(COMMAND)];
    terminal.state = exitedSession("\u001b[31merror:\u001b[0m no zip\r\n", 9);
    const renderer = await render("```bash\n" + COMMAND + "\n```", target("full-access"));

    const output = renderer.root.findByProps({ "aria-label": "Command output" });
    // Plain output renders as itself: no link or code segments.
    expect(output.props.children.props.text).toBe("error: no zip");
    expect(output.children).toEqual([expect.objectContaining({ children: ["error: no zip"] })]);
    const status = renderer.root.findByProps({ "data-shell-run-status": "" });
    expect(status.props.children).toBe("Exit 9");

    await act(async () => button(renderer, "Clear").onClick?.({} as never));
    expect(commands.close).toHaveBeenCalledExactlyOnceWith({
      environmentId: "env-local",
      input: {
        threadId: "thread-1",
        terminalId: inlineRunTerminalId(COMMAND),
        deleteHistory: true,
      },
    });
  });

  it("stops a running command with Ctrl-C", async () => {
    terminal.known = [inlineRunTerminalId(COMMAND)];
    terminal.state = runningSession();
    const renderer = await render("```bash\n" + COMMAND + "\n```", target("full-access"));

    expect(renderer.root.findByProps({ "data-shell-run-status": "" }).props.children).toBe(
      "Running",
    );
    await act(async () => button(renderer, "Stop command").onClick?.({} as never));
    expect(commands.write).toHaveBeenCalledExactlyOnceWith({
      environmentId: "env-local",
      input: { threadId: "thread-1", terminalId: inlineRunTerminalId(COMMAND), data: "\u0003" },
    });
    expect(commands.open).not.toHaveBeenCalled();
  });

  it.each([2, 15])(
    "shows Stopped for signal %s even when the raw exit code is zero",
    async (signal) => {
      terminal.known = [inlineRunTerminalId(COMMAND)];
      terminal.state = exitedSession("^C\r\n", 0, signal);
      const renderer = await render("```bash\n" + COMMAND + "\n```", target("full-access"));

      const status = renderer.root.findByProps({ "data-shell-run-status": "" });
      expect(status.props.children).toBe("Stopped");
      expect(status.props.className).toContain("text-destructive-foreground");
      expect(commands.open).not.toHaveBeenCalled();
    },
  );

  it.each([null, 0])(
    "preserves successful Exit 0 when the termination signal is %s",
    async (signal) => {
      terminal.known = [inlineRunTerminalId(COMMAND)];
      terminal.state = exitedSession("done\r\n", 0, signal);
      const renderer = await render("```bash\n" + COMMAND + "\n```", target("full-access"));

      expect(renderer.root.findByProps({ "data-shell-run-status": "" }).props.children).toBe(
        "Exit 0",
      );
    },
  );

  it("offers no Run while streaming, for open fences, or outside a thread", async () => {
    const cases: Array<[string, ShellRunTarget | null, boolean]> = [
      ["```bash\necho hello\n```", target("full-access"), true],
      ["```bash\necho incomplete", target("full-access"), false],
      ["```bash\necho hello\n```", null, false],
      ["```typescript\nconst a = 1;\n```", target("full-access"), false],
      ["```text\nThis is a sentence, not a command.\n```", target("full-access"), false],
    ];
    for (const [text, runTarget, streaming] of cases) {
      const renderer = await render(text, runTarget, streaming);
      expect(
        buttons(renderer).some((instance) => instance.props["aria-label"] === "Run command"),
      ).toBe(false);
      await act(async () => renderer.unmount());
    }
  });
});
