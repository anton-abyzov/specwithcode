// @effect-diagnostics nodeBuiltinImport:off - Scratch worktrees with links in them.
import * as NodeFS from "node:fs";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";

import { HostProcessPlatform } from "@specweave-studio/shared/hostProcess";
import { afterEach, describe, expect, it } from "@effect/vitest";
import { ThreadId, type ThreadIncrementProgress } from "@specweave-studio/contracts";

import {
  branchNamesIncrement,
  decideOwnership,
  ledgerPathsInside,
  namesIncrement,
  recheckTarget,
} from "./ownership.ts";

const isWindows = HostProcessPlatform.defaultValue() === "win32";
const INCREMENT = "1497-ledger-tools";
const roots: string[] = [];

function scratch() {
  const root = NodeFS.realpathSync(NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "sw-own-")));
  roots.push(root);
  const worktree = NodePath.join(root, "worktree");
  const increment = NodePath.join(worktree, ".specweave", "increments", INCREMENT);
  NodeFS.mkdirSync(increment, { recursive: true });
  NodeFS.writeFileSync(NodePath.join(worktree, ".specweave", "config.json"), "{}\n");
  NodeFS.writeFileSync(NodePath.join(increment, "spec.md"), "# x\n");
  NodeFS.writeFileSync(NodePath.join(increment, "ledger.jsonl"), "");
  NodeFS.writeFileSync(NodePath.join(increment, "metadata.json"), "{}\n");
  return { root, worktree, increment };
}

afterEach(() => {
  for (const root of roots.splice(0)) NodeFS.rmSync(root, { recursive: true, force: true });
});

const bound = (
  incrementPath: string,
  binding: ThreadIncrementProgress["binding"] = "claim",
  incrementId = INCREMENT,
): ThreadIncrementProgress => ({
  threadId: ThreadId.make("thread-own"),
  incrementId,
  binding,
  boundTaskId: null,
  title: null,
  status: "active",
  incrementPath,
  specPath: null,
  readable: true,
  tasks: [],
  criteria: [],
  verify: null,
});

describe("namesIncrement", () => {
  it("takes a number or the full folder name, nothing looser", () => {
    expect(namesIncrement("1497", INCREMENT)).toBe(true);
    expect(namesIncrement(INCREMENT, INCREMENT)).toBe(true);
    expect(namesIncrement("149", INCREMENT)).toBe(false);
    expect(namesIncrement("1497-ledger", INCREMENT)).toBe(true);
    expect(namesIncrement("1498", INCREMENT)).toBe(false);
  });
});

describe("decideOwnership (1497)", () => {
  it("accepts the thread's assigned increment in its own worktree", async () => {
    const { worktree, increment } = scratch();
    for (const binding of ["manual", "claim", "branch"] as const) {
      const result = await decideOwnership({
        worktreePath: worktree,
        branch: "inc/1497-ledger-tools",
        requested: "1497",
        bound: bound(increment, binding),
      });
      expect(result).toEqual({
        ok: true,
        target: {
          workspace: worktree,
          specweaveRoot: worktree,
          incrementId: INCREMENT,
          incrementDir: increment,
        },
      });
    }
  });

  it("refuses a thread with no worktree, or one whose worktree is gone", async () => {
    const shared = await decideOwnership({
      worktreePath: null,
      requested: "1497",
      bound: undefined,
    });
    expect(shared).toMatchObject({ ok: false, code: "capability_denied" });
    expect(!shared.ok && shared.message).toContain("has none");
    const gone = await decideOwnership({
      worktreePath: "/nonexistent/worktree",
      requested: "1497",
      bound: undefined,
    });
    expect(gone).toMatchObject({ ok: false, code: "capability_denied" });
    expect(!gone.ok && gone.message).toContain("missing on this machine");
  });

  it("refuses a thread with no assigned increment, a guessed one, or another one", async () => {
    const { worktree, increment } = scratch();
    const none = await decideOwnership({
      worktreePath: worktree,
      requested: "1497",
      bound: undefined,
    });
    expect(none).toMatchObject({ ok: false, code: "capability_denied" });
    expect(!none.ok && none.message).toContain("no increment assigned");
    for (const binding of ["name", "checkpoint"] as const) {
      const guessed = await decideOwnership({
        worktreePath: worktree,
        requested: "1497",
        bound: bound(increment, binding),
      });
      expect(guessed).toMatchObject({ ok: false, code: "capability_denied" });
      expect(!guessed.ok && guessed.message).toContain("only guessed");
    }
    const other = await decideOwnership({
      worktreePath: worktree,
      requested: "1490",
      bound: bound(increment),
    });
    expect(other).toMatchObject({ ok: false, code: "capability_denied" });
    expect(!other.ok && other.message).toContain(`owns increment ${INCREMENT}, not 1490`);
  });

  it("writes to the worktree's copy even when the binding points at the shared folder", async () => {
    const { root, worktree, increment } = scratch();
    const shared = NodePath.join(root, "shared", ".specweave", "increments", INCREMENT);
    NodeFS.mkdirSync(shared, { recursive: true });
    const result = await decideOwnership({
      worktreePath: worktree,
      requested: "1497",
      bound: bound(shared),
    });
    expect(result).toMatchObject({ ok: true, target: { incrementDir: increment } });
  });

  it("refuses when the worktree has no copy of the increment", async () => {
    const { root, worktree } = scratch();
    const elsewhere = NodePath.join(root, "shared", ".specweave", "increments", "1500-other");
    NodeFS.mkdirSync(elsewhere, { recursive: true });
    const result = await decideOwnership({
      worktreePath: worktree,
      requested: "1500",
      bound: bound(elsewhere, "manual", "1500-other"),
    });
    expect(result).toMatchObject({ ok: false, code: "capability_denied" });
    expect(!result.ok && result.message).toContain("not in this thread's worktree");
  });

  it("follows a nested SpecWeave folder inside the worktree", async () => {
    const { worktree } = scratch();
    const nested = NodePath.join(worktree, "repos", "app");
    const nestedIncrement = NodePath.join(nested, ".specweave", "increments", INCREMENT);
    NodeFS.mkdirSync(nestedIncrement, { recursive: true });
    NodeFS.writeFileSync(NodePath.join(nested, ".specweave", "config.json"), "{}\n");
    const result = await decideOwnership({
      worktreePath: worktree,
      requested: "1497",
      bound: bound(nestedIncrement),
    });
    expect(result).toMatchObject({
      ok: true,
      target: { specweaveRoot: nested, incrementDir: nestedIncrement },
    });
  });
});

describe("decideOwnership: one copy, assigned for real (1497 review)", () => {
  it("takes a branch binding only from an inc/NNNN branch, not from old ledger text", async () => {
    const { worktree, increment } = scratch();
    const guessed = await decideOwnership({
      worktreePath: worktree,
      branch: "feature/ledger",
      requested: "1497",
      bound: bound(increment, "branch"),
    });
    expect(guessed).toMatchObject({ ok: false, code: "capability_denied" });
    expect(!guessed.ok && guessed.message).toContain("ledger line that names its branch");
    expect(branchNamesIncrement("inc/1497-ledger-tools", INCREMENT)).toBe(true);
    expect(branchNamesIncrement("inc/1498-other", INCREMENT)).toBe(false);
    expect(branchNamesIncrement(null, INCREMENT)).toBe(false);
  });

  it("refuses a folder that holds another copy of the same increment", async () => {
    const { worktree, increment } = scratch();
    const nested = NodePath.join(worktree, "vendor", "other");
    NodeFS.mkdirSync(NodePath.join(nested, ".specweave", "increments", INCREMENT), {
      recursive: true,
    });
    NodeFS.writeFileSync(NodePath.join(nested, ".specweave", "config.json"), "{}\n");
    const result = await decideOwnership({
      worktreePath: worktree,
      folder: "vendor/other",
      requested: "1497",
      bound: bound(increment),
    });
    expect(result).toMatchObject({ ok: false, code: "capability_denied" });
    expect(!result.ok && result.message).toContain("holds another copy");
    // Naming the bound copy's own folder is fine.
    expect(
      await decideOwnership({
        worktreePath: worktree,
        folder: ".",
        requested: "1497",
        bound: bound(increment),
      }),
    ).toMatchObject({ ok: true, target: { incrementDir: increment } });
  });
});

describe("ledgerPathsInside: real folders and plain files (1497 review)", () => {
  const check = (worktree: string, incrementId = INCREMENT) =>
    ledgerPathsInside({ workspace: worktree, specweaveRoot: worktree, incrementId });

  it.skipIf(isWindows)("refuses a link inside the worktree to another increment", async () => {
    const { worktree, increment } = scratch();
    NodeFS.symlinkSync(
      increment,
      NodePath.join(worktree, ".specweave", "increments", "1502-alias"),
    );
    const result = await check(worktree, "1502-alias");
    expect(result.ok).toBe(false);
    expect(!result.ok && result.message).toContain("is a link");
  });

  it.skipIf(isWindows)(
    "refuses a linked state folder or a ledger with a second hard link",
    async () => {
      const { root, worktree, increment } = scratch();
      const outside = NodePath.join(root, "outside");
      NodeFS.mkdirSync(outside);
      NodeFS.symlinkSync(outside, NodePath.join(worktree, ".specweave", "state"));
      const linkedState = await check(worktree);
      expect(!linkedState.ok && linkedState.message).toContain("leads outside");
      NodeFS.rmSync(NodePath.join(worktree, ".specweave", "state"));

      NodeFS.linkSync(NodePath.join(increment, "ledger.jsonl"), NodePath.join(outside, "copy"));
      const hard = await check(worktree);
      expect(!hard.ok && hard.message).toContain("another hard link");
    },
  );

  it("refuses a leftover temporary file the CLI would write through", async () => {
    const { worktree, increment } = scratch();
    NodeFS.writeFileSync(NodePath.join(increment, "spec.md.tmp"), "x");
    const result = await check(worktree);
    expect(!result.ok && result.message).toContain("left over from an interrupted write");
  });

  it.skipIf(isWindows)("checks again just before the write", async () => {
    const { root, worktree, increment } = scratch();
    const decided = await decideOwnership({
      worktreePath: worktree,
      requested: "1497",
      bound: bound(increment),
    });
    expect(decided.ok).toBe(true);
    if (!decided.ok) return;
    expect(await recheckTarget(decided.target)).toMatchObject({ ok: true });
    // Swapped for a link after the first check.
    const outside = NodePath.join(root, "outside-ledger.jsonl");
    NodeFS.writeFileSync(outside, "");
    NodeFS.rmSync(NodePath.join(increment, "ledger.jsonl"));
    NodeFS.symlinkSync(outside, NodePath.join(increment, "ledger.jsonl"));
    expect(await recheckTarget(decided.target)).toMatchObject({ ok: false });
  });
});

describe("ledgerPathsInside (1497)", () => {
  it.skipIf(isWindows)(
    "refuses an increments folder, an increment or a ledger linked out of the worktree",
    () => {
      const { root, worktree, increment } = scratch();
      const outside = NodePath.join(root, "outside");
      NodeFS.mkdirSync(outside, { recursive: true });
      NodeFS.writeFileSync(NodePath.join(outside, "ledger.jsonl"), "");

      NodeFS.rmSync(NodePath.join(increment, "ledger.jsonl"));
      NodeFS.symlinkSync(
        NodePath.join(outside, "ledger.jsonl"),
        NodePath.join(increment, "ledger.jsonl"),
      );
      return ledgerPathsInside({
        workspace: worktree,
        specweaveRoot: worktree,
        incrementId: INCREMENT,
      })
        .then((ledger) => {
          expect(ledger.ok).toBe(false);
          expect(!ledger.ok && ledger.message).toContain("leads outside");
          const linkedIncrement = NodePath.join(
            worktree,
            ".specweave",
            "increments",
            "1501-linked",
          );
          NodeFS.symlinkSync(outside, linkedIncrement);
          return ledgerPathsInside({
            workspace: worktree,
            specweaveRoot: worktree,
            incrementId: "1501-linked",
          });
        })
        .then((linked) => {
          expect(linked.ok).toBe(false);
          expect(!linked.ok && linked.message).toContain("leads outside");
        });
    },
  );

  it.skipIf(isWindows)(
    "allows a ledger that does not exist yet, but not a dangling link",
    async () => {
      const { worktree, increment } = scratch();
      NodeFS.rmSync(NodePath.join(increment, "ledger.jsonl"));
      expect(
        await ledgerPathsInside({
          workspace: worktree,
          specweaveRoot: worktree,
          incrementId: INCREMENT,
        }),
      ).toEqual({ ok: true, incrementDir: increment });
      NodeFS.symlinkSync("/nonexistent/ledger.jsonl", NodePath.join(increment, "ledger.jsonl"));
      const dangling = await ledgerPathsInside({
        workspace: worktree,
        specweaveRoot: worktree,
        incrementId: INCREMENT,
      });
      expect(dangling.ok).toBe(false);
    },
  );
});
