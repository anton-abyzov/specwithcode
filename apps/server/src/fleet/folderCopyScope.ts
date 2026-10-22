// @effect-diagnostics nodeBuiltinImport:off - bounded read-only scope discovery, like FolderLayout.
import * as NodeFSP from "node:fs/promises";
import * as NodePath from "node:path";
import * as NodeOS from "node:os";
import { FolderCopyError, type FolderCopyScopes } from "@specweave-studio/contracts";
import { readFolderLayout } from "../project/FolderLayout.ts";
import { isSafeRelativePath } from "./folderTransfer/paths.ts";

export interface CopyScopePaths {
  readonly copyRoot: string;
  readonly projectRelativePath: string;
}

export const validProjectRelativePath = (value: string) =>
  value === "." || (isSafeRelativePath(value, "win32") && !value.includes("\\"));

export function copiedProjectFolder(targetFolder: string, relative = "."): string {
  if (!validProjectRelativePath(relative))
    throw new FolderCopyError({ code: "invalid", detail: "The copied project path is invalid." });
  return relative === "." ? targetFolder : NodePath.join(targetFolder, ...relative.split("/"));
}

const relativeWithin = (root: string, candidate: string): string | null => {
  const relative = NodePath.relative(root, candidate).split(NodePath.sep).join("/") || ".";
  return validProjectRelativePath(relative) ? relative : null;
};

/** Configuration is evidence only: no code, commands, or instructions from it are executed. */
async function readConfig(root: string): Promise<Record<string, unknown> | null> {
  const file = NodePath.join(root, ".specweave/config.json");
  try {
    const real = await NodeFSP.realpath(file);
    if (relativeWithin(root, real) === null) return null;
    const stat = await NodeFSP.stat(real);
    if (!stat.isFile() || stat.size > 262_144) return null;
    const value: unknown = JSON.parse(await NodeFSP.readFile(real, "utf8"));
    return value !== null && typeof value === "object" && !Array.isArray(value)
      ? (value as Record<string, unknown>)
      : null;
  } catch {
    return null;
  }
}

async function ownsProject(root: string, projectRoot: string): Promise<boolean> {
  const config = await readConfig(root);
  if (!config) return false;
  const object = (value: unknown) =>
    value !== null && typeof value === "object" ? (value as Record<string, unknown>) : {};
  const entries: unknown = object(config.workspace).repos ?? object(config.umbrella).childRepos;
  if (Array.isArray(entries)) {
    for (const entry of entries.slice(0, 1000)) {
      const declared = object(entry).path;
      if (typeof declared !== "string" || declared.length > 4096 || NodePath.isAbsolute(declared))
        continue;
      const real = await NodeFSP.realpath(NodePath.resolve(root, declared)).catch(() => null);
      if (real && relativeWithin(root, real) !== null && relativeWithin(real, projectRoot) !== null)
        return true;
    }
    // Explicit membership is authoritative, even when conventional folders also exist.
    if (entries.length > 0) return false;
  }
  const relative = relativeWithin(root, projectRoot);
  return relative !== null && /^repositories\/[^/]+(?:\/[^/]+)?(?:\/.*)?$/.test(relative);
}

/** Only verified containing workspaces are offered; never guess from sibling repositories. */
export async function discoverCopyScopes(workspaceRoot: string): Promise<FolderCopyScopes> {
  const projectRoot = await NodeFSP.realpath(workspaceRoot);
  if (!(await NodeFSP.stat(projectRoot)).isDirectory())
    throw new FolderCopyError({ code: "not_a_folder" });
  const scopes: Array<FolderCopyScopes["scopes"][number]> = [
    {
      copyRoot: projectRoot,
      projectRelativePath: ".",
      kind: "project",
      label: "This project folder",
      repositories: [],
      truncated: false,
    },
  ];
  const home = await NodeFSP.realpath(NodeOS.homedir()).catch(() => NodeOS.homedir());
  let ancestor = NodePath.dirname(projectRoot);
  for (let depth = 0; depth < 32 && ancestor !== NodePath.dirname(ancestor); depth++) {
    if (ancestor === home) break;
    if (await ownsProject(ancestor, projectRoot)) {
      const layout = await readFolderLayout(ancestor);
      scopes.push({
        copyRoot: ancestor,
        projectRelativePath: relativeWithin(ancestor, projectRoot)!,
        kind: "workspace",
        label: NodePath.basename(ancestor),
        repositories: layout?.repositories ?? [],
        truncated: layout?.truncated ?? false,
      });
    }
    ancestor = NodePath.dirname(ancestor);
  }
  return { projectRoot, recommendedCopyRoot: scopes[1]?.copyRoot ?? projectRoot, scopes };
}

export async function resolveCopyScope(
  workspaceRoot: string,
  selected?: string,
): Promise<CopyScopePaths> {
  const scopes = await discoverCopyScopes(workspaceRoot);
  const canonical = selected === undefined ? scopes.projectRoot : await NodeFSP.realpath(selected);
  const scope = scopes.scopes.find((entry) => entry.copyRoot === canonical);
  if (!scope)
    throw new FolderCopyError({
      code: "invalid",
      detail: "Choose this project or a verified containing workspace.",
    });
  return { copyRoot: scope.copyRoot, projectRelativePath: scope.projectRelativePath };
}

/** Before registration or handoff, ensure copied path components are actual folders, never links. */
export async function verifyCopiedProjectFolder(
  targetFolder: string,
  relative = ".",
): Promise<string> {
  const folder = copiedProjectFolder(targetFolder, relative);
  let current = targetFolder;
  for (const part of ["", ...(relative === "." ? [] : relative.split("/"))]) {
    current = part ? NodePath.join(current, part) : current;
    const stat = await NodeFSP.lstat(current);
    if (!stat.isDirectory() || stat.isSymbolicLink())
      throw new FolderCopyError({
        code: "invalid",
        detail: "The copied project must be a real folder inside the copy.",
      });
  }
  return folder;
}
