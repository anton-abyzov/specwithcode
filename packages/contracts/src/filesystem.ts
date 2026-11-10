import * as Schema from "effect/Schema";
import { TrimmedNonEmptyString } from "./baseSchemas.ts";

const FILESYSTEM_PATH_MAX_LENGTH = 512;

export const FilesystemBrowseInput = Schema.Struct({
  partialPath: TrimmedNonEmptyString.check(Schema.isMaxLength(FILESYSTEM_PATH_MAX_LENGTH)),
  cwd: Schema.optional(TrimmedNonEmptyString.check(Schema.isMaxLength(FILESYSTEM_PATH_MAX_LENGTH))),
});
export type FilesystemBrowseInput = typeof FilesystemBrowseInput.Type;

export const FilesystemBrowseEntry = Schema.Struct({
  name: TrimmedNonEmptyString,
  fullPath: TrimmedNonEmptyString,
  /** "git" when the folder holds a repository. Absent from older servers and past the marking limit. */
  kind: Schema.optionalKey(Schema.Literals(["folder", "git"])),
});
export type FilesystemBrowseEntry = typeof FilesystemBrowseEntry.Type;

export const FilesystemBrowseResult = Schema.Struct({
  parentPath: TrimmedNonEmptyString,
  entries: Schema.Array(FilesystemBrowseEntry),
  /** The home folder of the account the server runs as, for showing paths under it. */
  homePath: Schema.optionalKey(TrimmedNonEmptyString),
});
export type FilesystemBrowseResult = typeof FilesystemBrowseResult.Type;

export const FilesystemBrowseFailure = Schema.Literals([
  "windows_path_unsupported",
  "current_project_required",
  "read_directory_failed",
]);
export type FilesystemBrowseFailure = typeof FilesystemBrowseFailure.Type;

function decodedFilesystemBrowseErrorMessage(props: object): string | undefined {
  if (!("message" in props)) return undefined;
  return typeof props.message === "string" ? props.message : undefined;
}

export class FilesystemBrowseError extends Schema.TaggedError<FilesystemBrowseError>()(
  "FilesystemBrowseError",
  {
    partialPath: Schema.optional(TrimmedNonEmptyString),
    cwd: Schema.optional(TrimmedNonEmptyString),
    failure: Schema.optional(FilesystemBrowseFailure),
    parentPath: Schema.optional(TrimmedNonEmptyString),
    platform: Schema.optional(TrimmedNonEmptyString),
    message: TrimmedNonEmptyString,
    cause: Schema.optional(Schema.Defect()),
  },
) {
  // Structured diagnostics stay optional for rolling compatibility with legacy message-only
  // payloads, while new call sites must provide the request context and failure classification.
  // @effect-diagnostics-next-line overriddenSchemaConstructor:off
  constructor(props: {
    readonly partialPath: string;
    readonly cwd?: string | undefined;
    readonly failure: FilesystemBrowseFailure;
    readonly parentPath?: string;
    readonly platform?: string;
    /** What went wrong in words; older servers leave it out and get the generic message. */
    readonly message?: string;
    readonly cause?: unknown;
  }) {
    const cwd = props.cwd === undefined ? "" : ` from '${props.cwd}'`;
    super({
      ...props,
      message:
        decodedFilesystemBrowseErrorMessage(props) ??
        `Failed to browse filesystem path '${props.partialPath}'${cwd}.`,
    } as any);
  }
}

export const FILESYSTEM_FOLDER_NAME_MAX_BYTES = 255;

export const FilesystemCreateDirectoryInput = Schema.Struct({
  /** An existing absolute folder, or one under `~`. */
  parentPath: TrimmedNonEmptyString.check(Schema.isMaxLength(FILESYSTEM_PATH_MAX_LENGTH)),
  name: TrimmedNonEmptyString.check(Schema.isMaxLength(FILESYSTEM_FOLDER_NAME_MAX_BYTES)),
});
export type FilesystemCreateDirectoryInput = typeof FilesystemCreateDirectoryInput.Type;

export const FilesystemCreateDirectoryResult = Schema.Struct({
  path: TrimmedNonEmptyString,
});
export type FilesystemCreateDirectoryResult = typeof FilesystemCreateDirectoryResult.Type;

export const FilesystemCreateDirectoryFailure = Schema.Literals([
  "invalid_name",
  "exists",
  "parent_missing",
  "permission_denied",
  "refused",
  "failed",
]);
export type FilesystemCreateDirectoryFailure = typeof FilesystemCreateDirectoryFailure.Type;

/**
 * Why a folder name cannot be used, or null when it can. The same check runs
 * in the picker before the request and on the machine that makes the folder.
 * `windows` adds the characters and device names Windows refuses.
 */
export function folderNameProblem(name: string, windows = false): string | null {
  const trimmed = name.trim();
  if (trimmed.length === 0) return "Enter a folder name.";
  if (trimmed === "." || trimmed === "..") return `"${trimmed}" is not a folder name.`;
  if (/[\\/]/.test(trimmed)) return "A folder name cannot contain a slash.";
  if (/[\u0000-\u001f]/.test(trimmed)) return "A folder name cannot contain control characters.";
  if (new TextEncoder().encode(trimmed).length > FILESYSTEM_FOLDER_NAME_MAX_BYTES) {
    return "That name is too long.";
  }
  if (windows) {
    if (/[<>:"|?*]/.test(trimmed)) return 'Windows does not allow < > : " | ? * in a folder name.';
    if (/[. ]$/.test(name.trimStart())) return "On Windows a folder name cannot end with a dot.";
    if (/^(con|prn|aux|nul|com[1-9]|lpt[1-9])(\..*)?$/i.test(trimmed)) {
      return `"${trimmed}" is reserved by Windows.`;
    }
  }
  return null;
}

export class FilesystemCreateDirectoryError extends Schema.TaggedError<FilesystemCreateDirectoryError>()(
  "FilesystemCreateDirectoryError",
  {
    failure: FilesystemCreateDirectoryFailure,
    message: TrimmedNonEmptyString,
  },
) {}
