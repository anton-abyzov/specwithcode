// @effect-diagnostics nodeBuiltinImport:off - spawns one pinned tool with a fixed environment.
// @effect-diagnostics globalTimers:off - the timeout that stops a hung tool.
/**
 * Whether this machine has a credential, asked of the tool that owns it. The
 * command comes from the catalog and is pinned on every side a project or the
 * server's own environment could bend it:
 *
 * - the tool is found by absolute path in the folders a new Terminal window
 *   searches plus the app's own, never by name through `PATH`, and a copy
 *   whose real place is inside any registered project is passed over;
 * - the `PATH` it gets holds none of a registered project's folders, so the
 *   `node` or `python` a script tool looks up is not the project's either;
 * - a project's own copy of a tool (its `node_modules/.bin`) runs only when
 *   the person asked for the check, never when the list opens;
 * - it runs in the home folder, so no project file configures it;
 * - its environment is built here from a short list, so an inherited
 *   `KUBECONFIG`, `GH_CONFIG_DIR`, `AZURE_CONFIG_DIR` or `NODE_OPTIONS` cannot
 *   point it at other state or other code. From the person's Terminal it
 *   gets how to reach the network, their key agent, and the sign-in
 *   variables that one tool reads (a `CLOUDFLARE_API_TOKEN` for wrangler):
 *   a person signed in that way in Terminal is signed in here;
 * - nothing it prints is kept: the answer is one of four words.
 *
 * Checks are few and cached, because sign-in state says which services a
 * person uses and a tool that hangs should not stall the machine.
 */
import * as NodeChildProcess from "node:child_process";
import * as NodePath from "node:path";

import {
  PROJECT_CREDENTIAL_SSH_HOSTS,
  type ProjectCredentialId,
  type ProjectCredentialProbe,
  type ProjectCredentialSshHost,
  type ProjectCredentialStatus,
} from "@specweave-studio/contracts";

import {
  type CredentialProbe,
  credentialEntry,
  signInCommand,
  SSH_GIT_HOSTS,
  TERMINAL_NETWORK_VARIABLES,
} from "./catalog.ts";
import {
  describeTool,
  findTool,
  hasSignInFile,
  locateTool,
  resolveProbeBinary,
  type ToolMachine,
} from "./tool.ts";

export { resolveProbeBinary };

export const PROBE_TIMEOUT_MS = 10_000;
export const PROBE_CACHE_MS = 60_000;
/** How many times a minute opening the list may run tools. */
export const PROBE_BATCHES_PER_MINUTE = 6;
/** How many times a minute a person's own "Check again" may: one click per row and to spare. */
export const PROBE_CLICKS_PER_MINUTE = 30;

/** Environment variables a tool may inherit: who and where, never which config or code. */
const INHERITED = [
  "USER",
  "LOGNAME",
  "LANG",
  "LC_ALL",
  "TMPDIR",
  "XDG_RUNTIME_DIR",
  "DBUS_SESSION_BUS_ADDRESS",
  // The agent that holds the person's SSH keys; their Terminal's own, when read, replaces it.
  "SSH_AUTH_SOCK",
];

/** Set for every probe: no prompts, no telemetry, no update checks. */
const FIXED_ENV: Readonly<Record<string, string>> = {
  GH_PROMPT_DISABLED: "1",
  GH_NO_UPDATE_NOTIFIER: "1",
  GIT_TERMINAL_PROMPT: "0",
  CLOUDSDK_CORE_DISABLE_PROMPTS: "1",
  CLOUDSDK_COMPONENT_MANAGER_DISABLE_UPDATE_CHECK: "1",
  AZURE_CORE_COLLECT_TELEMETRY: "0",
  AWS_PAGER: "",
  NO_COLOR: "1",
  WRANGLER_SEND_METRICS: "false",
  NPM_CONFIG_UPDATE_NOTIFIER: "false",
  NPM_CONFIG_FUND: "false",
};

/**
 * Where command-line tools are looked for, in order: the folders a new
 * Terminal window searches (the person's own PATH, so a check finds what they
 * find), then system folders and the folders the app installed tools into.
 * Every folder is absolute: a relative PATH entry would be read against
 * whatever folder a tool happens to run in.
 */
export function probeFolders(input: {
  readonly platform: NodeJS.Platform;
  /** Folders the app installed tools into (its own gh), and its commands folder. */
  readonly managed: ReadonlyArray<string>;
  /** The login shell's PATH folders; none when it could not be read. */
  readonly terminal?: ReadonlyArray<string>;
}): Array<string> {
  if (input.platform === "win32") return [];
  const system =
    input.platform === "darwin"
      ? ["/opt/homebrew/bin", "/usr/local/bin", "/usr/bin", "/bin"]
      : ["/usr/local/bin", "/usr/bin", "/bin", "/snap/bin", "/home/linuxbrew/.linuxbrew/bin"];
  const folders: Array<string> = [];
  for (const folder of [...(input.terminal ?? []), ...system, ...input.managed])
    if (NodePath.isAbsolute(folder) && !folders.includes(folder)) folders.push(folder);
  return folders;
}

export function probeEnvironment(input: {
  readonly home: string;
  readonly folders: ReadonlyArray<string>;
  readonly inherited: Readonly<Record<string, string | undefined>>;
  /** The person's own `XDG_CONFIG_HOME` from their login shell, so a tool reads the sign-in Terminal wrote. */
  readonly xdgConfigHome?: string | null;
  /** What the person's Terminal has set, by name; only listed names are ever passed on. */
  readonly variables?: Readonly<Record<string, string>>;
  /** The sign-in variables this one tool reads. */
  readonly own?: ReadonlyArray<string>;
}): Record<string, string> {
  const env: Record<string, string> = {
    ...FIXED_ENV,
    HOME: input.home,
    PATH: input.folders.join(NodePath.delimiter),
  };
  if (input.xdgConfigHome != null && NodePath.isAbsolute(input.xdgConfigHome))
    env["XDG_CONFIG_HOME"] = input.xdgConfigHome;
  for (const name of INHERITED) {
    const value = input.inherited[name];
    if (value !== undefined && value !== "") env[name] = value;
  }
  for (const name of [...TERMINAL_NETWORK_VARIABLES, ...(input.own ?? [])]) {
    const value = input.variables?.[name];
    if (value !== undefined && value !== "") env[name] = value;
  }
  return env;
}

export interface ProbeRun {
  readonly exitCode: number | null;
  readonly printed: boolean;
  readonly timedOut: boolean;
  /** Which of the tool's two fixed sentences it printed, when the check goes by them. */
  readonly said?: "signedIn" | "signedOut" | null;
  /** Its error output held the sentence for a refused sign-in, when the check looks for one. */
  readonly refused?: boolean;
}

/** How much of a tool's output is looked through for its two sentences before the rest is ignored. */
const SAYS_MAX_BYTES = 64 * 1024;

export type ProbeSpawn = (
  path: string,
  args: ReadonlyArray<string>,
  options: {
    readonly cwd: string;
    readonly env: Record<string, string>;
    readonly timeoutMs: number;
    /** Look for these two sentences in what the tool prints; only which one was seen is kept. */
    readonly says?: CredentialProbe["says"];
    /** Look for this sentence in the tool's error output; only whether it was seen is kept. */
    readonly refusal?: RegExp;
    /** The name the tool is started under, for one file that serves several names. */
    readonly argv0?: string;
  },
) => Promise<ProbeRun>;

/**
 * Runs the tool with no shell and no terminal; what it prints is counted, not kept.
 * The time limit ends the wait itself: a tool can leave a child holding its output
 * open, and waiting for that output to close would outlast the limit. The tool runs
 * in its own process group so the limit stops what it started too.
 */
export const spawnProbe: ProbeSpawn = (path, args, options) =>
  new Promise<ProbeRun>((resolve) => {
    let printed = false;
    let settled = false;
    // Held only until the tool ends, to find one of a few fixed sentences; never returned.
    let heard = "";
    let complained = "";
    const child = NodeChildProcess.spawn(path, [...args], {
      cwd: options.cwd,
      env: options.env,
      shell: false,
      detached: true,
      // The error output is read only when a check looks for a refusal in it.
      stdio: ["ignore", "pipe", options.refusal === undefined ? "ignore" : "pipe"],
      windowsHide: true,
      ...(options.argv0 === undefined ? {} : { argv0: options.argv0 }),
    });
    const settle = (run: ProbeRun) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve(run);
    };
    const stop = () => {
      try {
        // The whole group: the tool and anything it started.
        if (child.pid !== undefined) process.kill(-child.pid, "SIGKILL");
      } catch {
        child.kill("SIGKILL");
      }
      child.stdout?.destroy();
      child.stderr?.destroy();
    };
    const timer = setTimeout(() => {
      stop();
      settle({ exitCode: null, printed: false, timedOut: true });
    }, options.timeoutMs);
    child.stdout?.on("data", (chunk: Buffer) => {
      const text = chunk.toString("latin1");
      if (!printed && text.trim() !== "") printed = true;
      if (options.says !== undefined && heard.length < SAYS_MAX_BYTES)
        heard += text.slice(0, SAYS_MAX_BYTES - heard.length);
    });
    child.stderr?.on("data", (chunk: Buffer) => {
      if (complained.length < SAYS_MAX_BYTES)
        complained += chunk.toString("latin1").slice(0, SAYS_MAX_BYTES - complained.length);
    });
    child.on("error", () => settle({ exitCode: null, printed: false, timedOut: false }));
    child.on("close", (code) => {
      // Whatever the tool left running goes with it.
      stop();
      const said =
        options.says === undefined
          ? undefined
          : options.says.signedIn.test(heard)
            ? ("signedIn" as const)
            : options.says.signedOut.test(heard)
              ? ("signedOut" as const)
              : null;
      const refused = options.refusal?.test(complained);
      heard = "";
      complained = "";
      settle({
        exitCode: code,
        printed,
        timedOut: false,
        ...(said === undefined ? {} : { said }),
        ...(refused === undefined ? {} : { refused }),
      });
    });
  });

export function statusOf(probe: CredentialProbe, run: ProbeRun): ProjectCredentialStatus {
  if (run.timedOut || run.exitCode === null) return "unknown";
  if (probe.readyWhen === "says") {
    // The tool exits 0 either way: only its own sentence is an answer.
    if (run.said === "signedOut") return "not_signed_in";
    return run.said === "signedIn" && run.exitCode === 0 ? "ready" : "unknown";
  }
  // Where the tool names a refusal, any other failure (offline, a proxy) is no answer.
  if (run.exitCode !== 0)
    return probe.refusal === undefined || run.refused === true ? "not_signed_in" : "unknown";
  return probe.readyWhen === "output" && !run.printed ? "not_signed_in" : "ready";
}

export interface ProbeMachine extends ToolMachine {
  readonly inherited: Readonly<Record<string, string | undefined>>;
  /** What the person's Terminal has set of the variables the checks may pass on. */
  readonly variables: Readonly<Record<string, string>>;
  readonly spawn: ProbeSpawn;
  /** A file that lists the known Git hosts' keys (`knownGitHosts`), or null when none could be written. */
  readonly knownHosts: string | null;
}

/** What the asking window knows about the project, from the machine it came from. */
export interface ProbeContext {
  /** Per credential, project-relative folders said to list its tool as a dependency. */
  readonly packages: ReadonlyMap<ProjectCredentialId, ReadonlyArray<string>>;
  /** Known Git hosts the project reaches over SSH. */
  readonly sshHosts: ReadonlyArray<ProjectCredentialSshHost>;
  /** The person asked for this check: a tool from inside the project may run. */
  readonly projectTools: boolean;
}

export const NO_CONTEXT: ProbeContext = { packages: new Map(), sshHosts: [], projectTools: false };

/** The lines of a `known_hosts` file for the Git hosts an SSH check may contact. */
export const knownGitHosts = () =>
  `${PROJECT_CREDENTIAL_SSH_HOSTS.map((host) => `${host} ${SSH_GIT_HOSTS[host].key}`).join("\n")}\n`;

const SSH_CONNECT_SECONDS = 8;
/** What ssh says when the host took none of the person's keys. 255 alone also means "could not connect". */
const SSH_REFUSAL = /Permission denied/u;

/**
 * `ssh -T git@host` for each known Git host the project reaches over SSH. The
 * exit code is the answer: the host's own code for a key it knows; 255 with
 * ssh's "Permission denied" for one it does not. 255 without it is a host
 * that could not be reached, which is no answer. The host's key is pinned
 * beside the person's own `known_hosts`, so nothing is trusted on first
 * contact and nothing is written.
 */
async function probeSshHosts(
  machine: ProbeMachine,
  hosts: ReadonlyArray<ProjectCredentialSshHost>,
): Promise<{ readonly status: ProjectCredentialStatus; readonly ran: "tool" | "none" }> {
  const known = machine.knownHosts;
  const own = NodePath.join(machine.home, ".ssh", "known_hosts");
  // ssh reads the list as quoted words; a quote in a path would end one early.
  if (hosts.length === 0 || known === null || known.includes('"') || own.includes('"'))
    return { status: "unknown", ran: "none" };
  const ssh = await findTool("ssh", machine.folders, machine.projectRoots, machine.platform);
  if (ssh === null) return { status: "unknown", ran: "none" };
  let refused = false;
  let unsure = false;
  for (const host of hosts) {
    const run = await machine.spawn(
      ssh.real,
      [
        "-T",
        "-o",
        "BatchMode=yes",
        "-o",
        `ConnectTimeout=${SSH_CONNECT_SECONDS}`,
        "-o",
        "StrictHostKeyChecking=yes",
        "-o",
        `UserKnownHostsFile="${own}" "${known}"`,
        "-o",
        "PermitLocalCommand=no",
        "-o",
        "ClearAllForwardings=yes",
        "-o",
        "ForwardAgent=no",
        "-o",
        "ControlMaster=no",
        "-o",
        "LogLevel=ERROR",
        `git@${host}`,
      ],
      {
        cwd: machine.home,
        env: probeEnvironment(machine),
        timeoutMs: PROBE_TIMEOUT_MS,
        refusal: SSH_REFUSAL,
        argv0: "ssh",
      },
    );
    if (run.timedOut || run.exitCode === null) unsure = true;
    else if (run.exitCode === 255 && run.refused === true) refused = true;
    else if (run.exitCode !== SSH_GIT_HOSTS[host].signedIn) unsure = true;
  }
  return { status: refused ? "not_signed_in" : unsure ? "unknown" : "ready", ran: "tool" };
}

/** One credential on this machine: its status, its tool and its commands. An id outside the catalog is the caller's error. */
export async function answerCredential(
  machine: ProbeMachine,
  id: ProjectCredentialId,
  context: ProbeContext = NO_CONTEXT,
): Promise<ProjectCredentialProbe> {
  const entry = credentialEntry(id)!;
  const base = { id, signIn: signInCommand(entry, machine.platform), check: entry.check };
  // Nothing is looked for or run on Windows yet: the row is the person's to check.
  if (machine.platform === "win32") return { ...base, status: "unknown" };
  const hint = async (status: ProjectCredentialStatus) =>
    (status === "unknown" || status === "tool_missing") && (await hasSignInFile(machine, id))
      ? { signInFile: true }
      : {};
  if (id === "ssh") {
    const hosts = [...new Set(context.sshHosts)].filter((host) =>
      Object.hasOwn(SSH_GIT_HOSTS, host),
    );
    const checked = await probeSshHosts(machine, hosts);
    return { ...base, ...checked, ...(await hint(checked.status)) };
  }
  const tool = entry.tool;
  if (tool === null) return { ...base, status: "unknown", ran: "none" };
  const located = await locateTool(machine, tool, context.packages.get(id) ?? []);
  const described = await describeTool(machine, entry, located);
  const probe = entry.probe;
  let status: ProjectCredentialStatus = "unknown";
  let ran: "tool" | "waiting" | "none" = "none";
  if (located.state === "missing") status = probe === null ? "unknown" : "tool_missing";
  else if (probe !== null) {
    // A project's own copy is the project's code: it runs when the person asks, not on open.
    // The file that was checked is the file that runs: a link is not followed a second time.
    const path =
      located.state === "project" ? (located.project?.binReal ?? null) : located.found?.real;
    if (located.state === "project" && !context.projectTools) ran = "waiting";
    else if (path != null) {
      const run = await machine.spawn(path, probe.args, {
        cwd: machine.home,
        env: probeEnvironment({
          ...machine,
          ...(probe.env === undefined ? {} : { own: probe.env }),
        }),
        timeoutMs: PROBE_TIMEOUT_MS,
        // One file can serve several names (a version manager's shim): it is told which.
        argv0: tool.binary,
        ...(probe.says === undefined ? {} : { says: probe.says }),
        ...(probe.refusal === undefined ? {} : { refusal: probe.refusal }),
      });
      status = statusOf(probe, run);
      ran = "tool";
    }
  }
  return {
    ...base,
    status,
    ...(described === null ? {} : { tool: described }),
    ran,
    ...(await hint(status)),
  };
}

/** One credential's status on this machine. */
export const probeCredential = (
  machine: ProbeMachine,
  id: ProjectCredentialId,
  context: ProbeContext = NO_CONTEXT,
): Promise<ProjectCredentialStatus> =>
  answerCredential(machine, id, context).then((answer) => answer.status);

export class ProbeBusy extends Error {}

/** Whether asking about this credential can run a tool, which is what the cap counts. */
const runsATool = (id: ProjectCredentialId, context: ProbeContext) =>
  id === "ssh" ? context.sshHosts.length > 0 : credentialEntry(id)?.probe != null;

/** What an answer depends on besides the machine: a different project is a different answer. */
const contextKey = (id: ProjectCredentialId, context: ProbeContext, projectRoot: string | null) =>
  JSON.stringify([
    id,
    projectRoot,
    context.packages.get(id) ?? [],
    id === "ssh" ? [...context.sshHosts].sort() : [],
    context.projectTools,
  ]);

/**
 * One batch of checks at a time per machine, answers kept for a minute, and a
 * cap on how many batches run in a minute: a small one for opening the list,
 * a larger one for a person's own clicks, so a look at the list never uses
 * up the checks they ask for. What is cached is the answer: a status word,
 * the tool's place and the app's own commands. Each answer says how long ago
 * it was reached, so a kept one is not shown as checked just now.
 */
export class ProbeGate {
  private readonly cache = new Map<string, { answer: ProjectCredentialProbe; at: number }>();
  private readonly batches: Array<number> = [];
  private readonly clicks: Array<number> = [];
  private tail: Promise<unknown> = Promise.resolve();
  private readonly now: () => number;

  constructor(now: () => number = Date.now) {
    this.now = now;
  }

  run(
    machine: ProbeMachine,
    ids: ReadonlyArray<ProjectCredentialId>,
    fresh: boolean,
    context: ProbeContext = NO_CONTEXT,
  ): Promise<Array<ProjectCredentialProbe>> {
    const next = this.tail.then(() => this.batch(machine, ids, fresh, context));
    this.tail = next.catch(() => undefined);
    return next;
  }

  private async batch(
    machine: ProbeMachine,
    ids: ReadonlyArray<ProjectCredentialId>,
    fresh: boolean,
    context: ProbeContext,
  ): Promise<Array<ProjectCredentialProbe>> {
    const wanted = [...new Set(ids)];
    const now = this.now();
    for (const [key, hit] of this.cache) if (now - hit.at >= PROBE_CACHE_MS) this.cache.delete(key);
    const key = (id: ProjectCredentialId) => contextKey(id, context, machine.projectRoot);
    // An answer the person's click got stands when the list opens again within the minute:
    // opening runs nothing more, and the row does not go back to "Check again runs it".
    const clicked = (id: ProjectCredentialId) =>
      context.projectTools
        ? undefined
        : this.cache.get(contextKey(id, { ...context, projectTools: true }, machine.projectRoot));
    const kept = (id: ProjectCredentialId) => clicked(id) ?? this.cache.get(key(id));
    const stale = wanted.filter((id) => fresh || kept(id) === undefined);
    // Only credentials with a check cost a run; the rest answer at once.
    if (machine.platform !== "win32" && stale.some((id) => runsATool(id, context))) {
      const [spent, most] = fresh
        ? [this.clicks, PROBE_CLICKS_PER_MINUTE]
        : [this.batches, PROBE_BATCHES_PER_MINUTE];
      while (spent.length > 0 && now - spent[0]! >= 60_000) spent.shift();
      if (spent.length >= most)
        throw new ProbeBusy(
          "This machine was checked several times in the last minute. Try again in a minute.",
        );
      spent.push(now);
    }
    const answers = await Promise.all(stale.map((id) => answerCredential(machine, id, context)));
    for (const [index, id] of stale.entries())
      this.cache.set(key(id), { answer: answers[index]!, at: this.now() });
    const done = this.now();
    return wanted.map((id) => {
      const hit = (stale.includes(id) ? this.cache.get(key(id)) : kept(id))!;
      return { ...hit.answer, checkedMsAgo: Math.max(0, Math.round(done - hit.at)) };
    });
  }
}
