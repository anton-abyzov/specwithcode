/**
 * First tasks offered while a project has no threads. The host reads the
 * project folder into `ProjectStarterSignals`; this turns those signals into a
 * short ordered list. The project view runs it too, with no signals, so a host
 * that cannot answer still leaves the person something to start from.
 *
 * Every `prompt` is written here. Text read from the repository (a commit
 * subject, an increment title) is shown in `detail` only, so nothing a file
 * says is ever sent to the coordinator as the person's own words. The one
 * exception is a file path, and only one that `isPlainSourcePath` accepts: no
 * spaces, quotes or other punctuation, so it can name a file but not say anything.
 *
 * @module projectStarterSuggestions
 */
import type { ProjectStarterSuggestion } from "@specweave-studio/contracts";

export interface ProjectStarterSignals {
  readonly kind: "code" | "personal";
  readonly goal: string;
  /** The project folder exists and holds something besides version-control metadata. */
  readonly hasWorkspace: boolean;
  readonly hasReadme: boolean;
  /** The command that runs the tests, composed from known tools only. */
  readonly testCommand: string | null;
  readonly todoCount: number;
  /** The scan stopped early, so `todoCount` is a lower bound. */
  readonly todoCountIsFloor: boolean;
  /** Newest first. */
  readonly recentCommitSubjects: readonly string[];
  readonly uncommittedFiles: number;
  /** Open SpecWeave increments, newest first. */
  readonly openIncrements: ReadonlyArray<{ readonly id: string; readonly title: string }>;
  readonly hasRecentHandoff: boolean;
  /** The increment whose own handoff note is the fresh one, when the handoff names one. */
  readonly handoffIncrement: string | null;
  /** Source files changed most often in recent commits, most often first. */
  readonly frequentlyChangedFiles: ReadonlyArray<{
    readonly path: string;
    readonly commits: number;
  }>;
  /** Commands that lint and typecheck the project, composed from known tools only. */
  readonly lintCommand: string | null;
  readonly typecheckCommand: string | null;
  readonly hasMemory: boolean;
}

/** What is known before the host has looked: a code project with an unread folder. */
export const UNREAD_STARTER_SIGNALS: ProjectStarterSignals = {
  kind: "code",
  goal: "",
  hasWorkspace: true,
  hasReadme: true,
  testCommand: null,
  todoCount: 0,
  todoCountIsFloor: false,
  recentCommitSubjects: [],
  uncommittedFiles: 0,
  openIncrements: [],
  hasRecentHandoff: false,
  handoffIncrement: null,
  frequentlyChangedFiles: [],
  lintCommand: null,
  typecheckCommand: null,
  hasMemory: false,
};

export const STARTER_SUGGESTION_LIMIT = 6;
/** Fewer than this is noise, not a backlog worth a thread. */
const TODO_FLOOR = 3;
const INCREMENT_ID = /^\d{3,5}[A-Z]?-[a-z0-9]+(?:-[a-z0-9]+)*$/;
/** Path segments of letters, digits and `._@+-`, none of them only dots. */
const PLAIN_PATH = /^(?:[\w@+-][\w.@+-]*\/)*[\w@+-][\w.@+-]*$/;
const PLAIN_PATH_LENGTH = 160;
/** What a card title has room for around a file name. */
const FILE_NAME_LENGTH = 56;

/**
 * A repository path plain enough to quote in a prompt: it can name a file, but
 * with no spaces, quotes or punctuation it cannot carry a sentence.
 */
export function isPlainSourcePath(path: string): boolean {
  return path.length <= PLAIN_PATH_LENGTH && PLAIN_PATH.test(path);
}

function fileName(path: string): string {
  return path.slice(path.lastIndexOf("/") + 1);
}

const EXPLAIN_TITLE = /^Explain how (\S+) works$/;

/**
 * A Claude Code style hint for an empty composer, from the file the "explain"
 * card names, or null when no such card was offered.
 */
export function starterComposerHint(
  suggestions: readonly ProjectStarterSuggestion[],
): string | null {
  const name = suggestions.find((entry) => entry.id === "explain")?.title.match(EXPLAIN_TITLE)?.[1];
  // A name cut to fit the card is not one the person could type.
  return name && !name.endsWith("…") ? `Try "how does ${name} work?"` : null;
}

/** One line of someone else's text, cut to fit a card. */
function excerpt(text: string, limit: number): string {
  const line = text.replace(/\s+/g, " ").trim();
  return line.length <= limit ? line : `${line.slice(0, limit - 1).trimEnd()}…`;
}

function thread(title: string, task: string): string {
  return `Start a thread titled "${title}". ${task}`;
}

function plural(count: number, one: string, many: string): string {
  return count === 1 ? one : many;
}

function goalSuggestion(signals: ProjectStarterSignals): ProjectStarterSuggestion | null {
  if (signals.goal.trim() === "") return null;
  const reading =
    signals.kind === "code" && signals.hasWorkspace
      ? "Read this project's goal and the repository"
      : "Read this project's goal";
  return {
    id: "goal",
    topic: "goal",
    origin: "goal",
    title: "Plan the first steps toward the goal",
    detail: excerpt(signals.goal, 160),
    prompt: thread(
      "Plan the first steps",
      `${reading}, then propose the first three to five tasks that move it forward, smallest useful one first. Do not change any files yet.`,
    ),
  };
}

function repositorySuggestions(signals: ProjectStarterSignals): ProjectStarterSuggestion[] {
  const found: ProjectStarterSuggestion[] = [];
  const handedOff =
    signals.handoffIncrement !== null && INCREMENT_ID.test(signals.handoffIncrement)
      ? signals.handoffIncrement
      : null;
  if (signals.hasRecentHandoff)
    found.push({
      id: "handoff",
      topic: "handoff",
      origin: "specweave",
      title: handedOff
        ? `Pick up the handoff for ${handedOff.split("-")[0]}`
        : "Pick up the latest handoff",
      detail: "Another session handed its work off in this repository. Continue where it stopped.",
      prompt: thread(
        "Pick up the handoff",
        handedOff
          ? `Run \`specweave pickup ${handedOff}\` in this project, read .specweave/increments/${handedOff}/handoff.md and continue the task it names. Report what you picked up and what is left.`
          : "Run `specweave pickup` in this project and continue the task it names. Report what you picked up and what is left.",
      ),
    });
  const increment = signals.openIncrements.find(
    (entry) => INCREMENT_ID.test(entry.id) && !(signals.hasRecentHandoff && entry.id === handedOff),
  );
  if (increment) {
    const others = signals.openIncrements.length - 1;
    const name = excerpt(increment.title, 90) || increment.id;
    found.push({
      id: "increment",
      topic: "increment",
      origin: "specweave",
      title: `Continue increment ${increment.id.split("-")[0]}`,
      detail:
        others > 0
          ? `${name}. ${others} other ${plural(others, "increment is", "increments are")} open too.`
          : `${name} is still open.`,
      prompt: thread(
        `Continue increment ${increment.id.split("-")[0]}`,
        `Read .specweave/increments/${increment.id}/spec.md, claim the next open task and work it to its acceptance criteria. Report what you finished and what is left.`,
      ),
    });
  }
  const goal = goalSuggestion(signals);
  if (goal) found.push(goal);
  if (signals.uncommittedFiles > 0)
    found.push({
      id: "changes",
      topic: "changes",
      origin: "repository",
      title: `Review ${signals.uncommittedFiles} uncommitted ${plural(signals.uncommittedFiles, "change", "changes")}`,
      detail:
        "Work in this checkout that is not committed yet. Find out what it does and whether it is finished.",
      prompt: thread(
        "Review uncommitted changes",
        "Read the uncommitted changes in this checkout, say what they do and whether they are finished, and list anything risky. Do not commit, discard or edit anything.",
      ),
    });
  const [hottest, runnerUp] = signals.frequentlyChangedFiles.filter((file) =>
    isPlainSourcePath(file.path),
  );
  if (hottest) {
    const name = excerpt(fileName(hottest.path), FILE_NAME_LENGTH);
    found.push({
      id: "explain",
      topic: "explore",
      origin: "repository",
      title: `Explain how ${name} works`,
      detail: `${hottest.path} is among the most changed files, in ${hottest.commits} recent ${plural(hottest.commits, "commit", "commits")}.`,
      prompt: thread(
        `Explain ${fileName(hottest.path)}`,
        `Read \`${hottest.path}\` and explain how it works: what it is for, its main parts, what calls it and what it depends on. Do not change any files.`,
      ),
    });
  }
  if (signals.testCommand)
    found.push({
      id: "tests",
      topic: "tests",
      origin: "repository",
      title: "Run the tests and fix what fails",
      detail: `Runs ${signals.testCommand} and repairs any failure it finds.`,
      prompt: thread(
        "Run the tests",
        `Run this project's test suite (${signals.testCommand}), then fix what fails without weakening or skipping any test. Report the results before and after.`,
      ),
    });
  const checks = [signals.lintCommand, signals.typecheckCommand].filter(
    (command) => command !== null,
  );
  if (checks.length > 0) {
    const what =
      signals.lintCommand && signals.typecheckCommand
        ? "lint and type errors"
        : signals.lintCommand
          ? "lint errors"
          : "type errors";
    found.push({
      id: "checks",
      topic: "tests",
      origin: "repository",
      title: `Fix ${what}`,
      detail: `Runs ${checks.join(" and ")} and fixes what they report.`,
      prompt: thread(
        `Fix ${what}`,
        `Run ${checks.map((command) => `\`${command}\``).join(" and ")}, then fix what they report without disabling rules, adding ignore comments or loosening types. Report the results before and after.`,
      ),
    });
  }
  // A second file when there is one, so the two file cards do not repeat each other.
  const untested = runnerUp ?? hottest;
  if (untested) {
    const name = excerpt(fileName(untested.path), FILE_NAME_LENGTH);
    found.push({
      id: "write-tests",
      topic: "tests",
      origin: "repository",
      title: `Write tests for ${name}`,
      detail: `${untested.path} changes often. Cover the behaviour its tests miss.`,
      prompt: thread(
        `Write tests for ${fileName(untested.path)}`,
        `Read \`${untested.path}\` and its existing tests, then add tests for behaviour that is not covered yet, following the project's test conventions. Run them and report the results. Change only test files.`,
      ),
    });
  }
  if (signals.todoCount >= TODO_FLOOR) {
    const count =
      signals.todoCount > 99 ? "99+" : `${signals.todoCount}${signals.todoCountIsFloor ? "+" : ""}`;
    found.push({
      id: "todos",
      topic: "todos",
      origin: "repository",
      title: `Triage ${count} TODO notes`,
      detail: "TODO and FIXME comments left in the code. Sort out which still matter.",
      prompt: thread(
        "Triage TODOs",
        "Find the TODO and FIXME comments in this repository, group them by area, and say which are still relevant and which three are worth doing first. Do not change any files.",
      ),
    });
  }
  const latest = signals.recentCommitSubjects[0];
  if (latest)
    found.push({
      id: "commits",
      topic: "commits",
      origin: "repository",
      title: "Catch up on recent work",
      detail: `Latest commit: ${excerpt(latest, 120)}`,
      prompt: thread(
        "Summarize recent work",
        "Read the last twenty commits and summarize what changed, what looks unfinished and what a sensible next step is. Do not change any files.",
      ),
    });
  if (!signals.hasReadme)
    found.push({
      id: "readme",
      topic: "readme",
      origin: "repository",
      title: "Write a README",
      detail: "This project has no README yet.",
      prompt: thread(
        "Write a README",
        "Read the project and write a README.md that says what it is and how to install, run and test it. Keep it short and accurate.",
      ),
    });
  return found;
}

const ROUTINE: ProjectStarterSuggestion = {
  id: "routine",
  topic: "routine",
  origin: "common",
  title: "Set up a routine",
  detail: "Have a recurring check run on a schedule, such as a daily review of open work.",
  prompt:
    "Help me set up a routine for this project. Suggest two or three recurring checks that would be useful here, such as a daily review of open work, and ask me which one to schedule before creating anything.",
};

function commonSuggestions(signals: ProjectStarterSignals): ProjectStarterSuggestion[] {
  if (signals.kind === "personal")
    return [
      {
        id: "capabilities",
        topic: "capabilities",
        origin: "common",
        title: "Show me what you can do",
        detail: "A short tour of what this assistant can take on, with examples to try.",
        prompt:
          "Tell me what you can do for me in this project, with three concrete examples I could ask for right now. Keep it short.",
      },
      ...(signals.hasMemory
        ? []
        : [
            {
              id: "memory",
              topic: "memory",
              origin: "common",
              title: "Teach it how you work",
              detail: "Answer a few questions once and every later thread starts from them.",
              prompt:
                "Ask me five short questions about how I like to work and what I use this assistant for, then save my answers as project memory with a short MEMORY.md index. Store no secrets.",
            } as const,
          ]),
      ROUTINE,
    ];
  const first: ProjectStarterSuggestion = signals.hasWorkspace
    ? {
        id: "explore",
        topic: "explore",
        origin: "common",
        title: "Explore the codebase",
        detail: "Map the main parts, the entry points and how to build, test and run it.",
        prompt: thread(
          "Explore the codebase",
          "Map this repository: what it does, its main parts and entry points, and how to build, test and run it. Report a short summary and do not change any files.",
        ),
      }
    : {
        id: "scaffold",
        topic: "scaffold",
        origin: "common",
        title: "Scaffold the project",
        detail: "The project folder is empty. Agree on a first working skeleton.",
        prompt: thread(
          "Scaffold the project",
          "This project's folder is empty. Ask me what I want to build if the goal does not say, then propose a minimal structure and wait for my go-ahead before creating files.",
        ),
      };
  return [
    first,
    ...(signals.hasMemory || !signals.hasWorkspace
      ? []
      : [
          {
            id: "memory",
            topic: "memory",
            origin: "common",
            title: "Write project memory",
            detail: "Save the conventions, commands and decisions every thread should know.",
            prompt: thread(
              "Write project memory",
              "Learn this project's conventions, commands and key decisions from the repository, then save them as project memory with a short MEMORY.md index. Store no secrets.",
            ),
          } as const,
        ]),
    ROUTINE,
  ];
}

/** What the project found first, then the ideas that fit any project, six at most. */
export function buildStarterSuggestions(
  signals: ProjectStarterSignals,
): ProjectStarterSuggestion[] {
  const common = commonSuggestions(signals);
  const specific =
    signals.kind === "code" && signals.hasWorkspace
      ? repositorySuggestions(signals)
      : [goalSuggestion(signals)].filter((entry) => entry !== null);
  return [...specific.slice(0, STARTER_SUGGESTION_LIMIT - common.length), ...common];
}
