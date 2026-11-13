/**
 * The repositories a task names, for a thread that starts with Use worktrees
 * on in a project folder of separate clones. The server picks a launch's
 * worktrees with it and the web composer shows the same pick while the
 * message is typed, so the hint is the launch.
 *
 * Only unambiguous mentions count: a repository's path relative to the
 * project folder, or a file under it, also inside an absolute path from any
 * machine; and a repository's name or path in backticks. A bare word never
 * counts, so a product name in prose picks nothing, and a URL never counts,
 * so a pull request link does not check out its repository.
 *
 * @module taskRepositories
 */

export interface TaskRepository {
  /**
   * POSIX path relative to the project folder. The folder itself (".") and a
   * repository outside it (an absolute or "../" path) are never picked.
   */
  readonly relativePath: string;
  readonly name: string;
}

export interface TaskRepositoryMention {
  readonly relativePath: string;
  readonly name: string;
  /** The path or name in the task that named it. */
  readonly evidence: string;
}

export interface TaskRepositoryPick {
  /** What a new thread starts with: `named`, or nothing when it names more than the maximum. */
  readonly picked: ReadonlyArray<TaskRepositoryMention>;
  /** Every repository the task names, in order of first mention. */
  readonly named: ReadonlyArray<TaskRepositoryMention>;
}

/** More named repositories than this reads as a list (a pasted inventory), not a task. */
export const TASK_REPOSITORIES_MAX = 4;

const SCAN_LIMIT = 100_000;
const EVIDENCE_LIMIT = 120;
const NONE: TaskRepositoryPick = { picked: [], named: [] };

const isSpace = (ch: string) => /\s/u.test(ch);
/** Where a path may start: the text's start, a space, a separator, a quote or an opening bracket. */
const opensPath = (ch: string) => ch === "" || isSpace(ch) || "/`'\"([<{:=,;".includes(ch);
/** Where a path may end with nothing under it. */
const closesPath = (ch: string) => ch === "" || isSpace(ch) || "`'\")]>},;:!?".includes(ch);
/** Where the word holding a mention stops, both ways. */
const endsToken = (ch: string) => isSpace(ch) || "`'\"()[]<>{},;".includes(ch);

function tokenBounds(text: string, start: number, end: number) {
  let from = start;
  while (from > 0 && !endsToken(text[from - 1]!)) from -= 1;
  let to = end;
  while (to < text.length && !endsToken(text[to]!)) to += 1;
  // A sentence's full stop or colon is not part of the path.
  while (to > end && ".:!?".includes(text[to - 1]!)) to -= 1;
  return { from, to };
}

const evidenceOf = (text: string) =>
  text.length <= EVIDENCE_LIMIT ? text : `${text.slice(0, EVIDENCE_LIMIT - 1)}…`;

/**
 * The repositories `text` names among `repositories`, longest path first so
 * `repositories/o/app-dev/x.ts` never names `repositories/o/app`. A
 * one-segment path (`api`) counts only with a file under it (`api/src/x.ts`)
 * or in backticks; a name in backticks counts only when no other repository
 * has it.
 */
export function repositoriesNamedInTask(
  text: string,
  repositories: ReadonlyArray<TaskRepository>,
): TaskRepositoryPick {
  const candidates = [...repositories]
    .filter(
      ({ relativePath }) =>
        relativePath !== "" &&
        relativePath !== "." &&
        !relativePath.startsWith("/") &&
        !relativePath.startsWith("..") &&
        !/^[A-Za-z]:[\\/]/u.test(relativePath),
    )
    .sort((left, right) => right.relativePath.length - left.relativePath.length);
  if (text.trim() === "" || candidates.length === 0) return NONE;
  // Windows paths read like POSIX ones; the length stays the same.
  let scan = text.slice(0, SCAN_LIMIT).replaceAll("\\", "/");
  const found = new Map<string, TaskRepositoryMention & { readonly at: number }>();
  const record = (repository: TaskRepository, at: number, evidence: string) => {
    const seen = found.get(repository.relativePath);
    if (seen !== undefined && seen.at <= at) return;
    found.set(repository.relativePath, {
      relativePath: repository.relativePath,
      name: repository.name,
      evidence: evidenceOf(evidence),
      at,
    });
  };
  const blank = (from: number, to: number) => {
    scan = `${scan.slice(0, from)}${" ".repeat(to - from)}${scan.slice(to)}`;
  };

  for (const repository of candidates) {
    const path = repository.relativePath;
    const oneSegment = !path.includes("/");
    let index = scan.indexOf(path);
    while (index !== -1) {
      const end = index + path.length;
      const before = scan[index - 1] ?? "";
      const after = scan[end] ?? "";
      const next = scan[end + 1] ?? "";
      const underIt = after === "/";
      const quoted = before === "`" && after === "`";
      const alone =
        closesPath(after) || (after === "." && (next === "" || isSpace(next) || next === "`"));
      const { from, to } = tokenBounds(scan, index, end);
      const token = scan.slice(from, to);
      const named =
        opensPath(before) &&
        !token.includes("://") &&
        (underIt || quoted || (!oneSegment && alone));
      if (named) {
        record(repository, index, token);
        blank(from, to);
      }
      index = scan.indexOf(path, named ? to : index + 1);
    }
  }

  const names = new Map<string, number>();
  for (const repository of candidates)
    names.set(repository.name, (names.get(repository.name) ?? 0) + 1);
  for (const repository of candidates) {
    if (names.get(repository.name) !== 1) continue;
    const quoted = `\`${repository.name}\``;
    const at = scan.indexOf(quoted);
    if (at !== -1) record(repository, at, quoted);
  }

  const named = [...found.values()]
    .sort((left, right) => left.at - right.at)
    .map(({ relativePath, name, evidence }) => ({ relativePath, name, evidence }));
  return { picked: named.length <= TASK_REPOSITORIES_MAX ? named : [], named };
}

/** "vskill", "vskill and specweave", "vskill, specweave and 2 more". */
export function taskRepositoryNames(mentions: ReadonlyArray<TaskRepositoryMention>): string {
  const names = mentions.map((mention) => mention.name);
  if (names.length <= 2) return names.join(" and ");
  if (names.length === 3) return `${names[0]}, ${names[1]} and ${names[2]}`;
  return `${names[0]}, ${names[1]} and ${names.length - 2} more`;
}
