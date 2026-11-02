import type {
  ProjectNestedRepository,
  ProjectRepositoryPresence,
} from "@specweave-studio/contracts";

/** One copy's checkouts, sorted into what the Machines row says. */
export interface CopyRepositorySummary {
  readonly total: number;
  readonly present: number;
  readonly cloned: ReadonlyArray<string>;
  readonly missing: ReadonlyArray<string>;
  /** Something else sits at the path, or the clone failed: never changed from here. */
  readonly problems: ReadonlyArray<{ readonly name: string; readonly detail: string }>;
}

/** "acme/api", or with its folder when two checkouts share a name. */
function namer(repositories: ReadonlyArray<ProjectNestedRepository>) {
  const counts = new Map<string, number>();
  for (const entry of repositories) counts.set(entry.name, (counts.get(entry.name) ?? 0) + 1);
  const byPath = new Map(repositories.map((entry) => [entry.path, entry]));
  return (path: string) => {
    const entry = byPath.get(path);
    if (entry === undefined) return path;
    return (counts.get(entry.name) ?? 0) > 1 ? `${entry.name} (${entry.path})` : entry.name;
  };
}

export function summarizeCopyRepositories(
  repositories: ReadonlyArray<ProjectNestedRepository>,
  results: ReadonlyArray<ProjectRepositoryPresence>,
): CopyRepositorySummary {
  const name = namer(repositories);
  const of = (status: ProjectRepositoryPresence["status"]) =>
    results.filter((entry) => entry.status === status);
  return {
    total: repositories.length,
    present: of("present").length,
    cloned: of("cloned").map((entry) => name(entry.path)),
    missing: of("missing").map((entry) => name(entry.path)),
    problems: [...of("different"), ...of("failed")].map((entry) => ({
      name: name(entry.path),
      detail:
        entry.detail ??
        (entry.status === "failed" ? "The clone failed." : "Something else is there."),
    })),
  };
}

const list = (names: ReadonlyArray<string>) =>
  names.length <= 1 ? (names[0] ?? "") : `${names.slice(0, -1).join(", ")} and ${names.at(-1)}`;

/** The row's sentence about the copy's checkouts. */
export function copyRepositoryText(summary: CopyRepositorySummary): string {
  const parts: string[] = [];
  if (summary.cloned.length > 0) parts.push(`Cloned ${list(summary.cloned)}.`);
  if (summary.missing.length > 0)
    parts.push(
      `Missing ${list(summary.missing)}. A worker there clones ${summary.missing.length === 1 ? "it" : "them"} when its task needs ${summary.missing.length === 1 ? "it" : "them"}, or clone ${summary.missing.length === 1 ? "it" : "them"} now.`,
    );
  for (const problem of summary.problems) parts.push(`${problem.name}: ${problem.detail}`);
  if (parts.length === 0)
    return summary.total === 1
      ? "Has the project's repository."
      : `Has all ${summary.total} of the project's repositories.`;
  return parts.join(" ");
}
