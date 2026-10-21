// AC-06 and AC-07 against two real servers: a folder that already exists on
// Minis, driven through the real Add to another machine dialog and its review
// (same, behind, ahead, diverged, dirty, file conflicts with ignored files,
// a linked worktree), Undo from the dialog, and the unrelated-folder refusals.
import * as NodeCrypto from "node:crypto";
import * as NodeFS from "node:fs";
import * as NodePath from "node:path";

import {
  cancelCopy,
  dialog,
  git,
  headOf,
  makeOrigin,
  offerAndScan,
  openAddDialog,
  output,
  pollCopy,
  refsOf,
  rpcFails,
  scenario,
  shootThemes,
  startCopy,
  state,
  until,
  write,
} from "./harness.mjs";

const { randomUUID } = NodeCrypto;
const { existsSync, readFileSync, readdirSync, statSync, writeFileSync } = NodeFS;
const { join } = NodePath;

/** Ignored files on M4 and on Minis for the conflict case: one per choice, one missing, one equal. */
const NOTES = {
  "keep.md": { m4: "keep: M4\n", minis: "keep: Minis\n" },
  "take.md": { m4: "take: M4\n", minis: "take: Minis\n" },
  "both.md": { m4: "both: M4\n", minis: "both: Minis\n" },
  "missing.md": { m4: "missing: only on M4\n", minis: null },
  "same.md": { m4: "same on both\n", minis: "same on both\n" },
};

/**
 * One origin, an M4 checkout and a Minis folder per case. Runs before the
 * servers start: building them blocks this process.
 */
export function prepareConsolidationFixtures({ aHome, bHome, sourceCheckout }) {
  const fixtures = {};
  const prepare = {
    same: () => undefined,
    behind: (path) => git(path, "reset", "-q", "--hard", "HEAD~1"),
    ahead: (path) => {
      write(join(path, "minis.txt"), "Only on Minis.\n");
      git(path, "add", "minis.txt");
      git(path, "commit", "-qm", "Minis only");
    },
    diverged: (path) => {
      git(path, "reset", "-q", "--hard", "HEAD~1");
      write(join(path, "minis.txt"), "Diverged on Minis.\n");
      git(path, "add", "minis.txt");
      git(path, "commit", "-qm", "Minis diverged");
    },
    dirty: (path) => {
      git(path, "reset", "-q", "--hard", "HEAD~1");
      write(join(path, "README.md"), "edited on Minis, not committed\n");
    },
    conflict: (path, aRoot) => {
      for (const [name, sides] of Object.entries(NOTES)) {
        write(join(aRoot, "notes", name), sides.m4);
        if (sides.minis !== null) write(join(path, "notes", name), sides.minis);
      }
      write(join(aRoot, ".env"), "API_KEY=fixture-not-a-secret\n");
    },
  };
  const unrelatedOrigin = makeOrigin("unrelated");
  for (const name of [...Object.keys(prepare), "worktree", "other-repo", "plain"]) {
    const origin = makeOrigin(name);
    const aRoot = sourceCheckout(origin);
    // Where the dialog's default folder points on Minis (D-03).
    const bRoot = join(bHome, name);
    if (name === "plain") write(join(bRoot, "notes.txt"), "Someone else's files.\n");
    else if (name === "worktree") {
      // The folder on Minis is a linked worktree of a checkout elsewhere.
      const main = join(bHome, "checkouts", "worktree-main");
      git(aHome, "clone", "-q", origin.url, main);
      git(main, "worktree", "add", "-q", "-b", "minis-work", bRoot);
      fixtures[name] = { origin, aRoot, bRoot, main };
      continue;
    } else {
      git(aHome, "clone", "-q", name === "other-repo" ? unrelatedOrigin.url : origin.url, bRoot);
      prepare[name]?.(bRoot, aRoot);
    }
    fixtures[name] = { origin, aRoot, bRoot };
  }
  return fixtures;
}

/** Opens the dialog on the case's project and runs the review up to the preview. */
async function review(page, name, { copyIgnored = false } = {}) {
  await openAddDialog(page, name);
  const box = dialog(page);
  await box
    .getByText("That folder is already a checkout of this repository.", { exact: false })
    .waitFor({ timeout: 30_000 });
  if (copyIgnored) await box.getByRole("checkbox", { name: /Copy ignored files/ }).check();
  const start = box.getByRole("button", { name: "Link and consolidate" });
  await until(() => start.isEnabled(), "Link and consolidate to enable", 60_000);
  await start.click();
  await box
    .locator('[data-slot="add-consolidate-review"][data-state="previewed"]')
    .waitFor({ timeout: 60_000 });
  const rows = await box
    .locator('[data-slot="copy-row"]')
    .evaluateAll((nodes) => nodes.map((node) => node.getAttribute("data-status")));
  return { box, rows, text: (await box.innerText()).split("\n").filter(Boolean) };
}

const choose = (box, group, text) =>
  box.getByRole("radiogroup", { name: `Choice for ${group}` }).getByText(text, { exact: true });

async function applyAndLink(box) {
  const apply = box.getByRole("button", { name: "Apply and link" });
  await until(() => apply.isEnabled(), "Apply and link to enable", 30_000);
  await apply.click();
  await box.getByText(/^Linked: /).waitFor({ timeout: 120_000 });
  return (await box.innerText()).split("\n").find((line) => line.startsWith("Linked: "));
}

async function undoInDialog(box) {
  await box.getByRole("button", { name: "Undo…" }).click();
  const confirm = box.getByRole("button", {
    name: /^Undo (the copy|and keep edited files aside)$/,
  });
  await confirm.waitFor({ timeout: 30_000 });
  await confirm.click();
  // The dialog says so once the folder is restored and the link taken back.
  await box
    .getByText(/is back to how it was before the copy, and not linked to M4\./)
    .waitFor({ timeout: 60_000 });
  return (await box.innerText()).split("\n").filter(Boolean);
}

/** Members of the case's logical project as both servers see them. */
async function membersOf(fixture) {
  const { A, B } = state;
  const view = await A.rpc.call("projectLink.preview", { projectId: fixture.projectId });
  const members = view.logicalProject?.members ?? [];
  return {
    count: members.length,
    onMinis: members.filter((member) => member.environmentId === B.environmentId).length,
  };
}

const read = (path) => (existsSync(path) ? readFileSync(path, "utf8") : null);
const importRef = (refs) => refs.find((ref) => ref.startsWith("refs/heads/swc/from-M4/main "));

/** c1-c3: same, behind and ahead need no decision; Apply and link straight away. */
async function simpleCase(page, name, expectStatus) {
  const fixture = state.caseFixtures[name];
  const headBefore = headOf(fixture.bRoot);
  const seen = await review(page, name);
  const linked = await applyAndLink(seen.box);
  const members = await membersOf(fixture);
  await page.keyboard.press("Escape");
  return {
    rows: seen.rows,
    review: seen.text,
    linked,
    headBefore,
    headAfter: headOf(fixture.bRoot),
    sourceHead: headOf(fixture.aRoot),
    members,
    ok: seen.rows[0] === expectStatus && members.count === 2 && members.onMinis === 1,
  };
}

export async function scenarioConsolidation(page) {
  const { A, B, caseFixtures } = state;

  const same = await simpleCase(page, "same", "same");
  scenario(
    "c1. existing folder, same commit: dialog review shows Same, Apply and link links it",
    same.ok && same.headAfter === same.headBefore,
    same,
  );
  const behind = await simpleCase(page, "behind", "fast-forward");
  scenario(
    "c2. existing folder behind: dialog review fast-forwards it, linked",
    behind.ok && behind.headAfter === behind.sourceHead,
    behind,
  );
  const ahead = await simpleCase(page, "ahead", "ahead");
  scenario(
    "c3. existing folder ahead: dialog review keeps Minis's commits, linked",
    ahead.ok && ahead.headAfter === ahead.headBefore,
    ahead,
  );

  // c4: diverged. Never overwritten; theirs arrives as swc/from-M4/main. Undo from the
  // dialog restores the folder and takes the link back.
  {
    const fixture = caseFixtures.diverged;
    const headBefore = headOf(fixture.bRoot);
    const seen = await review(page, "diverged");
    await shootThemes(page, "07-consolidation-review", () => seen.box);
    writeFileSync(join(output, "07-consolidation-review.txt"), seen.text.join("\n"));
    const applyBlocked = await seen.box
      .getByRole("button", { name: "Apply and link" })
      .isDisabled();
    await choose(seen.box, "diverged", "Keep Minis’s version").click();
    const linked = await applyAndLink(seen.box);
    await shootThemes(page, "07b-consolidation-linked", () => seen.box);
    const refsAfterApply = refsOf(fixture.bRoot);
    const membersAfterApply = await membersOf(fixture);
    const undoText = await undoInDialog(seen.box);
    await shootThemes(page, "07c-consolidation-undone", () => seen.box);
    const refsAfterUndo = refsOf(fixture.bRoot);
    const membersAfterUndo = await membersOf(fixture);
    await page.keyboard.press("Escape");
    const evidence = {
      rows: seen.rows,
      review: seen.text,
      applyBlockedUntilChoice: applyBlocked,
      linked,
      headBefore,
      headAfter: headOf(fixture.bRoot),
      importRef: importRef(refsAfterApply) ?? null,
      sourceHead: headOf(fixture.aRoot),
      membersAfterApply,
      undo: {
        dialog: undoText.filter((line) => !line.startsWith("/") || line.includes("back to")),
        refs: refsAfterUndo,
        membersAfterUndo,
      },
    };
    scenario(
      "c4. existing folder diverged: never overwritten, theirs as swc/from-M4/main; dialog Undo removes it and the link",
      seen.rows[0] === "diverged" &&
        applyBlocked &&
        !seen.text.some((line) => /^Take /u.test(line)) &&
        evidence.headAfter === headBefore &&
        evidence.importRef?.endsWith(evidence.sourceHead) === true &&
        membersAfterApply.count === 2 &&
        !refsAfterUndo.some((ref) => ref.includes("swc/from-")) &&
        headOf(fixture.bRoot) === headBefore &&
        membersAfterUndo.onMinis === 0,
      evidence,
    );
  }

  // c5: dirty. The server refuses Apply without a decision (checked over RPC, as a
  // client that skipped the review would call it); the dialog keeps Apply disabled.
  {
    const fixture = caseFixtures.dirty;
    const operationId = randomUUID();
    const { offer } = await offerAndScan(A, fixture.projectId, B, operationId);
    await startCopy(B, offer, fixture.bRoot, ["repository", "tracked", "untracked"]);
    const refused = await rpcFails(B.rpc.call("machineHandoff.copyApprove", { operationId }));
    const afterRefusal = await pollCopy(B, operationId);
    await cancelCopy(A, B, operationId, "Verifier: refusal checked.");
    const seen = await review(page, "dirty");
    const applyBlocked = await seen.box
      .getByRole("button", { name: "Apply and link" })
      .isDisabled();
    const choices = await seen.box
      .getByRole("radiogroup", { name: "Choice for dirty" })
      .innerText()
      .catch(() => "");
    await choose(seen.box, "dirty", "Keep Minis’s version").click();
    const linked = await applyAndLink(seen.box);
    const members = await membersOf(fixture);
    await page.keyboard.press("Escape");
    const kept = read(join(fixture.bRoot, "README.md"));
    scenario(
      "c5. existing folder dirty: refused without consent; Keep Minis's version keeps the edit, linked",
      refused !== null &&
        afterRefusal.state === "previewed" &&
        seen.rows[0] === "dirty" &&
        applyBlocked &&
        kept?.includes("edited on Minis") === true &&
        members.onMinis === 1,
      {
        rpcApproveWithoutDecision: refused?.failure.slice(0, 300) ?? "accepted",
        stateAfterRefusal: afterRefusal.state,
        rows: seen.rows,
        choices: choices.split("\n").filter(Boolean),
        applyBlockedUntilChoice: applyBlocked,
        linked,
        readme: kept,
        members,
      },
    );
  }

  // c6: file conflicts and ignored files. Each conflicting file gets a different
  // choice; a missing ignored file is copied, an equal one is left as it is, and
  // .env never travels. Undo then puts every file back.
  {
    const fixture = caseFixtures.conflict;
    const notes = (name) => read(join(fixture.bRoot, "notes", name));
    const sameStat = statSync(join(fixture.bRoot, "notes/same.md")).mtimeMs;
    const seen = await review(page, "conflict", { copyIgnored: true });
    const details = seen.box.locator("details").first();
    if (!(await details.evaluate((node) => node.open))) await details.locator("summary").click();
    await shootThemes(page, "07d-conflict-review", () => seen.box);
    writeFileSync(join(output, "07d-conflict-review.txt"), seen.text.join("\n"));
    await choose(seen.box, "notes/keep.md", "Keep Minis’s version").click();
    await choose(seen.box, "notes/take.md", "Take M4’s version (back up Minis’s)").click();
    await choose(seen.box, "notes/both.md", "Keep both (M4’s copy beside it)").click();
    const linked = await applyAndLink(seen.box);
    const after = {
      keep: notes("keep.md"),
      take: notes("take.md"),
      both: notes("both.md"),
      bothFromM4: notes("both.md.from-M4"),
      missing: notes("missing.md"),
      same: notes("same.md"),
      sameUntouched: statSync(join(fixture.bRoot, "notes/same.md")).mtimeMs === sameStat,
      env: existsSync(join(fixture.bRoot, ".env")),
    };
    const members = await membersOf(fixture);
    const undoText = await undoInDialog(seen.box);
    await page.keyboard.press("Escape");
    const undone = {
      take: notes("take.md"),
      bothFromM4: notes("both.md.from-M4"),
      missing: notes("missing.md"),
      notes: readdirSync(join(fixture.bRoot, "notes")).sort(),
    };
    const membersAfterUndo = await membersOf(fixture);
    scenario(
      "c6. file conflicts: keep mine, take theirs (backed up), keep both as <name>.from-M4; only missing ignored files copy; Undo restores",
      seen.rows.includes("conflict") &&
        after.keep === NOTES["keep.md"].minis &&
        after.take === NOTES["take.md"].m4 &&
        after.both === NOTES["both.md"].minis &&
        after.bothFromM4 === NOTES["both.md"].m4 &&
        after.missing === NOTES["missing.md"].m4 &&
        after.same === NOTES["same.md"].minis &&
        after.sameUntouched &&
        !after.env &&
        members.onMinis === 1 &&
        undone.take === NOTES["take.md"].minis &&
        undone.bothFromM4 === null &&
        undone.missing === null &&
        membersAfterUndo.onMinis === 0,
      {
        rows: seen.rows,
        review: seen.text,
        linked,
        after,
        members,
        undo: {
          dialog: undoText.filter((line) => !line.startsWith("/") || line.includes("back to")),
          ...undone,
          membersAfterUndo,
        },
      },
    );
  }

  // c7: the folder on Minis is a linked worktree of the same repository.
  {
    const fixture = caseFixtures.worktree;
    const mainHead = headOf(fixture.main);
    const result = await simpleCase(page, "worktree", "same");
    const gitEntry = statSync(join(fixture.bRoot, ".git"));
    scenario(
      "c7. existing linked worktree of the repository: consolidated and linked, main checkout untouched",
      result.ok &&
        gitEntry.isFile() &&
        headOf(fixture.main) === mainHead &&
        git(fixture.bRoot, "rev-parse", "--abbrev-ref", "HEAD") === "minis-work",
      {
        ...result,
        worktreeGitIsFile: gitEntry.isFile(),
        branch: git(fixture.bRoot, "rev-parse", "--abbrev-ref", "HEAD"),
        mainHeadUnchanged: headOf(fixture.main) === mainHead,
      },
    );
  }

  // c8: unrelated folders, a different repository and a plain non-empty folder.
  const unrelated = {};
  for (const name of ["other-repo", "plain"]) {
    const fixture = caseFixtures[name];
    unrelated[name] = {
      inspected: await B.rpc.call("sourceControl.inspectDestination", {
        path: fixture.bRoot,
        remoteUrl: fixture.origin.url,
      }),
      clone:
        (
          await rpcFails(
            B.rpc.call("projectClone.start", {
              projectId: randomUUID(),
              title: name,
              createdAt: new Date().toISOString(),
              remoteUrl: fixture.origin.url,
              destinationPath: fixture.bRoot,
            }),
          )
        )?.failure?.slice(0, 300) ?? "started",
      untouched: readdirSync(fixture.bRoot).sort(),
    };
  }
  await openAddDialog(page, "plain");
  const box = dialog(page);
  await box
    .getByText("That folder already has files that are not this repository.")
    .waitFor({ timeout: 30_000 });
  await shootThemes(page, "06-add-dialog-refused", () => box);
  unrelated.dialog = (await box.innerText()).split("\n").filter(Boolean);
  unrelated.cloneButtonDisabled = await box
    .getByRole("button", { name: "Clone to Minis" })
    .isDisabled();
  await box.getByRole("button", { name: "Cancel" }).click();
  scenario(
    "c8. unrelated folder (other repository or plain files): refused, suggests another path",
    unrelated["other-repo"].inspected.state === "repository" &&
      unrelated["other-repo"].inspected.sameRepository === false &&
      unrelated.plain.inspected.state === "not-repository" &&
      unrelated["other-repo"].clone !== "started" &&
      unrelated.plain.clone !== "started" &&
      unrelated.cloneButtonDisabled &&
      unrelated.dialog.some((line) => line.includes("plain-2")),
    unrelated,
  );
}
