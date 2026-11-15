import type { VcsStatusResult } from "@specweave-studio/contracts";
import { AsyncResult, Atom, AtomRegistry } from "effect/reactivity";
import { describe, expect, it } from "vite-plus/test";

import { chatGitStatusAtom, chatGitStatusEqual, selectChatGitStatus } from "./chatGitStatus";

const status = (changes: Partial<VcsStatusResult> = {}): VcsStatusResult => ({
  isRepo: true,
  hasPrimaryRemote: true,
  isDefaultRef: false,
  refName: "feature",
  hasWorkingTreeChanges: true,
  workingTree: { files: [], insertions: 1, deletions: 0 },
  hasUpstream: true,
  aheadCount: 0,
  behindCount: 0,
  pr: null,
  ...changes,
});

const pr = () => ({
  number: 7,
  title: "Add the thing",
  url: "https://example.test/pull/7",
  baseRef: "main",
  headRef: "feature",
  state: "open" as const,
});

function fileCountUpdate(index: number): VcsStatusResult {
  return status({
    pr: pr(),
    workingTree: {
      files: Array.from({ length: index + 1 }, (_, file) => ({
        path: `src/file-${file}.ts`,
        insertions: file + 1,
        deletions: 0,
      })),
      insertions: index + 1,
      deletions: 0,
    },
    aheadCount: index,
  });
}

describe("chat view git status", () => {
  it("keeps only the fields the chat view reads", () => {
    expect(selectChatGitStatus(fileCountUpdate(3))).toEqual({
      isRepo: true,
      refName: "feature",
      hasWorkingTreeChanges: true,
      pr: pr(),
    });
    expect(selectChatGitStatus(null)).toBeNull();
  });

  it("compares the read fields by value", () => {
    expect(chatGitStatusEqual(selectChatGitStatus(status()), selectChatGitStatus(status()))).toBe(
      true,
    );
    expect(
      chatGitStatusEqual(
        selectChatGitStatus(status({ pr: pr() })),
        selectChatGitStatus(status({ pr: { ...pr(), state: "merged" } })),
      ),
    ).toBe(false);
    expect(chatGitStatusEqual(null, selectChatGitStatus(status()))).toBe(false);
  });

  it("does not notify when only file counts change", () => {
    const registry = AtomRegistry.make();
    const source = Atom.make<AsyncResult.AsyncResult<VcsStatusResult, unknown>>(
      AsyncResult.success(fileCountUpdate(0)),
    );
    const selected = chatGitStatusAtom(source);
    const notified: unknown[] = [];
    const unsubscribe = registry.subscribe(selected, (value) => notified.push(value));
    const first = registry.get(selected);
    notified.length = 0;

    for (let index = 1; index <= 50; index += 1) {
      registry.set(source, AsyncResult.success(fileCountUpdate(index)));
    }
    expect(notified).toHaveLength(0);
    expect(registry.get(selected)).toBe(first);

    registry.set(source, AsyncResult.success(status({ pr: pr(), refName: "other" })));
    expect(notified).toHaveLength(1);
    registry.set(
      source,
      AsyncResult.success(status({ pr: pr(), refName: "other", hasWorkingTreeChanges: false })),
    );
    expect(notified).toHaveLength(2);
    registry.set(
      source,
      AsyncResult.success(
        status({ pr: { ...pr(), number: 8 }, refName: "other", hasWorkingTreeChanges: false }),
      ),
    );
    expect(notified).toHaveLength(3);
    unsubscribe();
  });
});
