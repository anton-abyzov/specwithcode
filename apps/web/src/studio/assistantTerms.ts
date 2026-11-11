/**
 * The personal assistant's words for what a project calls threads. A topic is a
 * thread: same record, id and history. Only what the person reads changes.
 */
import type { EnvironmentThreadShell } from "@specweave-studio/client-runtime/state/shell";
import type { ThreadPaneGroup } from "./shellModel";

/** What the assistant is called where its own title is not at hand. */
export const ASSISTANT_FALLBACK_NAME = "your assistant";

/** The assistant's title, or "your assistant" when it has none here. */
export function assistantNameOr(name: string | null | undefined): string {
  const trimmed = name?.trim();
  return trimmed ? trimmed : ASSISTANT_FALLBACK_NAME;
}

/** The composer placeholder in the assistant, with its own name. */
export function assistantComposerPlaceholder(name: string | null | undefined): string {
  return `Ask ${assistantNameOr(name)} anything`;
}

const REPLACEMENTS: ReadonlyArray<readonly [RegExp, string]> = [
  [/\bThreads\b/g, "Topics"],
  [/\bthreads\b/g, "topics"],
  [/\bThread\b/g, "Topic"],
  [/\bthread\b/g, "topic"],
];

function inAssistantWords(text: string, name: string): string {
  // The name goes in after the thread words, so a title like "Thread" stays as typed.
  return text
    .split(/\bthe coordinator\b/g)
    .map((part) => REPLACEMENTS.reduce((piece, [from, to]) => piece.replace(from, to), part))
    .join(name);
}

/**
 * A function that rewords a label for the personal assistant, calling it by
 * `name` (its title), and leaves a project's alone.
 */
export function paneWords(
  personal: boolean | undefined,
  name?: string | null | undefined,
): (text: string) => string {
  const called = assistantNameOr(name);
  return personal ? (text) => inAssistantWords(text, called) : (text) => text;
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
