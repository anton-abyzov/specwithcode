/**
 * Who a project is for. Release checks, acceptance runs and handoff proofs make
 * real projects so they can drive the live app; the person never works in them.
 * Those are "automated": the sidebar lists them apart from the person's own
 * projects. The flag is saved when a check says so at creation or a temporary
 * agent token makes the project; any other project is judged by its folder each
 * time it is shown, so a better guess later changes nothing saved. The person can
 * move a project either way, and that choice is saved and always wins.
 */

export type ProjectOrigin = "user" | "automated";

export interface ProjectOriginInput {
  readonly workspaceRoot: string;
  readonly workspaceSettings?:
    | {
        /** A string on the wire; a value this version does not know reads as unset. */
        readonly origin?: string | undefined;
        readonly temporarySessionId?: string | undefined;
        readonly kind?: string | undefined;
      }
    | null
    | undefined;
}

/** Folder-name words that only checks and fixtures use. */
const AUTOMATED_FOLDER_WORDS = new Set([
  "scratch",
  "verification",
  "acceptance",
  "fixture",
  "fixtures",
]);

/** The app's own data folders; a project inside one was made by the app or an agent. */
const APP_DATA_FOLDERS = [
  [".specwithcode"],
  [".specweave-studio"],
  [".local", "share", "specweave"],
  [".local", "share", "specweave-studio"],
] as const;

/** Temporary folders on macOS, Linux and Windows. */
const TEMP_PREFIXES = ["/tmp/", "/private/tmp/", "/var/folders/", "/private/var/folders/"];

function segmentsOf(path: string): string[] {
  return path.replaceAll("\\", "/").split("/").filter(Boolean);
}

function startsWithSequence(
  segments: ReadonlyArray<string>,
  at: number,
  sequence: ReadonlyArray<string>,
) {
  return sequence.every((part, offset) => segments[at + offset]?.toLowerCase() === part);
}

/**
 * True when a folder is plainly a check's workspace: a temporary folder, a folder
 * inside the app's own data, or a path with a folder named like `scratch`,
 * `verification` or `*-fixture`. The app's projects folder (`<data>/<machine>/projects`,
 * where New project and the personal assistant live) is always the person's, whatever
 * the project is called. This is a guess read at display time, never saved: the
 * person's own choice is saved and always wins.
 */
export function isAutomatedWorkspaceRoot(workspaceRoot: string): boolean {
  const normalized = workspaceRoot.replaceAll("\\", "/");
  const lower = normalized.toLowerCase();
  if (TEMP_PREFIXES.some((prefix) => lower.startsWith(prefix))) return true;
  if (/\/appdata\/local\/temp\//.test(lower)) return true;
  const segments = segmentsOf(normalized);
  let inAppData = false;
  for (let index = 0; index < segments.length; index += 1) {
    const data = APP_DATA_FOLDERS.find((sequence) => startsWithSequence(segments, index, sequence));
    if (data === undefined) continue;
    const rest = segments.slice(index + data.length).map((segment) => segment.toLowerCase());
    if (rest[0] === "projects" || rest[1] === "projects") return false;
    inAppData = true;
  }
  if (inAppData) return true;
  return segments.some((segment) =>
    segment
      .toLowerCase()
      .split(/[-_. ]+/)
      .some((word) => AUTOMATED_FOLDER_WORDS.has(word)),
  );
}

/** The project's origin: the saved flag, else a temporary agent session, else its folder. */
export function projectOrigin(project: ProjectOriginInput): ProjectOrigin {
  const settings = project.workspaceSettings;
  if (settings?.origin === "user" || settings?.origin === "automated") return settings.origin;
  if (settings?.temporarySessionId !== undefined) return "automated";
  // The personal assistant is the person's own wherever its folder is.
  if (settings?.kind === "personal") return "user";
  return isAutomatedWorkspaceRoot(project.workspaceRoot) ? "automated" : "user";
}

export function isAutomatedProject(project: ProjectOriginInput): boolean {
  return projectOrigin(project) === "automated";
}
