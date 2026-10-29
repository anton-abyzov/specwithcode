// @effect-diagnostics nodeBuiltinImport:off globalDate:off globalTimers:off - gh runs in a PTY driven by Node callbacks and timers.
/**
 * Signs this machine's GitHub CLI in for a person using another device. The
 * machine's own server runs `gh auth login --web` in a PTY, answers its
 * prompts, and publishes only the one-time code and GitHub's device page; the
 * person approves the code in a browser on the device they use. gh stores the
 * credential here, so nothing crosses machines, and the transcript never
 * leaves this module: errors carry a few scrubbed lines at most.
 */
import * as NodeCrypto from "node:crypto";
import * as NodeOS from "node:os";
import * as NodeUtil from "node:util";

import type { GitHubSignInState, MachineReadinessGitHub } from "@specweave-studio/contracts";

import { scrubDetail } from "../fleet/MachineReadiness.ts";
import type { PtyProcess, PtySpawnInput } from "../terminal/PtyAdapter.ts";

export const GITHUB_SIGN_IN_HOST = "github.com";
/** GitHub expires a device code after 15 minutes; gh stops polling then too. */
const DEFAULT_TIMEOUT_MS = 15 * 60_000;
const TRANSCRIPT_LIMIT = 16_384;

export const GH_OUTDATED_MESSAGE =
  "The GitHub CLI on this machine is too old to report its sign-in. Update gh there (specwithcode provision updates it), then sign in.";

export const GH_HELD_LOGIN_MESSAGE =
  "gh on this machine holds a github.com login that no longer works. SpecWithCode leaves it as it is; run gh auth login there to replace it, or copy a sign-in instead.";

export const GH_ALREADY_SIGNED_IN_MESSAGE =
  "gh on this machine already holds a GitHub login, so it was left as it is.";

/**
 * GH_BROWSER is split like a shell command and run with the URL appended (go-gh
 * pkg/browser), so these open nothing: `true <url>`, and on Windows `cmd /c rem <url>`.
 */
export const noopBrowser = (platform: NodeJS.Platform) =>
  platform === "win32" ? "cmd /c rem" : "true";

export const GH_NOT_INSTALLED_MESSAGE =
  "The GitHub CLI is not installed on this machine. Run specwithcode provision there, then try again.";

export interface GitHubSignInDeps {
  /** Spawns gh in a PTY; rejects when it cannot start. */
  readonly spawn: (input: PtySpawnInput) => Promise<PtyProcess>;
  /** This machine's gh sign-in, as Check readiness reports it. */
  readonly authStatus: () => Promise<MachineReadinessGitHub>;
  /** `gh auth login --help` output, or null when gh did not answer. */
  readonly loginHelp: () => Promise<string | null>;
  /** The server's own environment; gh reads its PATH, HOME and config from it. */
  readonly env: NodeJS.ProcessEnv;
  readonly platform: NodeJS.Platform;
  readonly cwd?: string;
  readonly timeoutMs?: number;
  readonly now?: () => number;
  readonly newFlowId?: () => string;
}

export interface GitHubSignIn {
  /** Starts a sign-in, or returns the one already running. */
  readonly start: () => Promise<GitHubSignInState>;
  readonly status: () => GitHubSignInState;
  readonly cancel: (flowId?: string) => GitHubSignInState;
}

const IDLE: GitHubSignInState = {
  flowId: null,
  phase: "idle",
  host: GITHUB_SIGN_IN_HOST,
  deviceCode: null,
  login: null,
  alreadySignedIn: false,
  failure: null,
  message: null,
  expiresAt: null,
};

const ACTIVE_PHASES = new Set<GitHubSignInState["phase"]>(["starting", "waiting", "verifying"]);

/** Parse only gh's own device prompt; never infer a code from arbitrary output. */
export function readGhDeviceCode(
  transcript: string,
  host: string = GITHUB_SIGN_IN_HOST,
): { readonly userCode: string; readonly url: string } | undefined {
  const text = NodeUtil.stripVTControlCharacters(transcript.slice(-TRANSCRIPT_LIMIT));
  const codes = [...text.matchAll(/one-time code: ([A-Z0-9]{4}-[A-Z0-9]{4})(?=\s|$)/gu)];
  const userCode = codes.at(-1)?.[1];
  if (!userCode) return undefined;
  // gh names the page in its prompt on newer versions; older ones only say "github.com".
  let url = `https://${host}/login/device`;
  for (const match of text.matchAll(/https:\/\/[^\s"'<>]{1,2048}/gu)) {
    try {
      const parsed = new URL(match[0].replace(/[.,;:]+$/u, ""));
      if (
        parsed.protocol === "https:" &&
        parsed.hostname === host &&
        !parsed.port &&
        !parsed.username &&
        !parsed.password &&
        parsed.pathname === "/login/device" &&
        !parsed.search &&
        !parsed.hash
      )
        url = parsed.href;
    } catch {
      /* Not a URL gh would print for the device page. */
    }
  }
  return { userCode, url };
}

/** The flags gh gets: a browser sign-in for github.com, Git over HTTPS, no SSH key upload. */
export function ghLoginArgs(help: string | null): Array<string> {
  return [
    "auth",
    "login",
    "--hostname",
    GITHUB_SIGN_IN_HOST,
    "--git-protocol",
    "https",
    "--web",
    ...(help?.includes("--skip-ssh-key") ? ["--skip-ssh-key"] : []),
  ];
}

/** What gh asks before and after printing the code, and the keys that keep it moving. */
const PROMPTS: ReadonlyArray<{
  readonly id: string;
  readonly pattern: RegExp;
  readonly keys: string;
}> = [
  // The default (yes) runs `gh auth setup-git`, so git on this machine uses the new login.
  { id: "setup-git", pattern: /Authenticate Git with your GitHub credentials\?/u, keys: "\r" },
  // A headless machine cannot open a browser; gh keeps polling after Enter either way.
  { id: "open-browser", pattern: /Press Enter to open /u, keys: "\r" },
];

/** Older gh asks before replacing a login it holds. It is never answered: the flow stops. */
const REAUTH_PROMPT = /Do you want to re-authenticate\?/u;

/** A short, scrubbed reason from gh's output for a failed sign-in. */
export function ghFailureMessage(transcript: string): string {
  const text = NodeUtil.stripVTControlCharacters(transcript);
  if (/GH_TOKEN|GITHUB_TOKEN/u.test(text) && /environment variable/iu.test(text))
    return "A GitHub token variable (GH_TOKEN or GITHUB_TOKEN) is set for the server on this machine, so gh will not store another login. Unset it there, or save a token in Settings instead.";
  if (/expired/iu.test(text))
    return "The one-time code expired before GitHub confirmed it. Start again.";
  if (/access_denied|denied/iu.test(text))
    return "GitHub sign-in was denied in the browser. Start again to retry.";
  const lines = text
    .split(/\r?\n/u)
    .map((line) => line.trim())
    .filter(
      (line) =>
        line &&
        !/one-time code|Press Enter|Failed opening a web browser|in your browser manually|exec: /u.test(
          line,
        ),
    )
    .slice(-3)
    .join("\n");
  const detail = scrubDetail(lines);
  return detail
    ? `gh could not finish signing in: ${detail}`
    : "gh could not finish signing in. Start again.";
}

export function makeGitHubSignIn(deps: GitHubSignInDeps): GitHubSignIn {
  const now = deps.now ?? Date.now;
  const timeoutMs = deps.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const newFlowId = deps.newFlowId ?? (() => NodeCrypto.randomUUID());
  let state: GitHubSignInState = IDLE;
  /** Kills the current flow's gh and clears its timer. */
  let stop: (() => void) | undefined;

  const isActive = (flowId: string) => state.flowId === flowId && ACTIVE_PHASES.has(state.phase);
  const set = (flowId: string, patch: Partial<GitHubSignInState>) => {
    // A finished or replaced flow never overwrites the current one.
    if (!isActive(flowId)) return;
    state = { ...state, ...patch };
    if (!ACTIVE_PHASES.has(state.phase)) {
      const finish = stop;
      stop = undefined;
      finish?.();
    }
  };

  const signedInLogin = (github: MachineReadinessGitHub) =>
    github.status === "signed-in"
      ? (github.accounts.find((account) => account.host === GITHUB_SIGN_IN_HOST)?.login ?? null)
      : null;

  const run = async (flowId: string, onSpawned: (pty: PtyProcess, detach: () => void) => void) => {
    const before = await deps.authStatus().catch(() => null);
    if (before?.status === "not-installed")
      return set(flowId, {
        phase: "failed",
        failure: "not-installed",
        message: GH_NOT_INSTALLED_MESSAGE,
      });
    if (before?.status === "unknown" && before.outdated === true)
      return set(flowId, { phase: "failed", failure: "outdated", message: GH_OUTDATED_MESSAGE });
    const existing = before ? signedInLogin(before) : null;
    if (existing)
      return set(flowId, { phase: "succeeded", login: existing, alreadySignedIn: true });
    // A broken login is still gh's; `gh auth login` would replace it.
    if (before?.heldHosts?.includes(GITHUB_SIGN_IN_HOST))
      return set(flowId, { phase: "failed", failure: "failed", message: GH_HELD_LOGIN_MESSAGE });

    const help = await deps.loginHelp().catch(() => null);
    if (!isActive(flowId)) return;
    const env: NodeJS.ProcessEnv = {
      ...deps.env,
      // Never let gh print a token into a debug log or color its prompts.
      GH_DEBUG: "",
      NO_COLOR: "1",
      GH_NO_UPDATE_NOTIFIER: "1",
    };
    env.TERM ||= "xterm-256color";
    // gh must prompt, so a server-wide GH_PROMPT_DISABLED does not apply here.
    delete env.GH_PROMPT_DISABLED;
    // The person opens the page on their own device, so gh must not open one here.
    env.GH_BROWSER = noopBrowser(deps.platform);

    let pty: PtyProcess;
    try {
      pty = await deps.spawn({
        shell: "gh",
        args: ghLoginArgs(help),
        cwd: deps.cwd ?? NodeOS.homedir(),
        cols: 120,
        rows: 30,
        env,
      });
    } catch (cause) {
      const missing = /ENOENT|not found/iu.test(
        String((cause as { cause?: unknown } | null)?.cause ?? cause),
      );
      return set(flowId, {
        phase: "failed",
        failure: missing ? "not-installed" : "unavailable",
        message: missing
          ? GH_NOT_INSTALLED_MESSAGE
          : "The GitHub CLI could not be started on this machine.",
      });
    }

    let transcript = "";
    const answered = new Set<string>();
    const detachData = pty.onData((data) => {
      transcript = (transcript + data).slice(-TRANSCRIPT_LIMIT);
      const text = NodeUtil.stripVTControlCharacters(transcript);
      // Answering would replace a login gh holds; stop gh and say so instead.
      if (REAUTH_PROMPT.test(text))
        return set(flowId, {
          phase: "succeeded",
          alreadySignedIn: true,
          message: GH_ALREADY_SIGNED_IN_MESSAGE,
        });
      for (const prompt of PROMPTS) {
        if (answered.has(prompt.id) || !prompt.pattern.test(text)) continue;
        answered.add(prompt.id);
        try {
          pty.write(prompt.keys);
        } catch {
          /* gh may already have exited. */
        }
      }
      const deviceCode = readGhDeviceCode(transcript);
      if (deviceCode && state.deviceCode?.userCode !== deviceCode.userCode)
        set(flowId, { phase: "waiting", deviceCode });
    });
    const detachExit = pty.onExit(({ exitCode }) => {
      if (exitCode !== 0)
        return set(flowId, {
          phase: "failed",
          failure: "failed",
          message: ghFailureMessage(transcript),
        });
      set(flowId, { phase: "verifying" });
      void deps
        .authStatus()
        .catch(() => null)
        .then((after) => {
          const login = after ? signedInLogin(after) : null;
          // gh finished cleanly; a gh that cannot report its login is trusted, without a name.
          set(
            flowId,
            login || after === null || after.status === "unknown"
              ? { phase: "succeeded", login }
              : {
                  phase: "failed",
                  failure: "failed",
                  message: "gh finished, but this machine still reports no GitHub sign-in.",
                },
          );
        });
    });
    onSpawned(pty, () => {
      detachData();
      detachExit();
    });
  };

  return {
    start: async () => {
      if (ACTIVE_PHASES.has(state.phase)) return state;
      const flowId = newFlowId();
      state = { ...IDLE, flowId, phase: "starting", expiresAt: now() + timeoutMs };
      let pty: PtyProcess | undefined;
      let detach: (() => void) | undefined;
      const timer = setTimeout(() => {
        // Once gh exited the login may already be stored, so verifying runs to its end.
        if (state.flowId === flowId && state.phase === "verifying") return;
        set(flowId, {
          phase: "failed",
          failure: "timeout",
          message: "The one-time code expired before GitHub confirmed it. Start again.",
        });
      }, timeoutMs);
      timer.unref?.();
      stop = () => {
        clearTimeout(timer);
        detach?.();
        try {
          pty?.kill();
        } catch {
          /* The login process may already have exited. */
        }
      };
      void run(flowId, (spawned, detachSpawned) => {
        pty = spawned;
        detach = detachSpawned;
        // Cancelled or timed out while gh was starting: stop it now.
        if (!isActive(flowId)) {
          detachSpawned();
          spawned.kill();
        }
      }).catch(() =>
        set(flowId, {
          phase: "failed",
          failure: "unavailable",
          message: "The GitHub sign-in could not run on this machine.",
        }),
      );
      return state;
    },
    status: () => state,
    cancel: (flowId) => {
      // Once gh exited, the login may already be stored, so verifying runs to its end.
      if (
        state.flowId !== null &&
        (state.phase === "starting" || state.phase === "waiting") &&
        (flowId === undefined || flowId === state.flowId)
      )
        set(state.flowId, { phase: "cancelled", message: "Sign-in cancelled." });
      return state;
    },
  };
}
