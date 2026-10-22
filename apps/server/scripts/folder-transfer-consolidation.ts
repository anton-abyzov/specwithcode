// @effect-diagnostics nodeBuiltinImport:off - mutations are confined to the verifier's newly created remote fixture.
import * as NodeAssert from "node:assert/strict";
import * as NodeFSP from "node:fs/promises";
import * as NodePath from "node:path";

import type { DestinationCopies } from "../src/fleet/folderTransfer/destinationService.ts";
import { runGit } from "../src/fleet/folderTransfer/git.ts";
import type { Choice } from "../src/fleet/folderTransfer/reconcile.ts";

type Offer = { operationId: string; token: string };
type State = {
  entries: Array<{ path: string; [key: string]: unknown }>;
  repositories: Array<{ path: string; head: string; branch: string; [key: string]: unknown }>;
};

export async function exerciseRemoteConsolidation(input: {
  copies: DestinationCopies;
  offer: Offer;
  target: string;
  sourceUrl: string;
  capture: (folder: string) => Promise<State>;
  settle: (copies: DestinationCopies, id: string, states: string[]) => Promise<unknown>;
}) {
  const git = async (cwd: string, args: string[]) =>
    (
      await runGit(cwd, [
        "-c",
        "user.name=Transfer acceptance",
        "-c",
        "user.email=transfer@example.invalid",
        ...args,
      ])
    ).stdout.trim();
  const initial = await input.capture(input.target);
  const continued: Array<{ path: string; branch: string; before: string; after: string }> = [];
  // Finish the copied work on Linux without changing the original Mac files.
  for (const repo of initial.repositories) {
    const cwd = NodePath.join(input.target, repo.path);
    await git(cwd, ["add", "-A"]);
    await git(cwd, ["commit", "--allow-empty", "-qm", "Continue copied unfinished work on Linux"]);
    const head = await git(cwd, ["rev-parse", "HEAD"]);
    NodeAssert.notEqual(head, repo.head);
    continued.push({ path: repo.path, branch: repo.branch, before: repo.head, after: head });
  }
  // Keep completed work on its branch while creating a destination-only branch
  // from the prior base, so repeat-copy must preserve both histories.
  const selected =
    initial.repositories.find((repo) => repo.path === "repositories/anton-abyzov/specweave") ??
    initial.repositories[0]!;
  const cwd = NodePath.join(input.target, selected.path);
  await git(cwd, ["switch", "-q", "-c", "ministorm-diverged", `${selected.head}~1`]);
  await NodeFSP.writeFile(
    NodePath.join(cwd, "destination-only.txt"),
    "Work completed only on Ministorm\n",
  );
  await git(cwd, ["add", "destination-only.txt"]);
  await git(cwd, ["commit", "-qm", "Ministorm independent work"]);
  const destinationHead = await git(cwd, ["rev-parse", "HEAD"]);
  await NodeFSP.appendFile(
    NodePath.join(cwd, "README.md"),
    "\nUncommitted destination work remains.\n",
  );
  const hasNotes = await NodeFSP.stat(NodePath.join(input.target, "notes")).then(
    () => true,
    () => false,
  );
  if (hasNotes)
    for (const name of ["keep", "take", "both"])
      await NodeFSP.writeFile(
        NodePath.join(input.target, "notes", `${name}.md`),
        `Destination ${name}\n`,
      );
  const stable = (state: State) => ({
    files: state.entries.filter((entry) => !/(^|\/)\.git(?:\/|$)/.test(entry.path)),
    repositories: state.repositories,
  });
  const before = stable(await input.capture(input.target));
  await input.copies.start({
    operationId: input.offer.operationId,
    token: input.offer.token,
    sourceUrl: input.sourceUrl,
    sourceEnvironmentId: "remote-copy-source",
    sourceProjectId: "remote-copy-fixture",
    sourceMachine: "Mac acceptance source",
    title: "SpecWeave continuation acceptance",
    mode: "copy-only",
    targetFolder: input.target,
  });
  await input.settle(input.copies, input.offer.operationId, ["previewed"]);
  NodeAssert.deepEqual(
    stable(await input.capture(input.target)),
    before,
    "Repeated preview must not mutate existing work",
  );
  const plan = (await input.copies.readPlan(input.offer.operationId))!;
  NodeAssert.ok(
    plan.rows.some((row) => row.status === "diverged" || row.status === "ahead"),
    "Repeated copy must compare the existing Git histories",
  );
  NodeAssert.ok(plan.totals.decisionsNeeded > 0);
  await NodeAssert.rejects(input.copies.approve(input.offer.operationId), /decision/);
  const decisions: Record<string, Choice> = {};
  for (const row of plan.rows) {
    if (row.needsDecision)
      decisions[row.id] = row.choices.includes("keep-mine") ? "keep-mine" : row.choices[0]!;
    for (const conflict of row.conflicts) {
      const requested =
        conflict.path === "notes/take.md"
          ? "take-theirs"
          : conflict.path === "notes/both.md"
            ? "keep-both"
            : "keep-mine";
      decisions[conflict.id] = conflict.choices.includes(requested)
        ? requested
        : conflict.choices[0]!;
    }
  }
  await input.copies.decide(input.offer.operationId, { decisions });
  await input.settle(input.copies, input.offer.operationId, ["previewed"]);
  await input.copies.approve(input.offer.operationId);
  await input.settle(input.copies, input.offer.operationId, ["applied"]);
  NodeAssert.equal(
    await git(cwd, ["rev-parse", "HEAD"]),
    destinationHead,
    "Consolidation preserves destination HEAD",
  );
  NodeAssert.equal(
    await NodeFSP.readFile(NodePath.join(cwd, "destination-only.txt"), "utf8"),
    "Work completed only on Ministorm\n",
  );
  if (hasNotes) {
    NodeAssert.equal(
      await NodeFSP.readFile(NodePath.join(input.target, "notes/keep.md"), "utf8"),
      "Destination keep\n",
    );
    NodeAssert.equal(
      await NodeFSP.readFile(NodePath.join(input.target, "notes/take.md"), "utf8"),
      "Source take\n",
    );
    NodeAssert.equal(
      await NodeFSP.readFile(NodePath.join(input.target, "notes/both.md"), "utf8"),
      "Destination both\n",
    );
    const siblings = await NodeFSP.readdir(NodePath.join(input.target, "notes"));
    NodeAssert.ok(
      siblings.some((name) => name !== "both.md" && name.startsWith("both")),
      "Keep both preserves a second copy",
    );
  }
  const undo = await input.copies.undo(input.offer.operationId, false);
  NodeAssert.equal(undo.record.state, "undone");
  NodeAssert.deepEqual(undo.result?.problems, []);
  NodeAssert.deepEqual(
    stable(await input.capture(input.target)),
    before,
    "Undo restores contents, index, HEAD, branches and stashes before consolidation",
  );
  return {
    continuedOnLinux: continued,
    sameDestination: input.target,
    rows: plan.rows.map(({ path, status, conflicts }) => ({
      path,
      status,
      conflicts: conflicts.length,
    })),
    decisions,
    destinationHeadPreserved: true,
    previewDidNotWrite: true,
    unresolvedApprovalRefused: true,
    undoRestoredDestination: true,
  };
}
