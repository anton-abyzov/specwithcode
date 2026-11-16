// @effect-diagnostics nodeBuiltinImport:off - writes the known Git hosts' keys where ssh can read them.
/**
 * This machine as the credential checks see it: where tools are looked for,
 * what the person's Terminal has set, and the pinned keys of the Git hosts an
 * SSH check may contact. Built for each request from the server's own places
 * and the login shell, with every folder that lies inside a registered
 * project taken out: a project never supplies a tool, the `node` a tool looks
 * up, or the folder a tool reads its sign-in from.
 */
import * as NodeCrypto from "node:crypto";
import * as NodeFSP from "node:fs/promises";
import * as NodePath from "node:path";

import { TERMINAL_VARIABLES } from "./catalog.ts";
import { knownGitHosts, type ProbeMachine, probeFolders, type ProbeSpawn } from "./probe.ts";
import type { TerminalEnvironment } from "./terminalEnv.ts";
import { foldersOutsideProjects, insideProjects, pathFolders } from "./tool.ts";

/** The known Git hosts' keys as a file ssh can read, written once and kept current. Null when it cannot be. */
export async function knownHostsFile(baseDir: string): Promise<string | null> {
  const file = NodePath.join(baseDir, "caches", "known-git-hosts");
  const wanted = knownGitHosts();
  const current = () => NodeFSP.readFile(file, "utf8").catch(() => null);
  if ((await current()) === wanted) return file;
  // A draft of its own per write: two requests at once never move each other's file.
  const draft = `${file}.${process.pid}.${NodeCrypto.randomUUID()}.tmp`;
  try {
    await NodeFSP.mkdir(NodePath.dirname(file), { recursive: true });
    await NodeFSP.writeFile(draft, wanted, { mode: 0o644 });
    await NodeFSP.rename(draft, file);
    return file;
  } catch {
    await NodeFSP.rm(draft, { force: true }).catch(() => undefined);
    // Another request may have written it meanwhile: what counts is what the file holds.
    return (await current()) === wanted ? file : null;
  }
}

export interface MachineSources {
  readonly platform: NodeJS.Platform;
  readonly home: string;
  /** The app's own folder: its `caches` holds the known Git hosts' keys. */
  readonly baseDir: string;
  /** The folders SpecWithCode installed tools into, its commands folder first. */
  readonly appFolders: () => Promise<ReadonlyArray<string>>;
  /** What a new Terminal window has; `fresh` asks the shell again. Null when no shell answered. */
  readonly terminal: (fresh: boolean) => Promise<TerminalEnvironment | null>;
  /** The server's own environment. */
  readonly serverEnv: Readonly<Record<string, string | undefined>>;
  readonly spawn: ProbeSpawn;
}

export async function probeMachine(
  sources: MachineSources,
  projectRoots: ReadonlyArray<string>,
  projectRoot: string | null,
  fresh: boolean,
): Promise<ProbeMachine> {
  const { platform } = sources;
  const outside = (folders: ReadonlyArray<string>) =>
    foldersOutsideProjects(folders, projectRoots, platform);
  const appFolders = await outside(
    await sources.appFolders().catch(() => [] as ReadonlyArray<string>),
  );
  const shell = await sources.terminal(fresh).catch(() => null);
  // Without an answer from the shell, the server's own PATH stands in: it was read from the
  // login shell at start, with the app's folders added after it, which are taken out again.
  const terminalFolders = await outside(
    shell !== null
      ? pathFolders(shell.path, platform)
      : pathFolders(sources.serverEnv["PATH"], platform).filter(
          (folder) => !appFolders.includes(folder),
        ),
  );
  const variables: Record<string, string> = {};
  for (const name of TERMINAL_VARIABLES) {
    const value = shell !== null ? shell.variables[name] : sources.serverEnv[name];
    if (value !== undefined && value !== "") variables[name] = value;
  }
  const xdgConfigHome = shell?.xdgConfigHome ?? null;
  return {
    platform,
    home: sources.home,
    folders: await outside(
      probeFolders({ platform, managed: appFolders, terminal: terminalFolders }),
    ),
    terminalFolders,
    appFolders,
    projectRoots,
    projectRoot,
    // A config folder inside a project would hand the project the tools' state.
    xdgConfigHome:
      xdgConfigHome !== null &&
      NodePath.isAbsolute(xdgConfigHome) &&
      !(await insideProjects(xdgConfigHome, projectRoots, platform))
        ? xdgConfigHome
        : null,
    knownHosts: platform === "win32" ? null : await knownHostsFile(sources.baseDir),
    // Filtered to a short list in probe.ts.
    inherited: sources.serverEnv,
    variables,
    spawn: sources.spawn,
  };
}
