/**
 * The personal assistant's words for what a project calls threads. A topic is a
 * thread: same record, id and history. Only what the person reads changes.
 */
import type { EnvironmentThreadShell } from "@specweave-studio/client-runtime/state/shell";
import type { ThreadPaneGroup } from "./shellModel";

export const ASSISTANT_COMPOSER_PLACEHOLDER = "Ask Aide anything";

const REPLACEMENTS: ReadonlyArray<readonly [RegExp, string]> = [
  [/\bthe coordinator\b/g, "Aide"],
  [/\bThreads\b/g, "Topics"],
  [/\bthreads\b/g, "topics"],
  [/\bThread\b/g, "Topic"],
  [/\bthread\b/g, "topic"],
];

function inAssistantWords(text: string): string {
  return REPLACEMENTS.reduce((result, [from, to]) => result.replace(from, to), text);
}

/** A function that rewords a label for the personal assistant, and leaves a project's alone. */
export function paneWords(personal: boolean | undefined): (text: string) => string {
  return personal ? inAssistantWords : (text) => text;
}

const isPinned = (thread: EnvironmentThreadShell) => thread.pinnedAt != null;

/**
 * A pinned topic is the long-lived kind, such as Taxes, so a quiet one leads the
 * list. One that needs the person or is running stays in that status's group.
 */
export function withPinnedTopics(groups: readonly ThreadPaneGroup[]): ThreadPaneGroup[] {
  const quiet = (group: ThreadPaneGroup["group"]) => group === "Idle" || group === "Resolved";
  const pinned = groups.flatMap((entry) =>
    quiet(entry.group) ? entry.threads.filter(isPinned) : [],
  );
  if (pinned.length === 0) return [...groups];
  return [
    { group: "Pinned", threads: pinned },
    ...groups.map((entry) =>
      quiet(entry.group)
        ? { ...entry, threads: entry.threads.filter((thread) => !isPinned(thread)) }
        : entry,
    ),
  ];
}
