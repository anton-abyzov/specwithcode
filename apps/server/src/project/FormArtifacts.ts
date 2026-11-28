// @effect-diagnostics nodeBuiltinImport:off -- Artifact files are read and written with node:fs directly.
/**
 * Forms on disk: `.form.json` files. An agent writes one under the project's
 * `.specweave/artifacts/` folder by name, with its responses Sheet beside it,
 * and reads that one or any `.form.json` file in the project by its path.
 * Every path is built from a checked name or checked relative path, and opened
 * only from the project's real root through no link.
 */
import * as NodeFS from "node:fs";
import * as NodeFSP from "node:fs/promises";
import * as NodePath from "node:path";

import {
  FORM_DIR,
  FORM_LIMITS,
  FORM_RESPONSES_SUFFIX,
  FORM_SUFFIX,
  type FormDocument,
  emptyResponsesSheet,
  formResponseCount,
  formRevision,
  formSlug,
  parseForm,
  responsesSheetPath,
  serializeForm,
  validateFormDocument,
} from "@specweave-studio/shared/officeForm";
import {
  SHEET_ARTIFACT_SUFFIX,
  SHEET_LIMITS,
  type SheetDocument,
  parseSheetDocument,
  serializeSheetDocument,
} from "@specweave-studio/shared/officeSheet";

import { writeSheetFileCompareAndSet } from "./OfficeArtifacts.ts";
import { ProjectLibraryProblem } from "./ProjectLibrary.ts";
import { openInside } from "./ThreadReports.ts";

/** Short enough that `<name>-responses` is still a sheet name (60 characters). */
export const FORM_NAME_PATTERN = /^[a-z0-9][a-z0-9-]{0,49}$/;

export interface FormResponsesState {
  /** The responses Sheet's path inside the project. */
  readonly relativePath: string;
  /** Its name for `sheet_read`, when it sits in `.specweave/artifacts/` itself. */
  readonly sheetName: string | null;
  /** Rows below the header; null when the Sheet is missing or cannot be read. */
  readonly count: number | null;
  readonly created: boolean;
}

export interface SavedForm {
  readonly name: string;
  readonly relativePath: string;
  readonly absolutePath: string;
  readonly document: FormDocument;
  readonly revision: string;
  readonly created: boolean;
  readonly responses: FormResponsesState;
}

const invalid = (message: string) => new ProjectLibraryProblem("invalid", message);

function checkedName(name: string): string {
  const trimmed = name.trim().toLowerCase();
  const stem = trimmed.endsWith(FORM_SUFFIX) ? trimmed.slice(0, -FORM_SUFFIX.length) : trimmed;
  if (!FORM_NAME_PATTERN.test(stem)) {
    throw invalid(
      "A form name is lower-case letters, digits and dashes, up to 50 characters, such as team-offsite.",
    );
  }
  return stem;
}

/** A path inside the project to a `.form.json` file: no absolute paths, no `..`, no links. */
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
    !slashed.toLowerCase().endsWith(FORM_SUFFIX)
  ) {
    throw invalid(
      "Give the path of a .form.json file inside the project, such as forms/intake.form.json.",
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

async function readTextInside(
  realRoot: string,
  relativePath: string,
  limit: number,
): Promise<string | null> {
  const folder = relativePath.split("/").slice(0, -1).join("/");
  if (!(await plainDirectory(realRoot, folder))) return null;
  const exists = await NodeFSP.lstat(NodePath.join(realRoot, ...relativePath.split("/"))).catch(
    () => null,
  );
  if (exists === null || !exists.isFile()) return null;
  const reader = await openInside(realRoot, relativePath, NodeFS.constants.O_RDONLY);
  try {
    const stat = await reader.stat();
    if (stat.size > limit)
      throw invalid(`${relativePath} is over the ${limit / (1024 * 1024)} MB limit.`);
    return (await reader.readFile("utf8")).replace(/^﻿+/, "");
  } finally {
    await reader.close().catch(() => undefined);
  }
}

function located(workspaceRoot: string, relativePath: string) {
  return {
    name: NodePath.posix.basename(relativePath).slice(0, -FORM_SUFFIX.length),
    relativePath,
    absolutePath: NodePath.join(NodePath.resolve(workspaceRoot), ...relativePath.split("/")),
  };
}

/** The responses Sheet's name for `sheet_read`, or null when it is not in the artifacts folder itself. */
export function responsesSheetName(relativePath: string): string | null {
  const prefix = `${FORM_DIR}/`;
  if (!relativePath.startsWith(prefix)) return null;
  const rest = relativePath.slice(prefix.length);
  if (rest.includes("/") || !rest.endsWith(SHEET_ARTIFACT_SUFFIX)) return null;
  return rest.slice(0, -SHEET_ARTIFACT_SUFFIX.length);
}

/** Reads a responses Sheet from its file; null when it is missing or not a sheet. */
export async function readResponsesSheetFile(
  workspaceRoot: string,
  relativePath: string,
): Promise<SheetDocument | null> {
  const realRoot = await NodeFSP.realpath(NodePath.resolve(workspaceRoot));
  const text = await readTextInside(realRoot, relativePath, SHEET_LIMITS.bytes).catch(() => null);
  if (text === null) return null;
  const parsed = parseSheetDocument(text);
  return parsed.ok ? parsed.document : null;
}

/**
 * Creates a file that must not exist yet, opened through the checked folder: the
 * open refuses a symlink and a folder swapped since the check (`openInside`).
 * False when a file of that name is already there.
 */
async function createInside(
  realRoot: string,
  relativePath: string,
  text: string,
): Promise<boolean> {
  let writer: NodeFSP.FileHandle;
  try {
    writer = await openInside(
      realRoot,
      relativePath,
      NodeFS.constants.O_CREAT | NodeFS.constants.O_EXCL | NodeFS.constants.O_WRONLY,
    );
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "EEXIST") return false;
    throw error;
  }
  try {
    await writer.writeFile(text, "utf8");
    await writer.sync();
  } finally {
    await writer.close().catch(() => undefined);
  }
  return true;
}

/** Writes an empty responses Sheet when none is there; never replaces one. */
async function ensureResponsesSheet(
  realRoot: string,
  relativePath: string,
  document: FormDocument,
): Promise<boolean> {
  const folder = relativePath.split("/").slice(0, -1).join("/");
  if (!(await plainDirectory(realRoot, folder)))
    throw invalid(`${folder} leads outside the project.`);
  return createInside(
    realRoot,
    relativePath,
    serializeSheetDocument(emptyResponsesSheet(document)),
  );
}

export async function writeFormArtifact(
  workspaceRoot: string,
  input: {
    readonly form: unknown;
    readonly name?: string | undefined;
    readonly expectedRevision?: string | undefined;
  },
): Promise<SavedForm> {
  const checked = validateFormDocument(input.form);
  if (!checked.ok) throw invalid(checked.error);
  const stem =
    input.name !== undefined
      ? checkedName(input.name)
      : checkedName(formSlug(checked.document.title).slice(0, 50).replace(/-+$/, "") || "form");
  const realRoot = await NodeFSP.realpath(NodePath.resolve(workspaceRoot));
  if (!(await plainDirectory(realRoot, ".specweave"))) {
    throw new ProjectLibraryProblem(
      "not_specweave",
      "This project has no .specweave folder. Run specweave init in it to save forms.",
    );
  }
  await NodeFSP.mkdir(NodePath.join(realRoot, ...FORM_DIR.split("/")), { recursive: true }).catch(
    () => undefined,
  );
  if (!(await plainDirectory(realRoot, FORM_DIR)))
    throw invalid(`${FORM_DIR} leads outside the project.`);
  const relativePath = `${FORM_DIR}/${stem}${FORM_SUFFIX}`;
  const target = NodePath.join(realRoot, ...relativePath.split("/"));
  const existing = await NodeFSP.lstat(target).catch(() => null);
  if (existing !== null && !existing.isFile())
    throw invalid(`${relativePath} leads outside the project.`);
  // Read through the checked folder, so a file swapped in since the check is refused.
  const beforeText =
    existing === null ? null : await readTextInside(realRoot, relativePath, FORM_LIMITS.bytes);
  const beforeRevision = beforeText === null ? undefined : formRevision(beforeText);
  if (input.expectedRevision !== undefined && input.expectedRevision !== beforeRevision) {
    throw invalid(
      beforeText === null
        ? `Conflict: expected revision ${input.expectedRevision}, but form ${stem} does not exist yet.`
        : `Conflict: form ${stem} changed on disk (expected ${input.expectedRevision}, current ${beforeRevision}). Read it again and retry.`,
    );
  }
  // A form keeps the responses Sheet it already names, so its answers stay together.
  const previous = beforeText === null ? null : parseForm(beforeText);
  const responses = checked.document.responses ??
    (previous?.ok === true ? previous.document.responses : undefined) ?? {
      sheet: `${stem}${FORM_RESPONSES_SUFFIX}`,
    };
  const document: FormDocument = { ...checked.document, responses };
  const text = serializeForm(document);
  if (Buffer.byteLength(text, "utf8") > FORM_LIMITS.bytes) {
    throw invalid(`The form is over the ${FORM_LIMITS.bytes / (1024 * 1024)} MB limit.`);
  }
  const parsed = parseForm(text);
  if (!parsed.ok) throw invalid(parsed.error);
  if (beforeRevision !== undefined) {
    await writeSheetFileCompareAndSet(workspaceRoot, relativePath, text, beforeRevision, target);
  } else {
    if (!(await createInside(realRoot, relativePath, text))) {
      throw invalid(`Conflict: form ${stem} was created by someone else meanwhile. Retry.`);
    }
  }
  const sheetPath = responsesSheetPath(relativePath, parsed.document);
  const created = await ensureResponsesSheet(realRoot, sheetPath, parsed.document);
  const sheet = await readResponsesSheetFile(workspaceRoot, sheetPath);
  return {
    ...located(workspaceRoot, relativePath),
    document: parsed.document,
    revision: formRevision(text),
    created: existing === null,
    responses: {
      relativePath: sheetPath,
      sheetName: responsesSheetName(sheetPath),
      count: sheet === null ? null : formResponseCount(sheet),
      created,
    },
  };
}

/** A form by name in `.specweave/artifacts/`, or by its path inside the project. */
export async function readFormArtifact(
  workspaceRoot: string,
  input: { readonly name?: string | undefined; readonly path?: string | undefined },
): Promise<Omit<SavedForm, "responses"> & { readonly responsesPath: string }> {
  if ((input.name === undefined) === (input.path === undefined)) {
    throw invalid("Pass the form's name, or its path inside the project, but not both.");
  }
  const relativePath =
    input.name !== undefined
      ? `${FORM_DIR}/${checkedName(input.name)}${FORM_SUFFIX}`
      : checkedRelativePath(input.path!);
  const realRoot = await NodeFSP.realpath(NodePath.resolve(workspaceRoot));
  const text = await readTextInside(realRoot, relativePath, FORM_LIMITS.bytes);
  if (text === null) throw invalid(`No form at ${relativePath}.`);
  const parsed = parseForm(text);
  if (!parsed.ok) throw invalid(`${relativePath} is not a form: ${parsed.error}`);
  return {
    ...located(workspaceRoot, relativePath),
    document: parsed.document,
    revision: formRevision(text),
    created: false,
    responsesPath: responsesSheetPath(relativePath, parsed.document),
  };
}
