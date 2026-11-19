import { useAtomRefresh, useAtomValue } from "@effect/atom-react";
import type { VcsStatusResult } from "@specweave-studio/contracts";
import * as Option from "effect/Option";
import { AsyncResult, Atom } from "effect/reactivity";

/** The git status fields the chat view reads. */
export type ChatGitStatus = Pick<
  VcsStatusResult,
  "isRepo" | "refName" | "pr" | "hasWorkingTreeChanges"
>;

type VcsStatusAtom = Atom.Atom<AsyncResult.AsyncResult<VcsStatusResult, unknown>>;

export function selectChatGitStatus(status: VcsStatusResult | null): ChatGitStatus | null {
  if (status === null) return null;
  const { isRepo, refName, pr, hasWorkingTreeChanges } = status;
  return { isRepo, refName, pr, hasWorkingTreeChanges };
}

function shallowRecordEqual(a: object, b: object): boolean {
  const left = a as Record<string, unknown>;
  const right = b as Record<string, unknown>;
  const leftKeys = Object.keys(left);
  if (leftKeys.length !== Object.keys(right).length) return false;
  return leftKeys.every((key) => Object.is(left[key], right[key]));
}

export function chatGitStatusEqual(a: ChatGitStatus | null, b: ChatGitStatus | null): boolean {
  if (a === b) return true;
  if (a === null || b === null) return false;
  if (
    a.isRepo !== b.isRepo ||
    a.refName !== b.refName ||
    a.hasWorkingTreeChanges !== b.hasWorkingTreeChanges
  ) {
    return false;
  }
  if (a.pr === b.pr) return true;
  if (a.pr === null || b.pr === null) return false;
  return shallowRecordEqual(a.pr, b.pr);
}

export const chatGitStatusAtom = Atom.family((status: VcsStatusAtom) =>
  Atom.map(status, (result) =>
    selectChatGitStatus(Option.getOrNull(AsyncResult.value(result))),
  ).pipe(Atom.withEquality(chatGitStatusEqual)),
);

const NO_CHAT_GIT_STATUS_ATOM = Atom.make<ChatGitStatus | null>(null).pipe(
  Atom.withLabel("web-chat-git-status:none"),
);
const NO_VCS_STATUS_ATOM: VcsStatusAtom = Atom.make(
  AsyncResult.initial<VcsStatusResult, unknown>(false),
).pipe(Atom.withLabel("web-chat-git-status:none-source"));

/**
 * The chat view's git status: only the fields it reads, compared by value, so
 * a status update that changes file counts alone does not re-render it.
 * `refresh` still refreshes the full status subscription.
 */
export function useChatGitStatus(atom: VcsStatusAtom | null): {
  readonly data: ChatGitStatus | null;
  readonly refresh: () => void;
} {
  const data = useAtomValue(atom ? chatGitStatusAtom(atom) : NO_CHAT_GIT_STATUS_ATOM);
  const refresh = useAtomRefresh(atom ?? NO_VCS_STATUS_ATOM);
  return { data, refresh };
}
