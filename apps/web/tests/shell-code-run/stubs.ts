// An in-memory terminal standing in for the server: open runs a scripted command,
// write("\u0003") stops it. Exports mirror what InlineShellRun imports.
import {
  applyTerminalAttachStreamEvent,
  combineTerminalSessionState,
  EMPTY_TERMINAL_BUFFER_STATE,
  EMPTY_TERMINAL_SESSION_STATE,
  type TerminalSessionState,
} from "@specweave-studio/client-runtime/state/terminal";
import { useSyncExternalStore } from "react";

interface FakeSession {
  history: string;
  status: "running" | "exited";
  exitCode: number | null;
  timers: ReturnType<typeof setTimeout>[];
}

const sessions = new Map<string, FakeSession>();
const listeners = new Set<() => void>();
let version = 0;
const notify = () => {
  version += 1;
  for (const listener of listeners) listener();
};
const subscribe = (listener: () => void) => {
  listeners.add(listener);
  return () => listeners.delete(listener);
};
const useVersion = () => useSyncExternalStore(subscribe, () => version);
const ok = { _tag: "Success" as const, value: null };

export const terminalEnvironment = {
  open: { label: "terminal open" },
  write: { label: "terminal write" },
  close: { label: "terminal close" },
};

/** Commands the fixture scripts: output lines, then an exit code or nothing (keeps running). */
function script(command: string): { lines: string[]; exitCode: number | null } {
  if (command.includes("sleep")) return { lines: ["Waiting for the dev server…"], exitCode: null };
  if (command.includes("missing"))
    return { lines: ["\u001b[31mls: missing: No such file or directory\u001b[0m"], exitCode: 1 };
  return {
    lines: [
      "Archive:  specwithcode-browser-cws-1.0.0.zip",
      "  inflating: unpacked/manifest.json",
      "  inflating: unpacked/background.js",
      "  inflating: unpacked/icons/icon-128.png",
    ],
    exitCode: 0,
  };
}

function open({ input }: { input: { terminalId: string; command?: string } }) {
  const previous = sessions.get(input.terminalId);
  previous?.timers.forEach(clearTimeout);
  const session: FakeSession = { history: "", status: "running", exitCode: null, timers: [] };
  sessions.set(input.terminalId, session);
  const { lines, exitCode } = script(input.command ?? "");
  lines.forEach((line, index) => {
    session.timers.push(
      setTimeout(
        () => {
          session.history += `${line}\r\n`;
          notify();
        },
        120 * (index + 1),
      ),
    );
  });
  if (exitCode !== null) {
    session.timers.push(
      setTimeout(
        () => {
          session.status = "exited";
          session.exitCode = exitCode;
          notify();
        },
        120 * (lines.length + 1),
      ),
    );
  }
  notify();
  return Promise.resolve(ok);
}

function write({ input }: { input: { terminalId: string; data: string } }) {
  const session = sessions.get(input.terminalId);
  if (session && input.data === "\u0003") {
    session.timers.forEach(clearTimeout);
    session.history += "^C\r\n";
    session.status = "exited";
    session.exitCode = 130;
    notify();
  }
  return Promise.resolve(ok);
}

function close({ input }: { input: { terminalId: string } }) {
  sessions.get(input.terminalId)?.timers.forEach(clearTimeout);
  sessions.delete(input.terminalId);
  notify();
  return Promise.resolve(ok);
}

export function useAtomCommand(command: { label: string }) {
  return command.label === "terminal open"
    ? open
    : command.label === "terminal write"
      ? write
      : close;
}

export function useEnvironmentScope(environmentId: string | null) {
  return environmentId !== null;
}

export function useEnvironment(environmentId: string | null) {
  return environmentId === null ? null : { label: "MacBook M4MAX" };
}

export function useKnownTerminalSessions(input: { environmentId: string | null }) {
  useVersion();
  if (input.environmentId === null) return null;
  return [...sessions.keys()].map((terminalId) => ({ target: { terminalId } }));
}

export function useAttachedTerminalSession(input: {
  terminal: { terminalId: string } | null;
}): TerminalSessionState {
  useVersion();
  const session = input.terminal ? sessions.get(input.terminal.terminalId) : undefined;
  if (!session) return EMPTY_TERMINAL_SESSION_STATE;
  const buffer = applyTerminalAttachStreamEvent(EMPTY_TERMINAL_BUFFER_STATE, {
    type: "snapshot",
    snapshot: {
      threadId: "thread-fixture",
      terminalId: input.terminal!.terminalId,
      cwd: "/Users/me/Projects/specwithcode",
      worktreePath: null,
      status: session.status,
      pid: null,
      history: session.history,
      exitCode: session.exitCode,
      exitSignal: null,
      label: "zsh",
      updatedAt: "2026-10-17T23:55:00.000Z",
    },
  });
  return combineTerminalSessionState(null, buffer);
}
