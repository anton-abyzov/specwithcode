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
import * as Exit from "effect/Exit";
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

const machine = vi.hoisted(() => ({
  prompt: false,
  os: "darwin" as "darwin" | "linux" | "windows",
  primary: null as string | null,
  fullDiskAccess: "not-allowed" as "allowed" | "not-allowed" | "unknown",
  threadTitle: null as string | null,
  openSettings: vi.fn(async () => undefined),
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
    environmentId === null
      ? null
      : {
          label: environmentId === "env-other" ? "Mac mini" : "MacBook M4MAX",
          serverConfig: {
            environment: {
              platform: { os: machine.os },
              capabilities: machine.prompt ? { terminalElevationPrompt: true } : {},
            },
          },
        },
  usePrimaryEnvironmentId: () => machine.primary,
}));
vi.mock("../access/FullDiskAccess", () => ({
  useFullDiskAccess: () => ({
    access: { fullDiskAccess: machine.fullDiskAccess, agentHost: { name: "SpecWithCode" } },
    openSettings: machine.openSettings,
  }),
  useCanOpenSettingsFor: () => true,
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
  readThreadShell: () => (machine.threadTitle === null ? null : { title: machine.threadTitle }),
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
  command = COMMAND,
): TerminalSessionState {
  const buffer = applyTerminalAttachStreamEvent(EMPTY_TERMINAL_BUFFER_STATE, {
    type: "snapshot",
    snapshot: {
      threadId: "thread-1",
      terminalId: inlineRunTerminalId(command),
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

function tree(text: string, runTarget: ShellRunTarget | null, isStreaming = false) {
  return (
    <ShellRunTargetContext value={runTarget}>
      <ChatMarkdown cwd="/work/project" text={text} isStreaming={isStreaming} />
    </ShellRunTargetContext>
  );
}

async function render(text: string, runTarget: ShellRunTarget | null, isStreaming = false) {
  let renderer: ReactTestRenderer | undefined;
  await act(async () => {
    renderer = create(tree(text, runTarget, isStreaming));
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

  it("names the machine on the Run button", async () => {
    const renderer = await render("```bash\n" + COMMAND + "\n```", target("full-access"));
    const run = renderer.root.findByProps({ "data-shell-run-action": "run", type: "button" });
    expect(run.findByType("span").props.children).toBe("Run on MacBook M4MAX");
  });

  it("warns under Full access when a fleet invite names this machine, and runs only after", async () => {
    const renderer = await render(
      "```bash\nspecweave-studio fleet invite --coordinator env-local\n```",
      target("full-access"),
    );

    await act(async () => button(renderer, "Run command").onClick?.({} as never));

    expect(commands.open).not.toHaveBeenCalled();
    expect(renderer.root.findByProps({ "data-shell-run-warning": "" }).props.children).toContain(
      "names MacBook M4MAX as its own main machine",
    );
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

const ADMIN_COMMAND =
  "sudo cp /Library/Preferences/a.plist /Library/Preferences/a.plist.bak && sudo plutil -convert xml1 /Library/Preferences/a.plist";
const marker = (state: string, nonce: string) => `\u001b]7717;elevation=${state};${nonce}\u0007`;

function allText(node: ReactTestRenderer["root"] | string): string {
  return typeof node === "string" ? node : node.children.map(allText).join("");
}

function showSession(command: string, session: TerminalSessionState) {
  terminal.known = [inlineRunTerminalId(command)];
  terminal.state = session;
}

function waitingSession(command: string, output: string): TerminalSessionState {
  return { ...exitedSession(output, 0, null, command), status: "running", exitCode: null };
}

function lastOpenInput(): Record<string, unknown> {
  const call = commands.open.mock.calls.at(-1)?.[0] as { input: Record<string, unknown> };
  return call.input;
}

describe("administrator code blocks", () => {
  beforeEach(() => {
    vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
    terminal.state = EMPTY_TERMINAL_SESSION_STATE;
    terminal.known = [];
    commands.open.mockClear();
    commands.write.mockClear();
    machine.prompt = true;
    machine.os = "darwin";
    machine.primary = "env-local";
    machine.fullDiskAccess = "not-allowed";
    machine.threadTitle = "iPhone camera missing";
    machine.openSettings.mockClear();
  });
  afterEach(() => vi.unstubAllGlobals());

  const fence = (command: string) => "```bash\n" + command + "\n```";
  const clickRun = (renderer: ReactTestRenderer) =>
    act(async () => button(renderer, "Run command").onClick?.({} as never));
  const confirm = (renderer: ReactTestRenderer) =>
    act(async () =>
      renderer.root.findByProps({ "data-shell-run-confirm": "" }).props.onClick?.({} as never),
    );

  it("asks under Full access, naming administrator use and the system paths", async () => {
    const renderer = await render(fence(ADMIN_COMMAND), target("full-access"));
    await clickRun(renderer);

    expect(commands.open).not.toHaveBeenCalled();
    const row = allText(renderer.root.findByProps({ "data-shell-run": "confirm" }));
    expect(row).toContain("Runs as administrator on MacBook M4MAX");
    expect(row).toContain(
      "Changes system settings: /Library/Preferences/a.plist, /Library/Preferences/a.plist.bak",
    );
    expect(row).toContain("macOS will ask for your password on MacBook M4MAX.");

    await confirm(renderer);
    expect(lastOpenInput()).toMatchObject({
      command: ADMIN_COMMAND,
      elevation: { threadTitle: "iPhone camera missing" },
    });
    expect(lastOpenInput().elevation).not.toHaveProperty("requestedFrom");
  });

  it("asks for a system change that needs no administrator, and not for a read", async () => {
    const change = await render(fence("csrutil disable"), target("full-access"));
    await clickRun(change);
    expect(commands.open).not.toHaveBeenCalled();
    const row = allText(change.root.findByProps({ "data-shell-run": "confirm" }));
    expect(row).toContain("Changes system settings: csrutil disable");
    expect(row).not.toContain("Runs as administrator");
    await confirm(change);
    expect(lastOpenInput()).not.toHaveProperty("elevation");

    commands.open.mockClear();
    const read = await render(fence("cat /etc/hosts"), target("full-access"));
    await clickRun(read);
    expect(commands.open).toHaveBeenCalledOnce();
    expect(lastOpenInput()).not.toHaveProperty("elevation");
  });

  it("says which device asked when Run is pressed from another machine", async () => {
    machine.primary = "env-other";
    const renderer = await render(fence(ADMIN_COMMAND), target("full-access"));
    await clickRun(renderer);
    expect(renderer.root.findAllByProps({ "data-shell-run-terminal-app": "" })).toHaveLength(0);
    await confirm(renderer);
    expect(lastOpenInput().elevation).toEqual({
      threadTitle: "iPhone camera missing",
      requestedFrom: "Mac mini",
      nonce: expect.stringMatching(/^[A-Za-z0-9]{24}$/),
    });
  });

  it("opens the block in Terminal from the Mac's own window", async () => {
    const renderer = await render(fence(ADMIN_COMMAND), target("full-access"));
    await clickRun(renderer);
    await act(async () => button(renderer, "Open in Terminal").onClick?.({} as never));
    expect(lastOpenInput().elevation).toMatchObject({ openIn: "terminal-app" });
  });

  it.each([
    ["an older server", () => (machine.prompt = false)],
    ["a Windows machine", () => (machine.os = "windows")],
  ])("still asks but sends no new field to %s", async (_name, arrange) => {
    arrange();
    const renderer = await render(fence(ADMIN_COMMAND), target("full-access"));
    await clickRun(renderer);
    const row = allText(renderer.root.findByProps({ "data-shell-run": "confirm" }));
    expect(row).toContain("Runs as administrator on MacBook M4MAX");
    expect(row).not.toContain("macOS will ask");
    await confirm(renderer);
    expect(commands.open).toHaveBeenCalledOnce();
    expect(lastOpenInput()).not.toHaveProperty("elevation");
  });

  /** Runs the block through the confirm row; `show` then plays the server's side. */
  async function startedRun(command = ADMIN_COMMAND) {
    const renderer = await render(fence(command), target("full-access"));
    await clickRun(renderer);
    await confirm(renderer);
    const nonce = (lastOpenInput().elevation as { nonce: string }).nonce;
    const show = async (session: TerminalSessionState) => {
      showSession(command, session);
      await act(async () => renderer.update(tree(fence(command), target("full-access"))));
    };
    return { renderer, nonce, show };
  }
  const status = (renderer: ReactTestRenderer) =>
    renderer.root.findByProps({ "data-shell-run-status": "" });

  it("asks for doas without sending elevation", async () => {
    const renderer = await render(fence("doas id"), target("full-access"));
    await clickRun(renderer);
    const row = allText(renderer.root.findByProps({ "data-shell-run": "confirm" }));
    expect(row).toContain("Runs as administrator on MacBook M4MAX");
    expect(row).not.toContain("macOS will ask");
    await confirm(renderer);
    expect(commands.open).toHaveBeenCalledOnce();
    expect(lastOpenInput()).not.toHaveProperty("elevation");
  });

  it("does not leak a previous command's nonce when a reused component changes command", async () => {
    const first = await startedRun(ADMIN_COMMAND);
    const otherCommand = "sudo whoami";
    showSession(otherCommand, waitingSession(otherCommand, marker("waiting", first.nonce)));
    await act(async () => first.renderer.update(tree(fence(otherCommand), target("full-access"))));
    expect(status(first.renderer).props.children).toBe("Running");
  });

  it("sends a fresh secret with each run for the state markers", async () => {
    const first = await startedRun();
    const second = await startedRun();
    expect(first.nonce).toMatch(/^[A-Za-z0-9]{24}$/);
    expect(second.nonce).not.toBe(first.nonce);
  });

  it("says where to type the password while the prompt is up, and Cancel ends it", async () => {
    const local = await startedRun();
    await local.show(waitingSession(ADMIN_COMMAND, marker("waiting", local.nonce)));
    expect(status(local.renderer).props.children).toBe(
      "Waiting for your password on MacBook M4MAX",
    );
    expect(local.renderer.root.findAllByProps({ "aria-label": "Command output" })).toHaveLength(0);
    await act(async () => button(local.renderer, "Cancel").onClick?.({} as never));
    expect(commands.write).toHaveBeenCalledExactlyOnceWith({
      environmentId: "env-local",
      input: {
        threadId: "thread-1",
        terminalId: inlineRunTerminalId(ADMIN_COMMAND),
        data: "\u0003",
      },
    });
    // The terminal ended while the prompt was up and wrote no further state.
    await local.show(
      exitedSession(marker("waiting", local.nonce) + "^C\r\n", 130, null, ADMIN_COMMAND),
    );
    expect(status(local.renderer).props.children).toBe("Password not given. Nothing has run.");

    machine.primary = "env-other";
    const remote = await startedRun();
    await remote.show(waitingSession(ADMIN_COMMAND, marker("waiting", remote.nonce)));
    expect(status(remote.renderer).props.children).toBe(
      "Enter the password on MacBook M4MAX's screen",
    );
  });

  it.each([
    ["cancelled", "Password not given. Nothing has run."],
    ["timeout", "Nobody answered on MacBook M4MAX. Nothing has run."],
    ["denied", "Password not accepted. Nothing has run."],
    ["unavailable", "This needs an administrator password. Run it in a terminal on MacBook M4MAX."],
  ])("explains a run that ended as %s instead of showing an exit code", async (state, text) => {
    const { renderer, nonce, show } = await startedRun();
    await show(
      exitedSession(marker("waiting", nonce) + marker(state, nonce), 1, null, ADMIN_COMMAND),
    );
    expect(status(renderer).props.children).toBe(text);
    expect(status(renderer).props["data-shell-run-elevation-state"]).toBe(state);
    expect(renderer.root.findAllByProps({ "data-shell-run-copy": "" }).length > 0).toBe(
      state === "unavailable",
    );
  });

  it("does not let a command's own output pose as a state", async () => {
    const { renderer, nonce, show } = await startedRun();
    // Printed by the block after it ran: no secret, a wrong one, and the right one too late.
    await show(
      exitedSession(
        marker("waiting", nonce) +
          marker("started", nonce) +
          "\u001b]7717;elevation=cancelled\u0007" +
          marker("cancelled", "x".repeat(24)) +
          marker("cancelled", nonce),
        0,
        null,
        ADMIN_COMMAND,
      ),
    );
    expect(status(renderer).props.children).toBe("Exit 0");

    // A run this window did not start has no secret here: its markers are only output.
    const other = "sudo ls /private/var/root";
    showSession(other, exitedSession(marker("cancelled", nonce), 0, null, other));
    const viewer = await render(fence(other), target("full-access"));
    expect(status(viewer).props.children).toBe("Exit 0");
  });

  it("on Linux asks first without promising a macOS prompt", async () => {
    machine.os = "linux";
    const renderer = await render(fence(ADMIN_COMMAND), target("full-access"));
    await clickRun(renderer);
    const row = allText(renderer.root.findByProps({ "data-shell-run": "confirm" }));
    expect(row).toContain("Runs as administrator on MacBook M4MAX");
    expect(row).not.toContain("macOS will ask");
    expect(renderer.root.findAllByProps({ "data-shell-run-terminal-app": "" })).toHaveLength(0);
    await confirm(renderer);
    // The server still decides: it runs the block only if sudo needs no password there.
    expect(lastOpenInput()).toHaveProperty("elevation");

    const script = "./install.sh";
    showSession(script, waitingSession(script, "Password:"));
    const stuck = await render(fence(script), target("full-access"));
    expect(stuck.root.findAllByProps({ "data-shell-run-prompt": "" })).toHaveLength(0);
    expect(allText(stuck.root.findByProps({ "data-shell-run-note": "password" }))).toContain(
      "This needs an administrator password. Run it in a terminal on MacBook M4MAX.",
    );
  });

  it("says the output stays in Terminal, which has its own Full Disk Access switch", async () => {
    const renderer = await render(fence(ADMIN_COMMAND), target("full-access"));
    await clickRun(renderer);
    await act(async () => button(renderer, "Open in Terminal").onClick?.({} as never));
    const nonce = (lastOpenInput().elevation as { nonce: string }).nonce;
    showSession(
      ADMIN_COMMAND,
      exitedSession(marker("terminal-app", nonce), 0, null, ADMIN_COMMAND),
    );
    await act(async () => renderer.update(tree(fence(ADMIN_COMMAND), target("full-access"))));
    const text = status(renderer).props.children;
    expect(text).toContain("Opened in Terminal on MacBook M4MAX. The output stays there.");
    expect(text).toContain("Terminal has its own Full Disk Access switch");
  });

  it("offers the Mac's prompt when a script inside the block asks for a password", async () => {
    const script = "./install.sh";
    showSession(script, waitingSession(script, "Installing…\r\nPassword:"));
    const renderer = await render(fence(script), target("full-access"));
    const note = renderer.root.findByProps({ "data-shell-run-note": "password" });
    expect(allText(note)).toContain("This command is asking for an administrator password.");
    expect(commands.open).not.toHaveBeenCalled();

    await act(async () =>
      renderer.root.findByProps({ "data-shell-run-prompt": "" }).props.onClick?.({} as never),
    );
    expect(lastOpenInput()).toMatchObject({ command: script, elevation: {} });
  });

  it("replaces the dead end of the November 20 report on a server without the prompt", async () => {
    machine.prompt = false;
    showSession(
      ADMIN_COMMAND,
      exitedSession("Password:\r\nsudo: a password is required\r\n", 1, null, ADMIN_COMMAND),
    );
    const renderer = await render(fence(ADMIN_COMMAND), target("full-access"));
    const note = renderer.root.findByProps({ "data-shell-run-note": "password" });
    expect(allText(note)).toContain(
      "This needs an administrator password. Run it in a terminal on MacBook M4MAX.",
    );
    expect(note.findAllByProps({ "data-shell-run-copy": "" }).length).toBeGreaterThan(0);
  });

  it("explains a file macOS refused, from the machine's Full Disk Access reading", async () => {
    const output =
      "PermissionError: [Errno 1] Operation not permitted: '/Library/Preferences/a.plist'\r\n";
    showSession(ADMIN_COMMAND, exitedSession(output, 1, null, ADMIN_COMMAND));
    const off = await render(fence(ADMIN_COMMAND), target("full-access"));
    const note = off.root.findByProps({ "data-shell-run-note": "protected-file" });
    expect(allText(note)).toContain(
      "macOS blocked a protected file. SpecWithCode does not have Full Disk Access on MacBook M4MAX. Turning it on may not unlock this file.",
    );
    await act(async () => button(off, "Open System Settings").onClick?.({} as never));
    expect(machine.openSettings).toHaveBeenCalledOnce();
    expect(off.root.findByProps({ "data-shell-run-status": "" }).props.children).toBe("Exit 1");

    machine.fullDiskAccess = "allowed";
    const on = await render(fence(ADMIN_COMMAND), target("full-access"));
    expect(allText(on.root.findByProps({ "data-shell-run-note": "protected-file" }))).toContain(
      "macOS blocked this file even for an administrator.",
    );
    expect(
      buttons(on).some((b) => textOf(b.props.children as ReactNode) === "Open System Settings"),
    ).toBe(false);

    showSession(ADMIN_COMMAND, exitedSession(output, 0, null, ADMIN_COMMAND));
    const passed = await render(fence(ADMIN_COMMAND), target("full-access"));
    expect(passed.root.findAllByProps({ "data-shell-run-note": "protected-file" })).toHaveLength(0);

    // A block that never ran as administrator is not told it did.
    const plain = "ls ~/Library/Mail";
    showSession(plain, exitedSession("ls: Mail: Operation not permitted\r\n", 1, null, plain));
    const reader = await render(fence(plain), target("full-access"));
    const plainNote = allText(reader.root.findByProps({ "data-shell-run-note": "protected-file" }));
    expect(plainNote).toContain("macOS blocked a protected file.");
    expect(plainNote).not.toContain("administrator");
  });

  it("resets pending confirmation and error when a reused component changes command or target", async () => {
    const renderer = await render(fence(ADMIN_COMMAND), target("full-access"));
    await clickRun(renderer);
    expect(renderer.root.findAllByProps({ "data-shell-run": "confirm" })).toHaveLength(1);

    await act(async () => renderer.update(tree(fence("echo hello"), target("full-access"))));
    expect(renderer.root.findAllByProps({ "data-shell-run": "confirm" })).toHaveLength(0);

    commands.open.mockResolvedValueOnce(Exit.die(new Error("old open failed")) as never);
    await clickRun(renderer);
    expect(allText(renderer.root)).toContain("old open failed");

    await act(async () =>
      renderer.update(
        tree(fence("echo hello"), {
          ...target("full-access"),
          threadId: ThreadId.make("thread-2"),
        }),
      ),
    );
    expect(allText(renderer.root)).not.toContain("old open failed");
  });

  it("ignores stale in-flight openTerminal outcomes after the command changes", async () => {
    let resolveFirst!: (value: unknown) => void;
    commands.open.mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          resolveFirst = resolve;
        }) as never,
    );

    const renderer = await render(fence("echo first"), target("full-access"));
    const firstClick = act(async () => {
      button(renderer, "Run command").onClick?.({} as never);
    });
    await act(async () => renderer.update(tree(fence("echo second"), target("full-access"))));

    resolveFirst(Exit.die(new Error("stale failure")));
    await firstClick;
    expect(allText(renderer.root)).not.toContain("stale failure");
    expect(renderer.root.findAllByProps({ "data-shell-run-status": "" })).toHaveLength(0);
  });
});
