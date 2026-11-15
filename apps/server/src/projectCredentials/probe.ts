// @effect-diagnostics nodeBuiltinImport:off - spawns one pinned tool with a fixed environment.
/**
 * Whether this machine has a credential, asked of the tool that owns it. The
 * command comes from the catalog and is pinned on every side a project or the
 * server's own environment could bend it:
 *
 * - the tool is found by absolute path in a fixed list of folders, never by
 *   name through `PATH`, and never inside a project folder;
 * - it runs in the home folder, so no project file configures it;
 * - its environment is built here from a short list, so an inherited
 *   `KUBECONFIG`, `GH_CONFIG_DIR`, `AZURE_CONFIG_DIR` or `NODE_OPTIONS` cannot
 *   point it at other state or other code;
 * - nothing it prints is kept: the answer is one of four words.
 *
 * Checks are few and cached, because sign-in state says which services a
 * person uses and a tool that hangs should not stall the machine.
 */
import * as NodeChildProcess from "node:child_process";
import * as NodeFS from "node:fs";
import * as NodeFSP from "node:fs/promises";
import * as NodePath from "node:path";

import type {
  ProjectCredentialId,
  ProjectCredentialProbe,
  ProjectCredentialStatus,
} from "@specweave-studio/contracts";

import { CREDENTIAL_CATALOG, type CredentialProbe, credentialEntry, signInCommand } from "./catalog.ts";

export const PROBE_TIMEOUT_MS = 10_000;
export const PROBE_CACHE_MS = 60_000;
export const PROBE_BATCHES_PER_MINUTE = 6;

/** Environment variables a tool may inherit: who and where, never which config or code. */
const INHERITED = ["USER", "LOGNAME", "LANG", "LC_ALL", "TMPDIR", "XDG_RUNTIME_DIR", "DBUS_SESSION_BUS_ADDRESS"];

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
};

/** Where command-line tools are installed, in the order they are searched. */
export function probeFolders(input: {
  readonly platform: NodeJS.Platform;
  readonly home: string;
  /** Folders the app installed tools into (its own gh). */
  readonly managed: ReadonlyArray<string>;
}): Array<string> {
  if (input.platform === "win32") return [];
  const system =
    input.platform === "darwin"
      ? ["/opt/homebrew/bin", "/usr/local/bin", "/usr/bin", "/bin"]
      : ["/usr/local/bin", "/usr/bin", "/bin", "/snap/bin", "/home/linuxbrew/.linuxbrew/bin"];
  return [
    ...system,
    NodePath.join(input.home, ".local", "bin"),
    NodePath.join(input.home, "google-cloud-sdk", "bin"),
    ...input.managed,
  ];
}

export function probeEnvironment(input: {
  readonly home: string;
  readonly folders: ReadonlyArray<string>;
  readonly inherited: Readonly<Record<string, string | undefined>>;
}): Record<string, string> {
  const env: Record<string, string> = {
    ...FIXED_ENV,
    HOME: input.home,
    PATH: input.folders.join(NodePath.delimiter),
  };
  for (const name of INHERITED) {
    const value = input.inherited[name];
    if (value !== undefined && value !== "") env[name] = value;
  }
  return env;
}

const inside = (root: string, value: string) => {
  const relative = NodePath.relative(root, value);
  return relative === "" || (!relative.startsWith("..") && !NodePath.isAbsolute(relative));
};

/**
 * The tool's real path, from the first folder that has it. A copy whose real
 * location is inside one of `projectRoots` is passed over: a project never
 * supplies the tool that is asked about the person's sign-ins.
 */
export async function resolveProbeBinary(
  binary: string,
  folders: ReadonlyArray<string>,
  projectRoots: ReadonlyArray<string>,
): Promise<string | null> {
  if (binary.includes("/") || binary.includes("\\")) return null;
  for (const folder of folders) {
    const real = await NodeFSP.realpath(NodePath.join(folder, binary)).catch(() => null);
    if (real === null) continue;
    if (projectRoots.some((root) => inside(root, real))) continue;
    const usable = await NodeFSP.stat(real)
      .then((stat) => stat.isFile())
      .catch(() => false);
    if (!usable) continue;
    const executable = await NodeFSP.access(real, NodeFS.constants.X_OK).then(
      () => true,
      () => false,
    );
    if (executable) return real;
  }
  return null;
}

export interface ProbeRun {
  readonly exitCode: number | null;
  readonly printed: boolean;
  readonly timedOut: boolean;
}

export type ProbeSpawn = (
  path: string,
  args: ReadonlyArray<string>,
  options: { readonly cwd: string; readonly env: Record<string, string>; readonly timeoutMs: number },
) => Promise<ProbeRun>;

/** Runs the tool with no shell and no terminal; what it prints is counted, not kept. */
export const spawnProbe: ProbeSpawn = (path, args, options) =>
  new Promise<ProbeRun>((resolve) => {
    let printed = false;
    let timedOut = false;
    const child = NodeChildProcess.spawn(path, [...args], {
      cwd: options.cwd,
      env: options.env,
      shell: false,
      stdio: ["ignore", "pipe", "ignore"],
      windowsHide: true,
    });
    const timer = setTimeout(() => {
      timedOut = true;
      child.kill("SIGKILL");
    }, options.timeoutMs);
    child.stdout?.on("data", (chunk: Buffer) => {
      if (!printed && chunk.toString("latin1").trim() !== "") printed = true;
    });
    child.on("error", () => {
      clearTimeout(timer);
      resolve({ exitCode: null, printed: false, timedOut });
    });
    child.on("close", (code) => {
      clearTimeout(timer);
      resolve({ exitCode: code, printed, timedOut });
    });
  });

export function statusOf(probe: CredentialProbe, run: ProbeRun): ProjectCredentialStatus {
  if (run.timedOut || run.exitCode === null) return "unknown";
  if (run.exitCode !== 0) return "not_signed_in";
  return probe.readyWhen === "output" && !run.printed ? "not_signed_in" : "ready";
}

export interface ProbeMachine {
  readonly platform: NodeJS.Platform;
  readonly home: string;
  readonly folders: ReadonlyArray<string>;
  readonly projectRoots: ReadonlyArray<string>;
  readonly inherited: Readonly<Record<string, string | undefined>>;
  readonly spawn: ProbeSpawn;
}

/** One credential's status on this machine. An id outside the catalog is the caller's error. */
export async function probeCredential(
  machine: ProbeMachine,
  id: ProjectCredentialId,
): Promise<ProjectCredentialStatus> {
  const probe = credentialEntry(id)?.probe ?? null;
  if (probe === null || machine.platform === "win32") return "unknown";
  const path = await resolveProbeBinary(probe.binary, machine.folders, machine.projectRoots);
  if (path === null) return "tool_missing";
  const run = await machine.spawn(path, probe.args, {
    cwd: machine.home,
    env: probeEnvironment(machine),
    timeoutMs: PROBE_TIMEOUT_MS,
  });
  return statusOf(probe, run);
}

export class ProbeBusy extends Error {}

/**
 * One batch of checks at a time per machine, answers kept for a minute, and a
 * cap on how many batches run in a minute. What is cached is the status word.
 */
export class ProbeGate {
  private readonly cache = new Map<ProjectCredentialId, { status: ProjectCredentialStatus; at: number }>();
  private readonly batches: Array<number> = [];
  private tail: Promise<unknown> = Promise.resolve();
  private readonly now: () => number;

  constructor(now: () => number = Date.now) {
    this.now = now;
  }

  run(
    machine: ProbeMachine,
    ids: ReadonlyArray<ProjectCredentialId>,
    fresh: boolean,
  ): Promise<Array<ProjectCredentialProbe>> {
    const next = this.tail.then(() => this.batch(machine, ids, fresh));
    this.tail = next.catch(() => undefined);
    return next;
  }

  private async batch(
    machine: ProbeMachine,
    ids: ReadonlyArray<ProjectCredentialId>,
    fresh: boolean,
  ): Promise<Array<ProjectCredentialProbe>> {
    const wanted = [...new Set(ids)];
    const now = this.now();
    const stale = wanted.filter((id) => {
      const hit = this.cache.get(id);
      return fresh || hit === undefined || now - hit.at >= PROBE_CACHE_MS;
    });
    // Only credentials with a check cost a run; the rest answer at once.
    const toRun = stale.filter(
      (id) => credentialEntry(id)?.probe !== null && machine.platform !== "win32",
    );
    if (toRun.length > 0) {
      while (this.batches.length > 0 && now - this.batches[0]! >= 60_000) this.batches.shift();
      if (this.batches.length >= PROBE_BATCHES_PER_MINUTE)
        throw new ProbeBusy("This machine was checked several times in the last minute. Try again in a minute.");
      this.batches.push(now);
      const statuses = await Promise.all(toRun.map((id) => probeCredential(machine, id)));
      for (const [index, id] of toRun.entries())
        this.cache.set(id, { status: statuses[index]!, at: this.now() });
    }
    return wanted.map((id) => {
      const entry = CREDENTIAL_CATALOG.find((item) => item.id === id)!;
      return {
        id,
        status: this.cache.get(id)?.status ?? "unknown",
        signIn: signInCommand(entry, machine.platform),
        check: entry.check,
      };
    });
  }
}
