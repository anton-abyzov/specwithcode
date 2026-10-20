// @effect-diagnostics nodeBuiltinImport:off - the runner is plain async I/O; Effect wraps it at the CLI and RPC edges.
// @effect-diagnostics globalTimers:off - child process deadlines are cleared on every exit path.
// @effect-diagnostics globalFetch:off - verified downloads stream through fetch and a SHA-256 check.
// @effect-diagnostics globalDate:off - timestamps for the state file and log only.
/**
 * Everything the provision runner does to the machine goes through this
 * interface: commands, files and verified downloads. Tests swap in a fake; the
 * Node implementation below is the only one that touches the real system.
 */
import * as NodeChildProcess from "node:child_process";
import * as NodeCrypto from "node:crypto";
import * as NodeFS from "node:fs";
import * as NodeFSP from "node:fs/promises";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";

import { listLoginShellCandidates, readPathFromLoginShell } from "@specweave-studio/shared/shell";

/** The PATH an interactive login shell gives this user: what the server merges in when it starts. */
export function loginShellPath(): string | undefined {
  // oxlint-disable-next-line studio/no-global-process-runtime -- the runner is plain async I/O outside any Effect runtime.
  for (const shell of listLoginShellCandidates(process.platform, process.env.SHELL)) {
    try {
      // An interactive shell without a terminal complains about job control on stderr.
      const value = readPathFromLoginShell(shell, (file, args, options) =>
        NodeChildProcess.execFileSync(file, args, {
          ...options,
          stdio: ["ignore", "pipe", "ignore"],
        }),
      );
      if (value) return value;
    } catch {
      // try the next shell
    }
  }
  return undefined;
}

export interface ExecResult {
  readonly code: number;
  readonly stdout: string;
  readonly stderr: string;
}

export interface ExecOptions {
  readonly timeoutMs?: number;
  readonly env?: Readonly<Record<string, string | undefined>>;
  /** Hand the terminal to the child (a sudo password typed at the machine's own terminal). */
  readonly inheritStdio?: boolean;
  readonly onLine?: (line: string) => void;
}

export interface DownloadOptions {
  readonly sha256: string;
  readonly maxBytes: number;
  readonly onProgress?: (bytes: number) => void;
}

export class ChecksumMismatchError extends Error {
  readonly url: string;
  readonly expected: string;
  readonly actual: string;
  constructor(url: string, expected: string, actual: string) {
    super(
      `SHA-256 mismatch for ${url}: expected ${expected}, got ${actual}. Nothing was installed.`,
    );
    this.url = url;
    this.expected = expected;
    this.actual = actual;
  }
}

export interface ProvisionHost {
  readonly platform: string;
  readonly arch: string;
  readonly home: string;
  readonly user: string;
  readonly uid: number;
  readonly env: Readonly<Record<string, string | undefined>>;
  readonly interactive: boolean;
  exec(command: string, args: ReadonlyArray<string>, options?: ExecOptions): Promise<ExecResult>;
  readText(path: string): Promise<string | null>;
  /** Entry names in a folder; empty when it is missing. */
  listDir(path: string): Promise<string[]>;
  writeText(path: string, text: string, mode?: number): Promise<void>;
  appendText(path: string, text: string, mode?: number): Promise<void>;
  exists(path: string): Promise<boolean>;
  isExecutable(path: string): Promise<boolean>;
  readLink(path: string): Promise<string | null>;
  realPath(path: string): Promise<string | null>;
  mkdirp(path: string): Promise<void>;
  remove(path: string): Promise<void>;
  rename(from: string, to: string): Promise<void>;
  /** Replaces `link` with a symlink to `target` atomically. */
  symlink(target: string, link: string): Promise<void>;
  chmod(path: string, mode: number): Promise<void>;
  /** Downloads to `file`, refusing a body over maxBytes or one whose SHA-256 differs. */
  download(url: string, file: string, options: DownloadOptions): Promise<void>;
  /** Only for Tailscale's macOS package, whose Developer ID the root script checks before installing. */
  downloadSigned(url: string, file: string, maxBytes: number): Promise<void>;
  fetchText(
    url: string,
  ): Promise<{ readonly ok: boolean; readonly status: number; readonly text: string }>;
  sha256File(path: string): Promise<string>;
  sha256Text(text: string): string;
  /** The first executable named `name` on `pathValue`. */
  which(name: string, pathValue: string): Promise<string | null>;
  now(): Date;
}

/**
 * Tests and private mirrors only: `STUDIO_PROVISION_MIRROR_URL` serves every third-party
 * download from `<mirror>/<host>/<path>`. The pinned SHA-256 still decides, so a mirror can
 * only make a run fail, never install something else.
 */
export function mirroredUrl(url: string, mirror: string | undefined): string {
  if (!mirror) return url;
  const base = mirror.replace(/\/+$/u, "");
  if (!base.startsWith("https://") && !/^http:\/\/(127\.0\.0\.1|localhost):\d+$/u.test(base))
    throw new Error(
      "STUDIO_PROVISION_MIRROR_URL must be an https:// address or a loopback http:// one.",
    );
  const parsed = new URL(url);
  return `${base}/${parsed.host}${parsed.pathname}`;
}

export function makeNodeProvisionHost(
  input: {
    readonly env?: Readonly<Record<string, string | undefined>>;
    readonly interactive?: boolean;
  } = {},
): ProvisionHost {
  const info = NodeOS.userInfo();
  const env = input.env ?? process.env;
  return {
    // oxlint-disable-next-line studio/no-global-process-runtime -- this is the one real host; tests use a fake.
    platform: process.platform,
    // oxlint-disable-next-line studio/no-global-process-runtime -- as above.
    arch: process.arch,
    home: env.HOME && env.HOME.length > 0 ? env.HOME : info.homedir,
    user: info.username,
    uid: info.uid,
    env,
    interactive: input.interactive ?? false,
    exec: (command, args, options = {}) =>
      new Promise<ExecResult>((resolve) => {
        let stdout = "";
        let stderr = "";
        let pending = "";
        const child = NodeChildProcess.spawn(command, [...args], {
          env: { ...env, ...options.env } as NodeJS.ProcessEnv,
          stdio: options.inheritStdio ? "inherit" : ["ignore", "pipe", "pipe"],
        });
        const timer =
          options.timeoutMs === undefined
            ? undefined
            : setTimeout(() => child.kill("SIGKILL"), options.timeoutMs);
        const emit = (chunk: string) => {
          if (!options.onLine) return;
          pending += chunk;
          const lines = pending.split(/\r?\n/u);
          pending = lines.pop() ?? "";
          for (const line of lines) if (line.trim()) options.onLine(line);
        };
        child.stdout?.setEncoding("utf8").on("data", (chunk: string) => {
          stdout += chunk;
          emit(chunk);
        });
        child.stderr?.setEncoding("utf8").on("data", (chunk: string) => {
          stderr += chunk;
          emit(chunk);
        });
        child.on("error", (error) => {
          if (timer) clearTimeout(timer);
          resolve({ code: 127, stdout, stderr: `${stderr}${error.message}` });
        });
        child.on("close", (code, signal) => {
          if (timer) clearTimeout(timer);
          if (pending.trim() && options.onLine) options.onLine(pending);
          resolve({ code: code ?? (signal ? 128 : 1), stdout, stderr });
        });
      }),
    readText: async (path) => {
      try {
        return await NodeFSP.readFile(path, "utf8");
      } catch {
        return null;
      }
    },
    listDir: async (path) => {
      try {
        return await NodeFSP.readdir(path);
      } catch {
        return [];
      }
    },
    writeText: async (path, text, mode = 0o644) => {
      await NodeFSP.mkdir(NodePath.dirname(path), { recursive: true });
      const temporary = `${path}.${process.pid}.${NodeCrypto.randomUUID()}.tmp`;
      await NodeFSP.writeFile(temporary, text, { mode });
      await NodeFSP.rename(temporary, path);
    },
    appendText: async (path, text, mode = 0o644) => {
      await NodeFSP.mkdir(NodePath.dirname(path), { recursive: true });
      await NodeFSP.appendFile(path, text, { mode });
    },
    exists: async (path) => {
      try {
        await NodeFSP.lstat(path);
        return true;
      } catch {
        return false;
      }
    },
    isExecutable: async (path) => {
      try {
        await NodeFSP.access(path, NodeFS.constants.X_OK);
        return (await NodeFSP.stat(path)).isFile();
      } catch {
        return false;
      }
    },
    readLink: async (path) => {
      try {
        return await NodeFSP.readlink(path);
      } catch {
        return null;
      }
    },
    realPath: async (path) => {
      try {
        return await NodeFSP.realpath(path);
      } catch {
        return null;
      }
    },
    mkdirp: async (path) => {
      await NodeFSP.mkdir(path, { recursive: true });
    },
    remove: async (path) => {
      await NodeFSP.rm(path, { recursive: true, force: true });
    },
    rename: (from, to) => NodeFSP.rename(from, to),
    symlink: async (target, link) => {
      await NodeFSP.mkdir(NodePath.dirname(link), { recursive: true });
      const temporary = `${link}.${process.pid}.link`;
      await NodeFSP.rm(temporary, { force: true });
      await NodeFSP.symlink(target, temporary);
      await NodeFSP.rename(temporary, link);
    },
    chmod: (path, mode) => NodeFSP.chmod(path, mode),
    download: async (url, file, options) => {
      const response = await fetch(url, { redirect: "follow" });
      if (!response.ok || !response.body)
        throw new Error(`GET ${url} returned HTTP ${response.status}.`);
      // An https:// download never ends on plain HTTP.
      if (url.startsWith("https://") && !response.url.startsWith("https://"))
        throw new Error(`GET ${url} was redirected to ${response.url}, which is not HTTPS.`);
      await NodeFSP.mkdir(NodePath.dirname(file), { recursive: true });
      const hash = NodeCrypto.createHash("sha256");
      const handle = await NodeFSP.open(file, "w", 0o600);
      let bytes = 0;
      try {
        for await (const chunk of response.body as unknown as AsyncIterable<Uint8Array>) {
          bytes += chunk.byteLength;
          if (bytes > options.maxBytes)
            throw new Error(`${url} is larger than the expected ${options.maxBytes} bytes.`);
          hash.update(chunk);
          await handle.write(chunk);
          options.onProgress?.(bytes);
        }
      } finally {
        await handle.close();
      }
      const actual = hash.digest("hex");
      if (actual !== options.sha256.toLowerCase()) {
        await NodeFSP.rm(file, { force: true });
        throw new ChecksumMismatchError(url, options.sha256, actual);
      }
    },
    downloadSigned: async (url, file, maxBytes) => {
      const response = await fetch(url, { redirect: "follow" });
      if (!response.ok) throw new Error(`GET ${url} returned HTTP ${response.status}.`);
      const body = new Uint8Array(await response.arrayBuffer());
      if (body.byteLength > maxBytes) throw new Error(`${url} is larger than expected.`);
      await NodeFSP.mkdir(NodePath.dirname(file), { recursive: true });
      await NodeFSP.writeFile(file, body, { mode: 0o600 });
    },
    fetchText: async (url) => {
      const response = await fetch(url, { redirect: "follow" });
      return {
        ok: response.ok,
        status: response.status,
        text: response.ok ? await response.text() : "",
      };
    },
    sha256Text: (text) => NodeCrypto.createHash("sha256").update(text).digest("hex"),
    sha256File: async (path) => {
      const hash = NodeCrypto.createHash("sha256");
      for await (const chunk of NodeFS.createReadStream(path)) hash.update(chunk as Buffer);
      return hash.digest("hex");
    },
    which: async (name, pathValue) => {
      for (const directory of pathValue.split(":")) {
        if (!directory) continue;
        const candidate = NodePath.join(directory, name);
        try {
          await NodeFSP.access(candidate, NodeFS.constants.X_OK);
          if ((await NodeFSP.stat(candidate)).isFile()) return candidate;
        } catch {
          // not here
        }
      }
      return null;
    },
    now: () => new Date(),
  };
}
