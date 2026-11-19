// @effect-diagnostics-next-line nodeBuiltinImport:off -- a test that reads source files.
import * as NodeFS from "node:fs";
// @effect-diagnostics-next-line nodeBuiltinImport:off -- a test that reads source files.
import * as NodePath from "node:path";

import type {
  ProjectSyncExtraResult,
  ProjectSyncFetchResult,
  ProjectSyncInventoryResult,
  ProjectSyncReason,
  ProjectSyncRepositoryFacts,
  ProjectSyncStep,
} from "@specweave-studio/contracts";
import { describe, expect, it } from "vite-plus/test";

import { de } from "../../i18n/phrases/de";
import { es } from "../../i18n/phrases/es";
import { fr } from "../../i18n/phrases/fr";
import { ja } from "../../i18n/phrases/ja";
import { ko } from "../../i18n/phrases/ko";
import { pt } from "../../i18n/phrases/pt";
import { ru } from "../../i18n/phrases/ru";
import { zh } from "../../i18n/phrases/zh";
import {
  arrivalPrefix,
  extraItems,
  extraResultLine,
  isUnknownSyncCall,
  KNOWN_REFUSAL_DETAILS,
  readStepLine,
  readSyncText,
  runHasWork,
  stepLine,
  syncExtras,
  syncFailure,
  syncLeftovers,
  syncPlan,
  syncResultRows,
  syncRunInput,
} from "./projectSyncDialog.logic";

const REASONS: ReadonlyArray<ProjectSyncReason> = [
  "behind",
  "up-to-date",
  "not-pushed",
  "diverged",
  "uncommitted",
  "in-use",
  "other-branch",
  "detached",
  "no-upstream",
  "fetch-failed",
  "no-remote",
  "fetch-config",
  "missing",
  "missing-no-remote",
  "refused",
];

const step = (
  reason: ProjectSyncReason,
  extra: Partial<ProjectSyncStep> = {},
): ProjectSyncStep => ({
  path: "apps/site",
  action: "none",
  reason,
  branch: "main",
  otherBranch: "main",
  ahead: 0,
  behind: 0,
  uncommitted: 0,
  inUseBy: null,
  remote: "git@example.com:acme/site.git",
  detail: null,
  ...extra,
});

const facts = (
  path: string,
  extra: Partial<ProjectSyncRepositoryFacts> = {},
): ProjectSyncRepositoryFacts => ({
  path,
  branch: "main",
  head: "a".repeat(40),
  upstream: "origin/main",
  ahead: 0,
  behind: 0,
  uncommitted: 0,
  inUseBy: null,
  remote: `git@example.com:acme/${path === "." ? "atlas" : path}.git`,
  fetch: "ok",
  fetchError: null,
  ...extra,
});

const fetched = (...repositories: ProjectSyncRepositoryFacts[]): ProjectSyncFetchResult => ({
  repositories,
  scanLimited: false,
});

describe("stepLine: the sentence per state (AC-11)", () => {
  it("never shows a bare sentence for a checkout with uncommitted files or a running thread", () => {
    for (const reason of REASONS)
      for (const phase of ["plan", "result"] as const) {
        const line = stepLine(
          step(reason, { uncommitted: 3, inUseBy: "Release tooling", ahead: 2, behind: 4 }),
          phase,
          phase === "result" ? { moved: 4, downgraded: false } : null,
        );
        const read = readStepLine(line);
        expect(read, `${reason} ${phase}`).toContain("3 uncommitted files");
        expect(read, `${reason} ${phase}`).toContain("In use by Release tooling");
      }
  });

  it("says Up to date with the facts beside it when the checkout is level with its upstream", () => {
    expect(readStepLine(stepLine(step("up-to-date"), "plan"))).toBe("Up to date");
    expect(readStepLine(stepLine(step("up-to-date", { uncommitted: 1 }), "plan"))).toBe(
      "Up to date · 1 uncommitted file",
    );
    expect(readStepLine(stepLine(step("up-to-date", { inUseBy: "Docs lint" }), "result"))).toBe(
      "Up to date · In use by Docs lint",
    );
    expect(
      readStepLine(stepLine(step("not-pushed", { ahead: 10, uncommitted: 179 }), "plan")),
    ).toBe("10 commits not pushed (listed as an extra) · 179 uncommitted files");
  });

  it("words every row of the table", () => {
    const read = (
      reason: ProjectSyncReason,
      extra: Partial<ProjectSyncStep> = {},
      phase: "plan" | "result" = "result",
      ran: { moved: number; downgraded: boolean } | null = null,
    ) => readStepLine(stepLine(step(reason, extra), phase, ran));
    expect(read("behind", { behind: 99 }, "plan")).toBe("Moves forward 99 commits");
    expect(read("behind", { behind: 1 }, "plan")).toBe("Moves forward 1 commit");
    expect(read("behind", { behind: 99 }, "result", { moved: 99, downgraded: false })).toBe(
      "Moved forward 99 commits",
    );
    expect(read("behind", {}, "result", { moved: 1, downgraded: false })).toBe(
      "Moved forward 1 commit",
    );
    expect(read("not-pushed", { ahead: 1 })).toBe("1 commit not pushed (listed as an extra)");
    expect(read("diverged", { ahead: 3, behind: 7 })).toBe(
      "Has 3 commits of its own and is 7 behind. Not moved",
    );
    expect(read("diverged", { ahead: 1, behind: 7 })).toBe(
      "Has 1 commit of its own and is 7 behind. Not moved",
    );
    expect(read("uncommitted", { uncommitted: 2 })).toBe("Not moved forward: 2 uncommitted files");
    expect(read("uncommitted", { uncommitted: 1 })).toBe("Not moved forward: 1 uncommitted file");
    expect(read("in-use", { inUseBy: "Release tooling" })).toBe("In use by Release tooling");
    expect(read("other-branch", { branch: "fix/menu" })).toBe(
      "On fix/menu. The other machine's branch comes with the fetch when the remote has it; nothing is checked out",
    );
    expect(read("detached", { branch: null })).toBe("Not on a branch. Not moved");
    expect(read("no-upstream")).toBe("No upstream. Its commits are listed as an extra");
    expect(read("fetch-failed", { detail: "Could not resolve host: example.com." })).toBe(
      "Could not fetch: Could not resolve host: example.com. The other repositories continue",
    );
    expect(read("fetch-failed")).toBe("Could not fetch. The other repositories continue");
    expect(read("missing", {}, "plan")).toBe("Clones it from git@example.com:acme/site.git");
    expect(read("missing")).toBe("Cloned from git@example.com:acme/site.git");
    expect(read("missing-no-remote")).toBe('Not in Git on a remote. Use "Compare all files…"');
    expect(read("no-remote")).toBe('Not in Git on a remote. Use "Compare all files…"');
    expect(read("fetch-config")).toBe(
      "Not fetched: this repository mirrors its remote, and a fetch would move its branches",
    );
    expect(read("refused", { detail: "A thread's worktree is never moved by Sync." })).toBe(
      "Sync did not change it: A thread's worktree is never moved by Sync",
    );
  });

  it("keeps the setting's or Git's own words for a mirror and for no upstream", () => {
    const mirror = stepLine(
      step("fetch-config", { detail: "origin is set up as a mirror (remote.origin.mirror)." }),
      "plan",
    );
    expect(mirror.detail).toBe("origin is set up as a mirror (remote.origin.mirror).");
    expect(
      stepLine(step("no-upstream", { detail: "Its upstream is a local branch." }), "plan").detail,
    ).toBe("Its upstream is a local branch.");
  });

  it("says a step was changed since the plan, and shows a reason it does not know as sent", () => {
    const late = stepLine(step("uncommitted", { action: "fetch", uncommitted: 2 }), "result", {
      moved: 0,
      downgraded: true,
    });
    expect(readStepLine(late)).toBe(
      "Not moved forward: 2 uncommitted files · Changed since the plan",
    );
    const unknown = stepLine(
      step("held-by-policy" as ProjectSyncReason, { detail: "A rule holds this repository." }),
      "result",
    );
    expect(readSyncText(unknown.sentence)).toBe("Not moved");
    expect(unknown.detail).toBe("A rule holds this repository.");
  });
});

describe("syncPlan", () => {
  const plan = syncPlan(
    {
      a: fetched(
        facts("."),
        facts("apps/site", { behind: 99 }),
        facts("apps/status", { branch: "next" }),
        facts("apps/notes", { remote: null, fetch: "no-remote" }),
      ),
      b: fetched(facts(".", { uncommitted: 2 }), facts("apps/site")),
    },
    { project: "Atlas", a: "M4", b: "M5" },
  );

  it("lists the project's own repository first, then each nested one, with a cell per machine", () => {
    expect(plan.rows.map((row) => row.name)).toEqual([
      "Atlas",
      "apps/notes",
      "apps/site",
      "apps/status",
    ]);
    const site = plan.rows.find((row) => row.path === "apps/site")!;
    expect(readStepLine(site.a.line)).toBe("Moves forward 99 commits");
    expect(readStepLine(site.b.line)).toBe("Up to date");
    // Level with its upstream, with uncommitted files: never a bare "Up to date".
    expect(readStepLine(plan.rows[0]!.b.line)).toBe("Up to date · 2 uncommitted files");
  });

  it("clones a repository only the other machine has, and says so where none can be cloned", () => {
    const status = plan.rows.find((row) => row.path === "apps/status")!;
    expect(status.b.present).toBe(false);
    expect(readStepLine(status.b.line)).toBe("Clones it from git@example.com:acme/apps/status.git");
    const notes = plan.rows.find((row) => row.path === "apps/notes")!;
    expect(notes.b.present).toBe(false);
    expect(readStepLine(notes.b.line)).toBe('Not in Git on a remote. Use "Compare all files…"');
    expect(plan.moves).toBe(true);
  });

  it("asks each machine only for its fast-forwards and clones", () => {
    const a = syncRunInput("p" as never, plan.steps.a);
    const b = syncRunInput("p" as never, plan.steps.b);
    expect(a).toEqual({
      projectId: "p",
      fastForward: [{ path: "apps/site", otherBranch: "main" }],
      clone: [],
    });
    expect(b).toEqual({
      projectId: "p",
      fastForward: [],
      clone: [{ path: "apps/status", remote: "git@example.com:acme/apps/status.git" }],
    });
    expect(runHasWork(a)).toBe(true);
    expect(runHasWork(syncRunInput("p" as never, []))).toBe(false);
  });

  it("names a machine whose folder could not be scanned in full, and moves nothing when level", () => {
    const level = syncPlan(
      { a: { ...fetched(facts(".")), scanLimited: true }, b: fetched(facts(".")) },
      { project: "Atlas", a: "M4", b: "M5" },
    );
    expect(level.scanLimited).toEqual(["a"]);
    expect(level.moves).toBe(false);
  });

  it("reads a result from the machine's answer, the plan where nothing was asked, and a gap as a gap", () => {
    const rows = syncResultRows(plan, {
      a: {
        results: [
          {
            ...step("uncommitted", { path: "apps/site", action: "fetch", uncommitted: 1 }),
            moved: 0,
            downgraded: true,
          },
        ],
      },
      b: { results: [] },
    });
    const site = rows.find((row) => row.path === "apps/site")!;
    expect(readStepLine(site.a.line)).toBe(
      "Not moved forward: 1 uncommitted file · Changed since the plan",
    );
    expect(site.a.done).toBe(false);
    expect(site.b).toMatchObject({ done: true });
    const status = rows.find((row) => row.path === "apps/status")!;
    expect(readStepLine(status.b.line)).toBe(
      "Not done: the machine gave no answer for this repository",
    );
    // Level with its upstream and with uncommitted files: the facts stay beside it.
    expect(readStepLine(rows[0]!.b.line)).toBe("Up to date · 2 uncommitted files");
  });

  it("says which upstream it is when the branch follows no branch of origin or its branch is gone", () => {
    const row = (mine: Partial<ProjectSyncRepositoryFacts>) =>
      syncPlan(
        { a: fetched(facts(".", mine)), b: fetched(facts(".")) },
        { project: "Atlas", a: "m4", b: "m5" },
      ).rows[0]!.a;
    const other = row({ upstream: null, otherUpstream: "second/main" });
    expect(other.step).toMatchObject({ action: "none", reason: "no-upstream" });
    expect(readStepLine(other.line)).toBe(
      "Follows second/main, which is not a branch of origin. Not moved",
    );
    // The name is a value of the sentence, so the server's English is not shown beside it.
    expect(other.line.sentence.values).toEqual({ name: "second/main" });
    expect(other.line.detail).toBeNull();
    const gone = row({ behind: 3, upstreamGone: true });
    expect(gone.step).toMatchObject({ action: "none", reason: "no-upstream" });
    expect(readStepLine(gone.line)).toBe("origin/main is no longer on origin. Not moved");
    expect(gone.line.detail).toBeNull();
    // Facts stay beside either sentence.
    expect(readStepLine(row({ upstream: null, otherUpstream: "base", uncommitted: 2 }).line)).toBe(
      "Follows base, which is not a branch of origin. Not moved · 2 uncommitted files",
    );
    // An older machine sends neither field: today's row.
    const older = row({ upstream: null });
    expect(readStepLine(older.line)).toBe("No upstream. Its commits are listed as an extra");
    expect(readStepLine(row({ upstream: null, otherUpstream: null }).line)).toBe(
      "No upstream. Its commits are listed as an extra",
    );
    // A reason this version does not know is shown as the machine sent it.
    expect(
      stepLine(step("no-upstream", { detail: "Its upstream is a tag." }), "plan", null, {
        upstream: null,
      }),
    ).toMatchObject({
      sentence: { text: "No upstream. Its commits are listed as an extra" },
      detail: "Its upstream is a tag.",
    });
  });

  it("reads a branch found gone, and an origin that could not be asked, from the run's answer", () => {
    const behind = syncPlan(
      { a: fetched(facts(".", { behind: 2 })), b: fetched(facts(".")) },
      { project: "Atlas", a: "m4", b: "m5" },
    );
    expect(behind.rows[0]!.a.step.action).toBe("fast-forward");
    const answer = (reason: ProjectSyncReason, detail: string) => ({
      a: {
        results: [
          { ...step(reason, { path: ".", behind: 2, detail }), moved: 0, downgraded: true },
        ],
      },
      b: null,
    });
    const gone = syncResultRows(
      behind,
      answer("no-upstream", "The branch origin/main is no longer on origin."),
    )[0]!.a;
    expect(readStepLine(gone.line)).toBe(
      "origin/main is no longer on origin. Not moved · Changed since the plan",
    );
    expect(gone.line.detail).toBeNull();
    expect(gone.done).toBe(false);
    const unasked = syncResultRows(
      behind,
      answer("refused", "origin could not be asked whether the branch is still there."),
    )[0]!.a;
    expect(unasked.line.sentence).toEqual({
      text: "Sync did not change it: origin could not be asked whether the branch is still there",
    });
    expect(unasked.line.tone).toBe("failed");
    // A sentence this version does not know keeps the machine's words.
    const unknown = syncResultRows(behind, answer("no-upstream", "The branch moved to a tag."))[0]!
      .a;
    expect(unknown.line.detail).toBe("The branch moved to a tag.");
    expect(
      readStepLine(syncResultRows(behind, answer("refused", "Something new."))[0]!.a.line),
    ).toBe("Sync did not change it: Something new · Changed since the plan");
  });

  it("keeps an answer for a folder outside the plan, such as a stopped clone's leftover", () => {
    const leftover = (detail: string | null) =>
      syncLeftovers(plan, {
        a: null,
        b: {
          results: [
            {
              ...step("refused", { path: ".apps-site.swc-clone-1", branch: null, detail }),
              moved: 0,
              downgraded: false,
            },
            { ...step("up-to-date", { path: "." }), moved: 0, downgraded: false },
          ],
        },
      });
    const known = leftover(
      "A clone that was stopped left this folder behind, and it could not be removed.",
    );
    expect(known).toHaveLength(1);
    expect(known[0]).toMatchObject({ side: "b", path: ".apps-site.swc-clone-1" });
    expect(readSyncText(known[0]!.sentence)).toBe(
      "A clone that was stopped left .apps-site.swc-clone-1 behind, and it could not be removed",
    );
    expect(readSyncText(leftover("Something new.")[0]!.sentence)).toBe(
      ".apps-site.swc-clone-1: Something new",
    );
    expect(readSyncText(leftover(null)[0]!.sentence)).toBe(
      ".apps-site.swc-clone-1: Sync did not change it",
    );
    expect(syncLeftovers(plan, { a: null, b: null })).toEqual([]);
  });

  it("shows a cloned repository as there, on the branch the clone checked out", () => {
    const rows = syncResultRows(plan, {
      a: null,
      b: {
        results: [
          {
            ...step("missing", { path: "apps/status", action: "clone", branch: "next" }),
            moved: 0,
            downgraded: false,
          },
        ],
      },
    });
    const status = rows.find((row) => row.path === "apps/status")!;
    expect(status.b).toMatchObject({ present: true, branch: "next", done: true });
  });
});

const inventory: ProjectSyncInventoryResult = {
  scanLimited: false,
  repositories: [
    {
      path: ".",
      notPushed: [{ branch: "fix/menu", head: "b".repeat(40), commits: 10 }],
      onlyHere: [
        { branch: "try/one", head: "c".repeat(40), commits: 1 },
        { branch: "try/two", head: "d".repeat(40), commits: 4 },
      ],
      branchesNotListed: 3,
      changedFiles: 170,
      untrackedFiles: 9,
      stashes: 2,
      leftOut: [
        { path: ".env.local", reason: "name", kind: null, modifiedAtMs: 1 },
        { path: "notes/keys.txt", reason: "content", kind: "GitHub token", modifiedAtMs: 2 },
        { path: "data/big.bin", reason: "not-checked", kind: null, modifiedAtMs: null },
      ],
      leftOutNotListed: 4,
    },
  ],
};
const names = { project: "Atlas", source: "M4", target: "M5" };

describe("extras", () => {
  const extras = syncExtras(inventory, names);

  it("lists one line per unpushed branch, one for branches only there, and the uncommitted files", () => {
    expect(
      extras.lines.map((line) => [line.kind, readSyncText(line.label), line.tickable]),
    ).toEqual([
      ["not-pushed", "10 commits on fix/menu that were never pushed", true],
      ["only-here", "2 branches that exist only on M4", true],
      ["uncommitted", "179 uncommitted files in Atlas", true],
      ["stashes", "2 stashes in Atlas", false],
      ["not-listed", "3 more branches in Atlas are not listed", false],
    ]);
    expect(readSyncText(extras.lines[0]!.helper!)).toBe(
      "Sent straight to M5 over the link between the machines, as branch swc/from-M4/fix/menu. Nothing goes to GitHub.",
    );
    expect(readSyncText(extras.lines[2]!.helper!)).toBe(
      "Arrives on M5 as a branch under swc/from-M4/, not as files in its folder. Nothing is committed on M4.",
    );
    expect(readSyncText(extras.lines[3]!.helper!)).toBe(
      "Stashes stay. Compare all files… can bring them",
    );
    expect(extras.leftOutNotListed).toBe(4);
  });

  it("offers Send anyway for a finding and for a file not checked, never for a secret by name", () => {
    expect(
      extras.leftOut.map((file) => [file.file, readSyncText(file.label), file.sendAnyway]),
    ).toEqual([
      [".env.local", "A secret by its name. It stays on M4: Sync does not send secrets.", false],
      ["notes/keys.txt", "Looks like a GitHub token", true],
      ["data/big.bin", "Not checked", true],
    ]);
  });

  it("sends nothing unless its line is ticked", () => {
    const every = new Set(extras.leftOut.map((file) => file.id));
    expect(extraItems(inventory, extras, new Set(), every)).toEqual([]);
    // Stashes and unlisted branches cannot travel, ticked or not.
    expect(extraItems(inventory, extras, new Set(["stashes:.", "not-listed:."]), every)).toEqual(
      [],
    );
  });

  it("sends a ticked line as its branches, and files to send anyway only with the uncommitted files", () => {
    const every = new Set(extras.leftOut.map((file) => file.id));
    expect(
      extraItems(inventory, extras, new Set(["not-pushed:.:fix/menu", "only-here:."]), every),
    ).toEqual([
      [
        { kind: "branch", path: ".", branch: "fix/menu" },
        { kind: "branch", path: ".", branch: "try/one" },
        { kind: "branch", path: ".", branch: "try/two" },
      ],
    ]);
    const [call] = extraItems(inventory, extras, new Set(["uncommitted:."]), every);
    // A secret by its name is never in the list, even when its id is passed.
    expect(call).toEqual([
      { kind: "uncommitted", path: ".", sendAnyway: ["notes/keys.txt", "data/big.bin"] },
    ]);
    expect(extraItems(inventory, extras, new Set(["uncommitted:."]), new Set())).toEqual([
      [{ kind: "uncommitted", path: ".", sendAnyway: [] }],
    ]);
  });

  it("spells the branch prefix only for a machine name Git keeps as it is", () => {
    expect(arrivalPrefix("m4")).toBe("swc/from-m4/");
    expect(arrivalPrefix("linux-mini.local")).toBe("swc/from-linux-mini.local/");
    expect(arrivalPrefix("Anna's MacBook Air")).toBe("swc/from-…/");
    expect(arrivalPrefix("m4.lock")).toBe("swc/from-…/");
  });
});

const sent = (extra: Partial<ProjectSyncExtraResult> = {}): ProjectSyncExtraResult => ({
  kind: "branch",
  path: ".",
  branch: "fix/menu",
  status: "sent",
  arrivedAs: "swc/from-M4/fix/menu",
  landed: "created",
  stays: null,
  detail: null,
  bytes: 4_300_000,
  includedCommits: 0,
  includedBranch: null,
  leftOut: [],
  leftOutNotListed: 0,
  ...extra,
});

describe("extraResultLine", () => {
  const read = (extra: Partial<ProjectSyncExtraResult>) => {
    const line = extraResultLine(sent(extra), names);
    return [readSyncText(line.sentence), ...line.facts.map(readSyncText)].join(" | ");
  };

  it("names the branch an extra arrived as, and the next step", () => {
    expect(read({})).toBe(
      "On M5 as branch swc/from-M4/fix/menu. To use it there, check it out or merge it.",
    );
    expect(extraResultLine(sent(), names).size).toBe("4.1 MB");
    expect(read({ landed: "unchanged" })).toBe("M5 already has it as branch swc/from-M4/fix/menu.");
    expect(read({ landed: "checked-out", arrivedAs: "swc/from-M4/fix/menu-a3f9c1" })).toBe(
      "fix/menu is checked out on M5, so this arrived beside it as swc/from-M4/fix/menu-a3f9c1. To use it there, check it out or merge it.",
    );
    expect(read({ landed: "beside", arrivedAs: "swc/from-M4/fix/menu-a3f9c1" })).toBe(
      "M5 has other work under that name, so this arrived beside it as swc/from-M4/fix/menu-a3f9c1. To use it there, check it out or merge it.",
    );
    expect(
      read({
        kind: "uncommitted",
        branch: null,
        arrivedAs: "swc/from-M4/uncommitted-20261118-141502-a3f9c1",
        includedCommits: 10,
        includedBranch: "fix/menu",
        leftOutNotListed: 2,
      }),
    ).toBe(
      "On M5 as branch swc/from-M4/uncommitted-20261118-141502-a3f9c1. To use it there, check it out or merge it. | Includes 10 commits not pushed on fix/menu | 2 files left out",
    );
  });

  it("says why an extra stays", () => {
    const stays = (reason: ProjectSyncExtraResult["stays"], detail: string | null = null) =>
      read({ status: "stays", arrivedAs: null, landed: null, stays: reason, detail, bytes: 0 });
    expect(stays("file-too-large", "media/demo.mov is 48 MB, over 10 MB.")).toBe(
      'Stays on M4: media/demo.mov is 48 MB, over 10 MB. "Compare all files…" can bring it.',
    );
    expect(stays("bundle-too-large")).toBe(
      'Stays on M4: it is over a size limit. "Compare all files…" can bring it.',
    );
    expect(stays("needs-update")).toBe("Stays on M4: update SpecWithCode on M5 first.");
    expect(stays("unreachable")).toBe("Stays on M4: M5 could not be reached.");
    expect(stays("nothing-to-send")).toBe("Nothing to send: M5 would get no new work.");
    expect(stays("missing-branch")).toBe("Stays on M4: the branch is no longer there.");
    expect(stays("refused", "M5: no work grant for Atlas")).toBe(
      "Stays on M4: M5: no work grant for Atlas.",
    );
    expect(stays("failed")).toBe("Stays on M4: it could not be sent.");
    expect(extraResultLine(sent({ status: "stays", stays: "failed", bytes: 0 }), names).size).toBe(
      null,
    );
  });
});

describe("syncFailure", () => {
  const read = (cause: unknown) => {
    const failure = syncFailure(cause, "M5");
    return [failure.kind, readSyncText(failure.line)];
  };

  it("reads only an unknown call as a machine that needs an update", () => {
    expect(isUnknownSyncCall("Unknown request tag: projectSync.fetch")).toBe(true);
    expect(isUnknownSyncCall(new Error("Unknown request tag: projectSync.status"))).toBe(true);
    expect(isUnknownSyncCall(new Error("socket closed"))).toBe(false);
    expect(read("Unknown request tag: projectSync.fetch")).toEqual([
      "needs-update",
      'Update SpecWithCode on M5 to sync with Git. "Compare all files…" works now.',
    ]);
  });

  it("tells offline, read only, not there and Git's own reason apart", () => {
    expect(
      read({ _tag: "EnvironmentRpcUnavailableError", message: "M5 is not connected." }),
    ).toEqual(["offline", "M5 is offline. Sync needs both machines connected."]);
    expect(read({ _tag: "EnvironmentAuthorizationError", message: "needs a scope" })).toEqual([
      "read-only",
      "This window can only read M5, so it cannot sync it. Open SpecWithCode on M5, or connect to it with full access.",
    ]);
    expect(read({ _tag: "ProjectSyncError", code: "not_found", reason: "x" })).toEqual([
      "not-found",
      "M5 does not have this project.",
    ]);
    expect(read({ _tag: "ProjectSyncError", code: "personal", reason: "x" })[0]).toBe("personal");
    expect(read({ _tag: "ProjectSyncError", code: "invalid", reason: "x" })).toEqual([
      "not-git",
      'The project folder on M5 is not a Git repository. Use "Compare all files…".',
    ]);
    expect(
      read({
        _tag: "ProjectSyncError",
        code: "failed",
        reason: "Could not read this machine's projects.",
      }),
    ).toEqual(["failed", "M5 could not do it: Could not read this machine's projects."]);
    expect(read(undefined)).toEqual([
      "failed",
      "M5 did not answer. Check the connection, then check again.",
    ]);
  });
});

/** Every phrase the Sync surfaces can show must be in all eight languages. */
describe("the Sync and Add words are in every language", () => {
  const here = NodePath.dirname(new URL(import.meta.url).pathname);
  const read = (file: string) => NodeFS.readFileSync(NodePath.resolve(here, file), "utf8");
  const literals = (source: string) =>
    [...source.matchAll(/"((?:[^"\\\n]|\\.)*)"|'((?:[^'\\\n]|\\.)*)'/gu)].map((match) =>
      (match[1] ?? match[2] ?? "").replace(/\\(["'])/gu, "$1"),
    );
  /** Sentences of a file with no JSX: every literal with a space and a word in it. */
  const sentences = (file: string) =>
    literals(
      read(file)
        .replace(/\/\*[\s\S]*?\*\//gu, "")
        .replace(/^\s*\/\/.*$/gmu, "")
        .replace(/^import [\s\S]*?;$/gmu, ""),
    ).filter((text) => text.includes(" ") && /[A-Za-z]{2}/u.test(text));
  /** Literal `tx("…")` calls of a component. */
  const translated = (file: string) =>
    [...read(file).matchAll(/\btx\(\s*(?:"((?:[^"\\]|\\.)*)"|'((?:[^'\\]|\\.)*)')/gu)].map(
      (match) => (match[1] ?? match[2] ?? "").replace(/\\(["'])/gu, "$1"),
    );
  const phrases = [
    // A machine's refusal sentences are matched, and shown through sentences of their own.
    ...sentences("projectSyncDialog.logic.ts").filter(
      (text) => !KNOWN_REFUSAL_DETAILS.includes(text),
    ),
    ...sentences("useProjectSyncMenu.ts").filter((text) => !text.startsWith("../")),
    ...translated("ProjectSyncDialog.tsx"),
    "Same as {shown}",
    "Same as {shown} · as of {time}",
    "{k} of {n} repositories differ",
    "{k} of {n} repositories differ · as of {time}",
    "Not checked yet",
    "Needs update · {version}",
    "Needs update",
    "Sync…",
    "Add to another machine…",
  ];

  it("finds the phrases it checks", () => {
    expect(phrases).toContain("Up to date");
    expect(phrases).toContain('Not in Git on a remote. Use "Compare all files…"');
    expect(phrases).toContain("Compare all files…");
    expect(phrases).toContain("This window can only read {machine}");
    expect(phrases.length).toBeGreaterThan(80);
  });

  it.each([
    ["de", de],
    ["es", es],
    ["fr", fr],
    ["ja", ja],
    ["ko", ko],
    ["pt", pt],
    ["ru", ru],
    ["zh", zh],
  ])("%s", (_name, catalog) => {
    expect([...new Set(phrases)].filter((phrase) => !Object.hasOwn(catalog, phrase))).toEqual([]);
  });
});
