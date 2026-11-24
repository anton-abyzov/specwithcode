// @effect-diagnostics nodeBuiltinImport:off -- Artifact files are read and written with node:fs directly.
/**
 * Whiteboards on disk: plain `.excalidraw` files. An agent writes one under the
 * project's `.specweave/artifacts/` folder by name, and reads that one or any
 * `.excalidraw` file in the project by its path inside the project. Every path
 * is built from a checked name or checked relative path, and opened only from
 * the project's real root through no link.
 */
import * as NodeFS from "node:fs";
import * as NodeFSP from "node:fs/promises";
import * as NodePath from "node:path";

import {
  WHITEBOARD_DIR,
  WHITEBOARD_LIMITS,
  WHITEBOARD_NAME_PATTERN,
  WHITEBOARD_SUFFIX,
  type WhiteboardFile,
  parseWhiteboard,
  whiteboardRevision,
  whiteboardSlug,
} from "@specweave-studio/shared/officeWhiteboard";

import { writeSheetFileCompareAndSet } from "./OfficeArtifacts.ts";
import { ProjectLibraryProblem } from "./ProjectLibrary.ts";
import { openInside } from "./ThreadReports.ts";
import {
  type SceneElement,
  type SkeletonElement,
  SkeletonError,
  buildScene,
  sceneDocument,
} from "./whiteboardBuild.ts";
import { type LintReport, lintScene, lintSkeleton } from "./whiteboardLint.ts";

export interface SavedWhiteboard {
  readonly name: string;
  readonly relativePath: string;
  readonly absolutePath: string;
  readonly file: WhiteboardFile;
  readonly revision: string;
  readonly created: boolean;
  readonly warnings: ReadonlyArray<string>;
  readonly lint: LintReport;
}

const invalid = (message: string) => new ProjectLibraryProblem("invalid", message);

function checkedName(name: string): string {
  const trimmed = name.trim().toLowerCase();
  const stem = trimmed.endsWith(WHITEBOARD_SUFFIX)
    ? trimmed.slice(0, -WHITEBOARD_SUFFIX.length)
    : trimmed;
  if (!WHITEBOARD_NAME_PATTERN.test(stem)) {
    throw invalid(
      "A whiteboard name is lower-case letters, digits and dashes, up to 60 characters, such as release-flow.",
    );
  }
  return stem;
}

/** A path inside the project to a `.excalidraw` file: no absolute paths, no `..`, no links. */
function checkedRelativePath(path: string): string {
  const slashed = path
    .trim()
    .replace(/\\/g, "/")
    .replace(/^\.\/+/, "");
  const parts = slashed.split("/");
  if (
    slashed.length === 0 ||
    slashed.length > 1024 ||
    slashed.startsWith("/") ||
    /^[A-Za-z]:/.test(slashed) ||
    parts.some((part) => part === "" || part === "." || part === "..") ||
    !slashed.toLowerCase().endsWith(WHITEBOARD_SUFFIX)
  ) {
    throw invalid(
      "Give the path of a .excalidraw file inside the project, such as docs/flow.excalidraw.",
    );
  }
  return slashed;
}

async function plainDirectory(realRoot: string, relative: string): Promise<boolean> {
  let current = realRoot;
  for (const part of relative.split("/")) {
    if (part.length === 0) continue;
    current = NodePath.join(current, part);
    const stat = await NodeFSP.lstat(current).catch(() => null);
    if (stat === null || !stat.isDirectory() || stat.isSymbolicLink()) return false;
  }
  return true;
}

async function projectRoot(workspaceRoot: string): Promise<string> {
  return NodeFSP.realpath(NodePath.resolve(workspaceRoot));
}

async function readAt(
  realRoot: string,
  relativePath: string,
): Promise<{ readonly text: string; readonly file: WhiteboardFile } | null> {
  const folder = relativePath.split("/").slice(0, -1).join("/");
  if (!(await plainDirectory(realRoot, folder))) return null;
  const exists = await NodeFSP.lstat(NodePath.join(realRoot, ...relativePath.split("/"))).catch(
    () => null,
  );
  if (exists === null) return null;
  const reader = await openInside(realRoot, relativePath, NodeFS.constants.O_RDONLY);
  try {
    const stat = await reader.stat();
    if (stat.size > WHITEBOARD_LIMITS.bytes) {
      throw invalid(
        `${relativePath} is over the ${WHITEBOARD_LIMITS.bytes / (1024 * 1024)} MB limit.`,
      );
    }
    const text = (await reader.readFile("utf8")).replace(/^﻿+/, "");
    const parsed = parseWhiteboard(text);
    if (!parsed.ok) throw invalid(`${relativePath} is not a whiteboard: ${parsed.error}`);
    return { text, file: parsed.file };
  } finally {
    await reader.close().catch(() => undefined);
  }
}

function located(workspaceRoot: string, relativePath: string) {
  const name = NodePath.posix.basename(relativePath).slice(0, -WHITEBOARD_SUFFIX.length);
  return {
    name,
    relativePath,
    absolutePath: NodePath.join(NodePath.resolve(workspaceRoot), ...relativePath.split("/")),
  };
}

const finite = (value: unknown) =>
  typeof value === "number" && Number.isFinite(value) ? value : 0;

/** An element read from a file, with the fields the builder measures made safe. */
function asSceneElement(element: Record<string, unknown>): SceneElement {
  return {
    ...element,
    id: String(element.id),
    type: String(element.type),
    x: finite(element.x),
    y: finite(element.y),
    width: finite(element.width),
    height: finite(element.height),
    boundElements: Array.isArray(element.boundElements)
      ? (element.boundElements as Array<{ type: string; id: string }>)
      : null,
  };
}

/** Reads a whiteboard by artifact name, or any `.excalidraw` file by its path in the project. */
export async function readWhiteboardArtifact(
  workspaceRoot: string,
  target: { readonly name?: string | undefined; readonly path?: string | undefined },
): Promise<SavedWhiteboard> {
  const relativePath =
    target.path !== undefined
      ? checkedRelativePath(target.path)
      : target.name !== undefined
        ? `${WHITEBOARD_DIR}/${checkedName(target.name)}${WHITEBOARD_SUFFIX}`
        : null;
  if (relativePath === null) throw invalid("Pass the whiteboard's name or its path.");
  const realRoot = await projectRoot(workspaceRoot);
  const loaded = await readAt(realRoot, relativePath);
  if (loaded === null) throw invalid(`No whiteboard at ${relativePath} in this project.`);
  return {
    ...located(workspaceRoot, relativePath),
    file: loaded.file,
    revision: whiteboardRevision(loaded.text),
    created: false,
    warnings: [],
    lint: lintScene(loaded.file.elements),
  };
}

/**
 * Builds a skeleton into a scene and saves it under a name, replacing the file
 * of that name or, with append, adding to the scene already there. The
 * skeleton is untrusted and checked here.
 */
export async function writeWhiteboardArtifact(
  workspaceRoot: string,
  input: {
    readonly title?: string | undefined;
    readonly name?: string | undefined;
    readonly elements: ReadonlyArray<SkeletonElement>;
    readonly append?: boolean | undefined;
    readonly dark?: boolean | undefined;
    readonly expectedRevision?: string | undefined;
  },
): Promise<SavedWhiteboard> {
  const stem =
    input.name !== undefined
      ? checkedName(input.name)
      : input.title !== undefined && input.title.trim().length > 0
        ? whiteboardSlug(input.title)
        : null;
  if (stem === null) throw invalid("A whiteboard needs a title, or the name of the one to update.");
  const realRoot = await projectRoot(workspaceRoot);
  if (!(await plainDirectory(realRoot, ".specweave"))) {
    throw new ProjectLibraryProblem(
      "not_specweave",
      "This project has no .specweave folder. Run specweave init in it to save whiteboards.",
    );
  }
  await NodeFSP.mkdir(NodePath.join(realRoot, ...WHITEBOARD_DIR.split("/")), {
    recursive: true,
  }).catch(() => undefined);
  if (!(await plainDirectory(realRoot, WHITEBOARD_DIR))) {
    throw invalid(`${WHITEBOARD_DIR} leads outside the project.`);
  }
  const relativePath = `${WHITEBOARD_DIR}/${stem}${WHITEBOARD_SUFFIX}`;
  const target = NodePath.join(realRoot, ...relativePath.split("/"));
  const existing = await NodeFSP.lstat(target).catch(() => null);
  if (existing !== null && !existing.isFile()) {
    throw invalid(`${relativePath} leads outside the project.`);
  }
  const strict = input.append === true || input.expectedRevision !== undefined;
  // A broken file of that name is replaced by a plain write, never added to.
  const before =
    existing === null
      ? null
      : await readAt(realRoot, relativePath).catch(async (error: unknown) => {
          if (strict) throw error;
          return null;
        });
  if (input.append === true && before === null) {
    throw invalid(`No whiteboard named ${stem} to add to.`);
  }
  const beforeRevision =
    before !== null
      ? whiteboardRevision(before.text)
      : existing !== null
        ? whiteboardRevision(await NodeFSP.readFile(target, "utf8"))
        : undefined;
  if (input.expectedRevision !== undefined && input.expectedRevision !== beforeRevision) {
    throw invalid(
      before === null
        ? `Conflict: expected revision ${input.expectedRevision}, but whiteboard ${stem} does not exist yet.`
        : `Conflict: whiteboard ${stem} changed on disk (expected ${input.expectedRevision}, current ${beforeRevision}). Read it again and retry.`,
    );
  }
  const pre = lintSkeleton(input.elements as ReadonlyArray<Record<string, unknown>>);
  let built;
  try {
    built = buildScene(input.elements, {
      dark: input.dark,
      existing:
        input.append === true && before !== null
          ? before.file.elements
              .filter((element) => element.isDeleted !== true && typeof element.id === "string")
              .map(asSceneElement)
          : undefined,
    });
  } catch (error) {
    if (error instanceof SkeletonError) throw invalid(error.message);
    throw error;
  }
  const document =
    input.append === true && before !== null
      ? {
          ...before.file.raw,
          elements: built.elements,
          files: { ...before.file.heldFiles, ...before.file.files },
        }
      : sceneDocument(built.elements, { dark: input.dark });
  const text = `${JSON.stringify(document, null, 2)}\n`;
  if (Buffer.byteLength(text, "utf8") > WHITEBOARD_LIMITS.bytes) {
    throw invalid(
      `The whiteboard is over the ${WHITEBOARD_LIMITS.bytes / (1024 * 1024)} MB limit.`,
    );
  }
  // Checked before writing: a file the editor would refuse never replaces one it opens.
  const parsed = parseWhiteboard(text);
  if (!parsed.ok) throw invalid(parsed.error);
  // Locked compare-and-set: the file must still be the one read above, or absent.
  if (beforeRevision !== undefined) {
    await writeSheetFileCompareAndSet(workspaceRoot, relativePath, text, beforeRevision, target);
  } else {
    await NodeFSP.writeFile(target, text, { encoding: "utf8", flag: "wx" }).catch((error) => {
      if ((error as NodeJS.ErrnoException).code === "EEXIST") {
        throw invalid(`Conflict: whiteboard ${stem} was created by someone else meanwhile. Retry.`);
      }
      throw error;
    });
  }
  const lint = lintScene(built.elements);
  return {
    ...located(workspaceRoot, relativePath),
    file: parsed.file,
    revision: whiteboardRevision(text),
    created: existing === null,
    warnings: built.warnings,
    lint: {
      errors: [...pre.errors, ...lint.errors],
      warnings: [...pre.warnings, ...lint.warnings],
    },
  };
}
