// @effect-diagnostics globalTimers:off - the flow under test is driven by Node timers.
import type { MachineReadinessGitHub } from "@specweave-studio/contracts";
import { afterEach, beforeEach, describe, expect, it, vi } from "vite-plus/test";

import type { PtyExitEvent, PtyProcess, PtySpawnInput } from "../terminal/PtyAdapter.ts";
import {
  GH_ALREADY_SIGNED_IN_MESSAGE,
  GH_HELD_LOGIN_MESSAGE,
  GH_NOT_INSTALLED_MESSAGE,
  GH_OUTDATED_MESSAGE,
  noopBrowser,
  ghFailureMessage,
  ghLoginArgs,
  makeGitHubSignIn,
  readGhDeviceCode,
  type GitHubSignInDeps,
} from "./GitHubSignIn.ts";

const SIGNED_OUT: MachineReadinessGitHub = { status: "signed-out", accounts: [], detail: null };
const signedIn = (login: string): MachineReadinessGitHub => ({
  status: "signed-in",
  accounts: [{ host: "github.com", login }],
  detail: null,
});

/** A PTY that records what was written and lets the test play gh's side. */
class FakePty implements PtyProcess {
  readonly pid = 4242;
  readonly writes: Array<string> = [];
  killed = false;
  private dataListeners = new Set<(data: string) => void>();
  private exitListeners = new Set<(event: PtyExitEvent) => void>();
  write(data: string) {
    this.writes.push(data);
  }
  resize() {}
  kill() {
    this.killed = true;
  }
  onData(callback: (data: string) => void) {
    this.dataListeners.add(callback);
    return () => this.dataListeners.delete(callback);
  }
  onExit(callback: (event: PtyExitEvent) => void) {
    this.exitListeners.add(callback);
    return () => this.exitListeners.delete(callback);
  }
  emit(data: string) {
    for (const listener of this.dataListeners) listener(data);
  }
  exit(exitCode: number) {
    for (const listener of this.exitListeners) listener({ exitCode, signal: null });
  }
}

// What gh 2.6x prints in a terminal for `auth login --web --git-protocol https`.
const SETUP_GIT_PROMPT =
  "\u001b[0;1;92m?\u001b[0m Authenticate Git with your GitHub credentials? (Y/n) ";
const CODE_LINES =
  "\r\n\u001b[0;33m!\u001b[0m First copy your one-time code: \u001b[1mAB12-CD34\u001b[0m\r\n" +
  "\u001b[1mPress Enter\u001b[0m to open https://github.com/login/device in your browser... ";
const BROWSER_FAILED =
  "\r\n! Failed opening a web browser at https://github.com/login/device\r\n" +
  '  exec: "xdg-open": executable file not found in $PATH\r\n' +
  "  Please try entering the URL in your browser manually\r\n";

let pty: FakePty;
let spawned: Array<PtySpawnInput>;
let statuses: Array<MachineReadinessGitHub>;

const flush = async () => {
  for (let index = 0; index < 5; index += 1) await Promise.resolve();
};

const make = (overrides: Partial<GitHubSignInDeps> = {}) =>
  makeGitHubSignIn({
    spawn: async (input) => {
      spawned.push(input);
      return pty;
    },
    authStatus: async () => statuses.shift() ?? SIGNED_OUT,
    loginHelp: async () => "  --skip-ssh-key   Skip generate/upload SSH key prompt\n  -w, --web",
    env: { PATH: "/usr/bin", GH_PROMPT_DISABLED: "1", GH_TOKEN_FILE: "unused" },
    cwd: "/home/worker",
    platform: "linux",
    timeoutMs: 60_000,
    now: () => 1_000,
    newFlowId: () => "flow-1",
    ...overrides,
  });

beforeEach(() => {
  vi.useFakeTimers();
  pty = new FakePty();
  spawned = [];
  statuses = [SIGNED_OUT];
});
afterEach(() => {
  vi.useRealTimers();
});

describe("readGhDeviceCode", () => {
  it("reads the code and device page from gh's prompt, colors and all", () => {
    expect(readGhDeviceCode(CODE_LINES)).toEqual({
      userCode: "AB12-CD34",
      url: "https://github.com/login/device",
    });
  });

  it("falls back to the github.com device page for older gh, and ignores lookalike hosts", () => {
    expect(
      readGhDeviceCode(
        "! First copy your one-time code: 9Z9Z-1A1A\nPress Enter to open github.com in your browser... https://evil.example/login/device",
      ),
    ).toEqual({ userCode: "9Z9Z-1A1A", url: "https://github.com/login/device" });
  });

  it("never infers a code from arbitrary output", () => {
    expect(readGhDeviceCode("error: code ABCD-1234 is not valid")).toBeUndefined();
    expect(readGhDeviceCode("one-time code: abcd-1234")).toBeUndefined();
  });
});

describe("ghLoginArgs", () => {
  it("adds --skip-ssh-key only when this gh supports it", () => {
    expect(ghLoginArgs("--skip-ssh-key")).toEqual([
      "auth",
      "login",
      "--hostname",
      "github.com",
      "--git-protocol",
      "https",
      "--web",
      "--skip-ssh-key",
    ]);
    expect(ghLoginArgs(null)).not.toContain("--skip-ssh-key");
  });
});

describe("makeGitHubSignIn", () => {
  it("publishes the one-time code, answers gh's prompts and confirms the login after gh exits", async () => {
    statuses = [SIGNED_OUT, signedIn("octo")];
    const flow = make();
    expect((await flow.start()).phase).toBe("starting");
    await flush();
    expect(spawned).toHaveLength(1);
    expect(spawned[0]!.shell).toBe("gh");
    expect(spawned[0]!.args).toContain("--skip-ssh-key");
    expect(spawned[0]!.cwd).toBe("/home/worker");
    // gh must prompt, must not open a browser on this machine and must not log a token.
    expect(spawned[0]!.env.GH_PROMPT_DISABLED).toBeUndefined();
    expect(spawned[0]!.env.GH_BROWSER).toBe("true");
    expect(spawned[0]!.env.GH_DEBUG).toBe("");

    pty.emit(SETUP_GIT_PROMPT);
    expect(pty.writes).toEqual(["\r"]);
    pty.emit(CODE_LINES);
    expect(pty.writes).toEqual(["\r", "\r"]);
    expect(flow.status()).toMatchObject({
      phase: "waiting",
      deviceCode: { userCode: "AB12-CD34", url: "https://github.com/login/device" },
      expiresAt: 61_000,
    });
    // A headless worker cannot open a browser; gh keeps polling and the flow keeps waiting.
    pty.emit(BROWSER_FAILED);
    expect(flow.status().phase).toBe("waiting");
    expect(pty.writes).toHaveLength(2);

    pty.exit(0);
    expect(flow.status().phase).toBe("verifying");
    await flush();
    expect(flow.status()).toMatchObject({ phase: "succeeded", login: "octo", failure: null });
    expect(pty.killed).toBe(true);
  });

  it("returns the running flow instead of starting a second gh", async () => {
    const flow = make();
    await flow.start();
    await flush();
    pty.emit(CODE_LINES);
    const again = await flow.start();
    expect(again.flowId).toBe("flow-1");
    expect(again.deviceCode?.userCode).toBe("AB12-CD34");
    expect(spawned).toHaveLength(1);
  });

  it("reports an existing login without starting gh", async () => {
    statuses = [signedIn("already")];
    const flow = make();
    await flow.start();
    await flush();
    expect(spawned).toHaveLength(0);
    expect(flow.status()).toMatchObject({
      phase: "succeeded",
      login: "already",
      alreadySignedIn: true,
    });
  });

  it("never starts gh auth login while gh holds a github.com login, even a broken one", async () => {
    statuses = [{ ...SIGNED_OUT, heldHosts: ["github.com"] }];
    const flow = make();
    await flow.start();
    await flush();
    expect(spawned).toHaveLength(0);
    expect(flow.status()).toMatchObject({ phase: "failed", message: GH_HELD_LOGIN_MESSAGE });
  });

  it("reports a login that comes from a token variable without starting gh", async () => {
    // gh reports GH_TOKEN as a signed-in github.com account.
    statuses = [signedIn("from-env")];
    const flow = make({ env: { PATH: "/usr/bin", GH_TOKEN: "unused" } });
    await flow.start();
    await flush();
    expect(spawned).toHaveLength(0);
    expect(flow.status()).toMatchObject({ phase: "succeeded", login: "from-env" });
  });

  it("says to run specwithcode provision when gh is not installed", async () => {
    statuses = [{ status: "not-installed", accounts: [], detail: null }];
    const flow = make();
    await flow.start();
    await flush();
    expect(spawned).toHaveLength(0);
    expect(flow.status()).toMatchObject({
      phase: "failed",
      failure: "not-installed",
      message: GH_NOT_INSTALLED_MESSAGE,
    });
    expect(GH_NOT_INSTALLED_MESSAGE).toContain("specwithcode provision");
  });

  it("fails with gh's own reason when it exits non-zero, scrubbing anything token-like", async () => {
    const flow = make();
    await flow.start();
    await flush();
    pty.emit(CODE_LINES);
    pty.emit(
      "\r\nerror: request failed token=gho_abcdefghijklmnop1234 for https://x-access-token:ghp_secret1234567890@github.com\r\n",
    );
    pty.exit(1);
    const state = flow.status();
    expect(state).toMatchObject({ phase: "failed", failure: "failed" });
    expect(state.message).toContain("gh could not finish signing in");
    expect(state.message).not.toMatch(/gho_|ghp_|secret1234/u);
    expect(JSON.stringify(state)).not.toMatch(/gho_|ghp_/u);
    expect(pty.killed).toBe(true);
  });

  it("fails when gh exits cleanly but no login appears", async () => {
    statuses = [SIGNED_OUT, SIGNED_OUT];
    const flow = make();
    await flow.start();
    await flush();
    pty.exit(0);
    await flush();
    expect(flow.status()).toMatchObject({ phase: "failed", failure: "failed" });
  });

  it("kills gh on cancel and ignores a stale client's cancel", async () => {
    const flow = make();
    await flow.start();
    await flush();
    pty.emit(CODE_LINES);
    expect(flow.cancel("another-flow").phase).toBe("waiting");
    expect(pty.killed).toBe(false);
    expect(flow.cancel("flow-1")).toMatchObject({ phase: "cancelled" });
    expect(pty.killed).toBe(true);
    // gh's late exit after the kill changes nothing.
    pty.exit(1);
    expect(flow.status().phase).toBe("cancelled");
  });

  it("kills gh when the code expires", async () => {
    const flow = make();
    await flow.start();
    await flush();
    pty.emit(CODE_LINES);
    vi.advanceTimersByTime(60_000);
    expect(flow.status()).toMatchObject({ phase: "failed", failure: "timeout" });
    expect(pty.killed).toBe(true);
  });

  it("lets a late approval finish verifying when the code expires meanwhile", async () => {
    let confirm: (value: MachineReadinessGitHub) => void = () => {};
    let calls = 0;
    const flow = make({
      authStatus: () =>
        (calls += 1) === 1
          ? Promise.resolve(SIGNED_OUT)
          : new Promise<MachineReadinessGitHub>((resolve) => (confirm = resolve)),
    });
    await flow.start();
    await flush();
    pty.emit(CODE_LINES);
    pty.exit(0);
    expect(flow.status().phase).toBe("verifying");
    vi.advanceTimersByTime(60_000);
    expect(flow.status().phase).toBe("verifying");
    confirm(signedIn("octo"));
    await flush();
    expect(flow.status()).toMatchObject({ phase: "succeeded", login: "octo" });
  });

  it("kills a gh that finishes starting after the flow was cancelled", async () => {
    let release: (value: PtyProcess) => void = () => {};
    const flow = make({ spawn: () => new Promise((resolve) => (release = resolve)) });
    await flow.start();
    await flush();
    flow.cancel();
    release(pty);
    await flush();
    expect(pty.killed).toBe(true);
    expect(flow.status().phase).toBe("cancelled");
  });

  it("starts a fresh flow after a finished one", async () => {
    let id = 0;
    const flow = make({ newFlowId: () => `flow-${(id += 1)}` });
    await flow.start();
    await flush();
    flow.cancel();
    pty = new FakePty();
    expect((await flow.start()).flowId).toBe("flow-2");
  });
});

describe("makeGitHubSignIn with an old gh or a held login", () => {
  it("does not drive a gh too old to report its sign-in; it asks to update it", async () => {
    statuses = [{ status: "unknown", accounts: [], detail: "This gh is too old.", outdated: true }];
    const flow = make();
    await flow.start();
    await flush();
    expect(spawned).toHaveLength(0);
    expect(flow.status()).toMatchObject({
      phase: "failed",
      failure: "outdated",
      message: GH_OUTDATED_MESSAGE,
    });
  });

  it("never answers the re-authenticate prompt: it stops gh and reports the existing login", async () => {
    statuses = [{ status: "unknown", accounts: [], detail: "gh could not be started." }];
    const flow = make();
    await flow.start();
    await flush();
    pty.emit("? You're already logged into github.com. Do you want to re-authenticate? (y/N) ");
    expect(pty.writes).toEqual([]);
    expect(pty.killed).toBe(true);
    expect(flow.status()).toMatchObject({
      phase: "succeeded",
      alreadySignedIn: true,
      login: null,
      message: GH_ALREADY_SIGNED_IN_MESSAGE,
    });
  });

  it("reports success without a name when gh exits 0 but cannot report the login", async () => {
    statuses = [SIGNED_OUT, { status: "unknown", accounts: [], detail: null }];
    const flow = make();
    await flow.start();
    await flush();
    pty.emit(CODE_LINES);
    pty.exit(0);
    await flush();
    expect(flow.status()).toMatchObject({ phase: "succeeded", login: null, failure: null });
  });

  it("ignores cancel once gh exited and the login is being checked", async () => {
    let release: (value: MachineReadinessGitHub) => void = () => {};
    let calls = 0;
    const flow = make({
      authStatus: () =>
        (calls += 1) === 1
          ? Promise.resolve(SIGNED_OUT)
          : new Promise((resolve) => (release = resolve)),
    });
    await flow.start();
    await flush();
    pty.emit(CODE_LINES);
    pty.exit(0);
    expect(flow.status().phase).toBe("verifying");
    expect(flow.cancel("flow-1").phase).toBe("verifying");
    release(signedIn("octo"));
    await flush();
    expect(flow.status()).toMatchObject({ phase: "succeeded", login: "octo" });
  });

  it("uses a browser command that opens nothing on every platform", async () => {
    expect(noopBrowser("linux")).toBe("true");
    expect(noopBrowser("win32")).toBe("cmd /c rem");
    const flow = make({ platform: "win32" });
    await flow.start();
    await flush();
    expect(spawned[0]!.env.GH_BROWSER).toBe("cmd /c rem");
  });
});

describe("ghFailureMessage", () => {
  it("explains an environment token that blocks gh from storing a login", () => {
    expect(
      ghFailureMessage(
        "The value of the GH_TOKEN environment variable is being used for authentication.",
      ),
    ).toContain("GH_TOKEN");
  });

  it("drops the code and browser lines from the reason", () => {
    expect(ghFailureMessage(`${CODE_LINES}${BROWSER_FAILED}error: timed out`)).toBe(
      "gh could not finish signing in: error: timed out",
    );
  });
});
