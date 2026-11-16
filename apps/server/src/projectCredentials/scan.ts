// @effect-diagnostics nodeBuiltinImport:off - bounded, no-follow reads of a project's marker files.
/**
 * Which credentials a project uses, read from its folder: file names, Terraform
 * providers, command use in scripts and workflows, and the hosts of its Git
 * remotes. Names only: no file content, URL user info or absolute path leaves
 * this module, and a file classed as a secret is matched by name and never
 * opened.
 */
import * as NodeFS from "node:fs";
import * as NodeFSP from "node:fs/promises";
import * as NodePath from "node:path";

import {
  isPlainText,
  MAX_SSH_TARGETS,
  type ProjectCredentialId,
  type ProjectCredentialRow,
  type ProjectCredentialsManifest,
  type ProjectSshTarget,
} from "@specweave-studio/contracts";

import {
  isSecretLikeProjectPath,
  isUntrackedSecretConfigPath,
} from "../workspace/WorkspaceSensitivePaths.ts";
import { CREDENTIAL_CATALOG, CREDENTIAL_HOME_FILES } from "./catalog.ts";
import { type SshTarget, sshRemoteTarget, sshTargetsInScript } from "./sshTargets.ts";

const MAX_ENTRIES = 60_000;
const MAX_DEPTH = 12;
const MAX_READ_FILES = 600;
export const MAX_MARKER_BYTES = 256 * 1024;
const MAX_SOURCES = 3;

/** Vendored code, build output and tool state: someone else's markers, or none. */
const SKIPPED_FOLDERS = new Set([
  ".repos",
  "node_modules",
  "vendor",
  "third_party",
  "third-party",
  "bower_components",
  "Pods",
  "Carthage",
  ".terraform",
  ".venv",
  "venv",
  "dist",
  "build",
  "out",
  "target",
  "coverage",
  ".next",
  ".turbo",
  ".cache",
  ".specweave",
]);

const SCRIPT_NAMES = new Set([
  "Makefile",
  "makefile",
  "GNUmakefile",
  "justfile",
  "Justfile",
  "Taskfile.yml",
  "Taskfile.yaml",
  "package.json",
  ".gitlab-ci.yml",
  "azure-pipelines.yml",
  "Jenkinsfile",
]);
const SCRIPT_EXTENSIONS = new Set([".sh", ".bash", ".zsh"]);

type MarkerKind = "terraform" | "script";

/** The marker files this scan may open, by name and place. */
function markerKind(relative: string, name: string): MarkerKind | null {
  if (name.endsWith(".tf")) return "terraform";
  if (SCRIPT_NAMES.has(name) || SCRIPT_EXTENSIONS.has(NodePath.extname(name))) return "script";
  if (/(?:^|\/)\.github\/workflows\/[^/]+\.ya?ml$/u.test(relative)) return "script";
  return null;
}

const mayRead = (relative: string) =>
  !isSecretLikeProjectPath(relative) && !isUntrackedSecretConfigPath(relative);

/** Reads a small regular file without following a link; null for anything else. */
async function readMarker(absolute: string): Promise<string | null> {
  let handle: NodeFSP.FileHandle | null = null;
  try {
    handle = await NodeFSP.open(
      absolute,
      NodeFS.constants.O_RDONLY | (NodeFS.constants.O_NOFOLLOW ?? 0),
    );
    const stat = await handle.stat();
    if (!stat.isFile()) return null;
    const buffer = Buffer.alloc(Math.min(stat.size, MAX_MARKER_BYTES));
    const { bytesRead } = await handle.read(buffer, 0, buffer.length, 0);
    return buffer.subarray(0, bytesRead).toString("utf8");
  } catch {
    return null;
  } finally {
    await handle?.close();
  }
}

/**
 * The host of a Git remote, and nothing else of it: `https://user:token@host/x`,
 * `ssh://git@host:22/x` and `git@host:x` all give `host`.
 */
export function remoteHost(url: string): string | null {
  const value = url.trim();
  const scheme = /^[a-z][a-z0-9+.-]*:\/\/(?:[^/@]*@)?(\[[^\]]+\]|[^/:?#]+)/iu.exec(value);
  if (scheme) return scheme[1]!.toLowerCase();
  const scp = /^(?:[^/@:]+@)?([^/:@\s]+):(?!\/\/)/u.exec(value);
  if (scp && !/^[A-Za-z]$/u.test(scp[1]!)) return scp[1]!.toLowerCase();
  return null;
}

const TERRAFORM_SOURCE =
  /\bsource\s*=\s*"((?:registry\.terraform\.io\/)?[a-z0-9-]+\/[a-z0-9-]+)"/giu;
const TERRAFORM_PROVIDER = /^\s*provider\s+"([a-z0-9_-]+)"/gimu;
const GIT_URL = /^\s*url\s*=\s*(\S+)/gimu;

export interface CredentialScan {
  /** Catalog id to the project-relative files that showed it. */
  readonly found: ReadonlyMap<ProjectCredentialId, ReadonlyArray<string>>;
  readonly truncated: boolean;
  /** Where the project connects over SSH: script destinations and SSH Git remotes. */
  readonly sshTargets: ReadonlyArray<ProjectSshTarget>;
  /** The project connects to more places than `sshTargets` holds. */
  readonly sshTargetsMore: boolean;
}

/** Walks the project folder once and collects what shows each credential. */
export async function scanProjectCredentials(root: string): Promise<CredentialScan> {
  const found = new Map<ProjectCredentialId, Array<string>>();
  const note = (id: ProjectCredentialId, source: string) => {
    const sources = found.get(id) ?? [];
    if (!found.has(id)) found.set(id, sources);
    if (sources.length < MAX_SOURCES && !sources.includes(source)) sources.push(source);
  };
  const sshTargets = new Map<string, ProjectSshTarget>();
  let sshTargetsMore = false;
  const connects = (target: SshTarget, source: string) => {
    // A file name can carry direction marks that would disguise the line it is shown on.
    if (!isPlainText(source)) return;
    note("ssh", source);
    const key = `${target.kind} ${target.user ?? ""} ${target.host ?? ""} ${target.variable ?? ""}`;
    if (sshTargets.has(key)) return;
    if (sshTargets.size < MAX_SSH_TARGETS) sshTargets.set(key, { ...target, source });
    else sshTargetsMore = true;
  };
  const shortProviders = new Map<string, ProjectCredentialId>();
  const fullProviders = new Map<string, ProjectCredentialId>();
  for (const entry of CREDENTIAL_CATALOG)
    for (const source of entry.terraformProviders) {
      fullProviders.set(source, entry.id);
      shortProviders.set(source.split("/")[1]!, entry.id);
    }

  let entries = 0;
  let read = 0;
  let truncated = false;
  const queue: Array<{ readonly relative: string; readonly depth: number }> = [
    { relative: "", depth: 0 },
  ];
  while (queue.length > 0) {
    const { relative: folder, depth } = queue.shift()!;
    let children: Array<NodeFS.Dirent>;
    try {
      children = await NodeFSP.readdir(NodePath.join(root, folder), { withFileTypes: true });
    } catch {
      continue;
    }
    children.sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
    for (const child of children) {
      entries += 1;
      if (entries > MAX_ENTRIES) {
        truncated = true;
        queue.length = 0;
        break;
      }
      const relative = folder === "" ? child.name : `${folder}/${child.name}`;
      if (child.isDirectory()) {
        if (child.name === ".git") {
          const config = await readMarker(NodePath.join(root, relative, "config"));
          if (config !== null)
            for (const match of config.matchAll(GIT_URL)) {
              const remote = sshRemoteTarget(match[1]!);
              if (remote !== null) connects(remote, folder === "" ? "." : folder);
              const host = remoteHost(match[1]!);
              if (host === null) continue;
              for (const entry of CREDENTIAL_CATALOG)
                if (entry.remoteHosts.includes(host)) note(entry.id, folder === "" ? "." : folder);
            }
          continue;
        }
        if (SKIPPED_FOLDERS.has(child.name)) continue;
        if (depth + 1 > MAX_DEPTH) {
          truncated = true;
          continue;
        }
        queue.push({ relative, depth: depth + 1 });
        continue;
      }
      // Links are someone else's file, or a way out of the folder.
      if (!child.isFile()) continue;
      for (const entry of CREDENTIAL_CATALOG)
        if (entry.fileNames.some((pattern) => pattern.test(child.name))) note(entry.id, relative);
      const kind = markerKind(relative, child.name);
      if (kind === null || !mayRead(relative)) continue;
      if (read >= MAX_READ_FILES) {
        truncated = true;
        continue;
      }
      read += 1;
      const text = await readMarker(NodePath.join(root, relative));
      if (text === null) continue;
      if (kind === "terraform") {
        for (const match of text.matchAll(TERRAFORM_SOURCE)) {
          const id = fullProviders.get(
            match[1]!.toLowerCase().replace(/^registry\.terraform\.io\//u, ""),
          );
          if (id) note(id, relative);
        }
        for (const match of text.matchAll(TERRAFORM_PROVIDER)) {
          const id = shortProviders.get(match[1]!.toLowerCase());
          if (id) note(id, relative);
        }
        continue;
      }
      for (const entry of CREDENTIAL_CATALOG)
        if (entry.scriptUse?.test(text)) note(entry.id, relative);
      const ssh = sshTargetsInScript(text);
      for (const target of ssh.targets) connects(target, relative);
      if (ssh.more) sshTargetsMore = true;
    }
  }
  return { found, truncated, sshTargets: [...sshTargets.values()], sshTargetsMore };
}

/**
 * The dialog's rows: everything the scan found plus everything the saved
 * manifest lists, in the catalog's order, with the person's skips and notes.
 */
export function credentialRows(
  scan: CredentialScan,
  manifest: ProjectCredentialsManifest | null,
): Array<ProjectCredentialRow> {
  const saved = new Map((manifest?.credentials ?? []).map((entry) => [entry.id, entry]));
  const rows: Array<ProjectCredentialRow> = [];
  for (const entry of CREDENTIAL_CATALOG) {
    const sources = scan.found.get(entry.id);
    const listed = saved.get(entry.id);
    if (sources === undefined && listed === undefined) continue;
    rows.push({
      id: entry.id,
      kind: entry.kind,
      sources: [...(sources ?? [])],
      listed: listed !== undefined,
      skip: listed?.skip === true,
      note: listed?.note ?? null,
      keptIn: [...CREDENTIAL_HOME_FILES[entry.id]],
      ...(entry.id === "ssh"
        ? { sshTargets: [...scan.sshTargets], sshTargetsMore: scan.sshTargetsMore }
        : {}),
    });
  }
  return rows;
}
