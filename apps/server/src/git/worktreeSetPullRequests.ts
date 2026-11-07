/**
 * The note each pull request of a worktree set (../worktreeSet.ts) carries:
 * the other repositories' pull requests, the shared branch and the increment.
 * It sits between two HTML comments, so it can be rewritten once every pull
 * request exists without touching the rest of the description.
 *
 * @module worktreeSetPullRequests
 */
import * as Effect from "effect/Effect";
import * as Result from "effect/Result";

const START = "<!-- specwithcode:worktree-set -->";
const END = "<!-- /specwithcode:worktree-set -->";

export interface WorktreeSetPullRequestEntry {
  /** The repository's name, such as `acme/api` or its folder. */
  readonly label: string;
  /** Its pull request, once opened. */
  readonly url?: string | undefined;
}

export function worktreeSetPullRequestNote(input: {
  readonly branch: string;
  readonly incrementId: string | null;
  readonly entries: ReadonlyArray<WorktreeSetPullRequestEntry>;
}): string {
  const scope = input.incrementId === null ? "" : ` for increment \`${input.incrementId}\``;
  const lines = input.entries.map(
    (entry) => `- \`${entry.label}\`: ${entry.url ?? "pull request to follow"}`,
  );
  return [
    START,
    `One change across ${input.entries.length} repositories on branch \`${input.branch}\`${scope}. Each merges on its own checks:`,
    "",
    ...lines,
    END,
  ].join("\n");
}

/** `body` with its set note replaced by `note`, or `note` appended when it has none. */
export function replaceWorktreeSetPullRequestNote(body: string, note: string): string {
  const start = body.indexOf(START);
  const end = start === -1 ? -1 : body.indexOf(END, start);
  if (start === -1 || end === -1) return `${body.trimEnd()}\n\n${note}`;
  return `${body.slice(0, start)}${note}${body.slice(end + END.length)}`;
}

export interface WorktreeSetOpenedPullRequest {
  readonly label: string;
  readonly cwd: string;
  readonly number: number;
  readonly url: string;
  readonly created: boolean;
}

/**
 * Opens a pull request for each ready repository in order, each carrying the
 * set note as it stands (so later ones link the earlier ones), then rewrites
 * every opened one so all link each other. `open` returns null when it left
 * no pull request, and fails with a sentence; `edit` failures are reported,
 * never fatal. A single ready repository gets no note.
 */
export const openWorktreeSetPullRequests = Effect.fn("worktreeSet.openPullRequests")(
  function* (input: {
    readonly branch: string;
    readonly incrementId: string | null;
    readonly ready: ReadonlyArray<{ readonly label: string; readonly cwd: string }>;
    readonly open: (
      entry: { readonly label: string; readonly cwd: string },
      note: string | undefined,
    ) => Effect.Effect<
      { readonly number: number; readonly url: string; readonly created: boolean } | null,
      string
    >;
    readonly edit: (
      pr: WorktreeSetOpenedPullRequest,
      rewrite: (body: string) => string,
    ) => Effect.Effect<void, string>;
  }) {
    const opened: Array<WorktreeSetOpenedPullRequest> = [];
    const problems: Array<string> = [];
    const note = (): string =>
      worktreeSetPullRequestNote({
        branch: input.branch,
        incrementId: input.incrementId,
        entries: input.ready.map((entry) => ({
          label: entry.label,
          url: opened.find((pr) => pr.label === entry.label)?.url,
        })),
      });
    const linked = input.ready.length > 1;
    for (const entry of input.ready) {
      const result = yield* input.open(entry, linked ? note() : undefined).pipe(Effect.result);
      if (Result.isFailure(result)) {
        problems.push(result.failure);
        continue;
      }
      if (result.success !== null) opened.push({ ...entry, ...result.success });
    }
    if (linked && opened.length > 0) {
      const final = note();
      for (const pr of opened) {
        const edited = yield* input
          .edit(pr, (body) => replaceWorktreeSetPullRequestNote(body, final))
          .pipe(Effect.result);
        if (Result.isFailure(edited)) problems.push(`${pr.label} links: ${edited.failure}`);
      }
    }
    return { opened, problems };
  },
);
