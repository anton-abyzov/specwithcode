import type { OrchestrationV2TurnItem } from "@specweave-studio/contracts";
import type * as CodexSchema from "@specweave-studio/effect-codex-app-server/schema";
import { headedPatch } from "@specweave-studio/shared/structuredPatch";

type NativeChange = CodexSchema.V2ItemCompletedNotification__FileUpdateChange;
type FileChangeItem = Extract<OrchestrationV2TurnItem, { type: "file_change" }>;

/**
 * Keep every native operation and its patch; never infer a scope from prose.
 * Codex sends bare hunks (and plain content for adds and deletes), so each
 * patch gets file headers, and counted ranges where its `@@` lines have none.
 * The patches stay on `changes` only: an item-level `diffStr` joining them
 * would store every patch twice.
 */
export function projectCodexFileChanges(
  nativeChanges: ReadonlyArray<NativeChange>,
): Pick<FileChangeItem, "fileName" | "changes"> | null {
  if (nativeChanges.length === 0) return null;
  const changes = nativeChanges.map((change) => {
    if (!change.path.trim() || typeof change.diff !== "string") {
      throw new TypeError("Codex file change has no valid path or diff.");
    }
    const kind = change.kind.type;
    if (kind !== "add" && kind !== "delete" && kind !== "update") {
      throw new TypeError("Unsupported Codex file change operation.");
    }
    const movePath = change.kind.type === "update" ? change.kind.move_path : undefined;
    if (movePath != null && !movePath.trim()) {
      throw new TypeError("Codex file change has an invalid destination path.");
    }
    const operation = movePath == null ? kind : "move";
    const path = movePath ?? change.path;
    const headed = headedPatch({
      operation,
      path,
      ...(movePath == null ? {} : { oldPath: change.path }),
      body: change.diff,
    });
    return {
      operation,
      path,
      ...(movePath == null ? {} : { oldPath: change.path }),
      diffStr: headed.patch,
      ...(headed.synthesizedLineNumbers ? { diffNote: "line_numbers_synthesized" } : {}),
    };
  });
  return { fileName: changes[0]!.path, changes };
}

/** Each projected change as one approval line: its operation and path (a move names both). */
export function codexFileChangeScope(
  changes: NonNullable<FileChangeItem["changes"]>,
): ReadonlyArray<string> {
  return changes.map((change) =>
    change.operation === "move"
      ? `update ${change.oldPath} -> ${change.path}`
      : `${change.operation} ${change.path}`,
  );
}

/** Older approvals include the patch themselves, before any item notification. */
export function legacyCodexFileChanges(
  fileChanges: CodexSchema.ServerRequest__ApplyPatchApprovalParams["fileChanges"],
): ReadonlyArray<NativeChange> {
  return Object.entries(fileChanges).map(([path, change]) => {
    switch (change.type) {
      case "add":
      case "delete":
        return { path, kind: { type: change.type }, diff: change.content };
      case "update":
        return {
          path,
          kind: {
            type: "update",
            ...(change.move_path === undefined ? {} : { move_path: change.move_path }),
          },
          diff: change.unified_diff,
        };
      default:
        throw new TypeError("Unsupported Codex file change operation.");
    }
  });
}

/**
 * The agent's own explanation, kept to one labelled line after the scope so
 * it can add context but never stand in for what is being approved.
 */
function approvalReasonLine(reason: string | null | undefined): string[] {
  const text = reason?.replace(/\s+/g, " ").trim();
  return text ? [`Reason: ${text}`] : [];
}

/**
 * What a file-change approval allows: every path (the card scrolls, so none
 * is hidden), then the write grant, then the agent's reason.
 */
export function codexFileChangeApprovalPrompt(input: {
  readonly reason?: string | null | undefined;
  readonly grantRoot?: string | null | undefined;
  readonly fileChanges?: CodexSchema.ServerRequest__ApplyPatchApprovalParams["fileChanges"];
  /** Paths the turn already announced for this item, as `codexFileChangeScope` lists them. */
  readonly scope?: ReadonlyArray<string> | undefined;
}): string | undefined {
  const entries = Object.entries(input.fileChanges ?? {}).toSorted(([left], [right]) =>
    left.localeCompare(right),
  );
  const paths = entries.map(([path, change]) => {
    const movePath = change.type === "update" ? change.move_path : undefined;
    return movePath ? `${change.type} ${path} -> ${movePath}` : `${change.type} ${path}`;
  });
  const grantRoot = input.grantRoot?.trim();
  const lines = [
    ...(input.scope ?? []),
    ...paths,
    ...(grantRoot ? [`write ${grantRoot}`] : []),
    ...approvalReasonLine(input.reason),
  ];
  return lines.length > 0 ? lines.join("\n") : undefined;
}

/** One argument as a POSIX shell would read it back: quoted when it holds anything but safe characters. */
function shellArgument(argument: string): string {
  return /^[A-Za-z0-9_@%+=:,./-]+$/.test(argument)
    ? argument
    : `'${argument.replaceAll("'", `'\\''`)}'`;
}

/** An argument list as one command line that keeps each argument's boundaries. */
export function codexArgvCommandLine(argv: ReadonlyArray<string>): string {
  return argv.map(shellArgument).join(" ");
}

/**
 * What a command approval runs: the command first, then where and what it
 * reaches. Without any command text the card says so before the reason, so
 * the agent's explanation never reads as the thing being approved.
 */
export function codexCommandApprovalPrompt(input: {
  readonly command?: string | null | undefined;
  readonly argv?: ReadonlyArray<string> | undefined;
  readonly commandActions?: ReadonlyArray<{ readonly command: string }> | null | undefined;
  readonly cwd?: string | null | undefined;
  readonly networkApprovalContext?:
    | { readonly host: string; readonly protocol: string }
    | null
    | undefined;
  readonly reason?: string | null | undefined;
}): string {
  const actionCommands = (input.commandActions ?? [])
    .map((action) => action.command.trim())
    .filter((command) => command.length > 0);
  const command =
    input.command?.trim() ||
    (input.argv && input.argv.length > 0 ? codexArgvCommandLine(input.argv) : "") ||
    actionCommands.join("\n");
  const cwd = input.cwd?.trim();
  const network = input.networkApprovalContext;
  const lines = [
    command || "Command not shown by the agent",
    ...(cwd ? [`cwd ${cwd}`] : []),
    ...(network ? [`network ${network.protocol} ${network.host}`] : []),
    ...approvalReasonLine(input.reason),
  ];
  return lines.join("\n");
}

type PermissionPath = CodexSchema.PermissionsRequestApprovalParams__FileSystemPath;

function permissionPathLabel(path: PermissionPath): string {
  switch (path.type) {
    case "path":
      return path.path;
    case "glob_pattern":
      return path.pattern;
    case "special": {
      const special = path.value;
      switch (special.kind) {
        case "root":
          return "/ (the whole file system)";
        case "minimal":
          return "minimal system paths";
        case "project_roots":
          return special.subpath ? `project roots/${special.subpath}` : "project roots";
        case "tmpdir":
          return "the temporary folder";
        case "slash_tmp":
          return "/tmp";
        case "unknown":
          return [special.path, special.subpath].filter(Boolean).join("/") || "an unnamed path";
      }
    }
  }
}

/** What a permissions approval grants: each path with its access, and network. */
export function codexPermissionsApprovalPrompt(input: {
  readonly permissions: CodexSchema.PermissionsRequestApprovalParams["permissions"];
  readonly reason?: string | null;
}): string | undefined {
  const fileSystem = input.permissions.fileSystem;
  // A path can arrive in both the older read/write lists and the entries list.
  const scope = new Set<string>();
  for (const path of fileSystem?.read ?? []) scope.add(`read ${path}`);
  for (const path of fileSystem?.write ?? []) scope.add(`write ${path}`);
  for (const entry of fileSystem?.entries ?? [])
    scope.add(`${entry.access} ${permissionPathLabel(entry.path)}`);
  if (input.permissions.network?.enabled) scope.add("network");
  const lines = [...scope, ...approvalReasonLine(input.reason)];
  return lines.length > 0 ? lines.join("\n") : undefined;
}
