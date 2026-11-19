/**
 * Whether a chat's worktree folder is finished and may go, and if not, why it
 * stays. Pure: the sweep gathers the facts, and both the plan Settings >
 * Storage shows and the sweep that removes call this one function, so what a
 * person reads is what the sweep then does.
 *
 * A folder holds one worktree, or one per repository of a worktree set; each
 * is a member. Facts of a later, costlier stage (Git in each member, the
 * default branch, the host's pull request, a walk for nested repositories) may
 * be `undefined`: the decision then asks for that stage (`needs`) instead of
 * guessing, and only while a rule that is switched on could still remove the
 * folder. `null` is a fact that could not be read, and it keeps the folder.
 *
 * Rules, preferred in this order when several hold.
 * Under every rule a member with commits on no remote keeps the folder, unless
 * that content is on the default branch.
 *
 * - deleted: every chat using it was deleted ("Delete worktrees with deleted threads").
 * - inactive: its chats are closed and nothing happened for the configured days.
 * - unchanged: its chats are closed and no member has commits of its own.
 * - merged or closed: a member's pull request merged or closed, and every
 *   member is merged with its content on the default branch, closed with
 *   nothing unpushed, or has no commits of its own. Merged work goes as soon
 *   as every head chat is finished; a closed pull request, and a chat that is
 *   still open, wait until the folder has been quiet for six hours. Resolved
 *   and archived chats need no wait.
 * - on the default branch: every member has no commits of its own, every head
 *   chat is finished, and the folder has been quiet for six hours (the merged
 *   rule's switch; reported as "unchanged").
 * - resolved: every head chat is resolved or archived and every member is
 *   pushed or on the default branch ("Delete worktrees of resolved chats").
 *
 * A head chat is one whose parent does not use the same folder; sub-chats
 * never decide, but one that is not quiet keeps the folder. A head chat is
 * finished when it is resolved, archived, or its last run completed and it
 * waits for nothing; one whose last run failed or was stopped stays open.
 *
 * @module finishedWorktrees
 */
import type {
  StorageCleanupKeepReason,
  StorageCleanupRemoveReason,
} from "@specweave-studio/contracts";

import { elapsedMs, olderThan } from "./failClosedAge.ts";
import { ORPHAN_MERGED_IDLE_MS } from "./orphanWorktrees.ts";

const DAY_MS = 86_400_000;
const HOUR_MS = 3_600_000;

/** Ignored evidence files are copied up to this much per folder; more keeps the folder. */
export const MEDIA_LIMIT_BYTES = 1024 ** 3;
export const MEDIA_LIMIT_FILES = 2_000;

const MEDIA_EXTENSIONS = new Set([
  "mp4",
  "mov",
  "webm",
  "mkv",
  "m4v",
  "wav",
  "mp3",
  "m4a",
  "png",
  "jpg",
  "jpeg",
  "gif",
  "webp",
  "heic",
  "pdf",
]);

/** A recording, screenshot or document worth keeping as evidence, by its extension. */
export function isMediaFile(name: string): boolean {
  const dot = name.lastIndexOf(".");
  return dot > 0 && MEDIA_EXTENSIONS.has(name.slice(dot + 1).toLowerCase());
}

/**
 * An ignored file that is copied to evidence before its folder goes, by its
 * path in its member with forward slashes: media anywhere, anything in a
 * `reports` folder (review reports, run output), and SpecWeave's own local
 * state and logs under `.specweave/`. Nothing else: an ignored file elsewhere
 * can be a credential, and it keeps the folder instead.
 */
export function isEvidenceFile(relative: string): boolean {
  const name = relative.slice(relative.lastIndexOf("/") + 1);
  return (
    isMediaFile(name) || /(^|\/)reports\/[^/]/.test(relative) || relative.startsWith(".specweave/")
  );
}

/** "finished": not resolved or archived, but its last run completed and nothing is pending. */
export type FinishedChatState = "open" | "finished" | "resolved" | "archived";

export interface FinishedFolderChats {
  /** Chats whose parent does not use this folder. */
  readonly heads: ReadonlyArray<{ readonly title: string; readonly state: FinishedChatState }>;
  /** The title of the first chat using it, sub-chats included, that is not quiet. */
  readonly notQuiet: string | null;
  /** The newest activity of any chat using it; null when any is unknown. */
  readonly newestActivityAt: number | null;
  /** A head chat's last synced pull request merged or closed (no host lookup). */
  readonly pullRequestFinished: boolean;
}

export interface FinishedPullRequest {
  readonly state: "merged" | "closed" | "open" | "none";
  /** Merged, and merging its HEAD would add nothing to the default branch. */
  readonly contentIntegrated: boolean;
}

export interface FinishedMemberGit {
  /** The branch checked out there; null for a detached HEAD. */
  readonly branch: string | null;
  readonly changes: boolean | null;
  /** New files Git does not track, other members left out. */
  readonly untracked: ReadonlyArray<string> | null;
  /** Names of ignored files that are neither rebuildable nor media. */
  readonly ignoredOther: ReadonlyArray<string> | null;
  /** Ignored media, reports and SpecWeave state, copied to evidence before removal. */
  readonly media: { readonly files: number; readonly bytes: number } | null;
  /** Edits Git status hides (assume-unchanged, skip-worktree). */
  readonly hiddenTrackedChanges: boolean | null;
  /** A stash entry made on its branch. */
  readonly stash: boolean | null;
  /** Commits only its own HEAD reflog reaches; removal deletes that reflog. */
  readonly reflogOnlyCommits: number | null;
  /** Commits on HEAD that no remote-tracking ref has. */
  readonly unpushedCommits: number | null;
  /** Its repository has the chat's branch, so a resumed chat gets the member back. */
  readonly restorable: boolean | null;
  /** A repository inside it that is not a member. */
  readonly nestedRepository: boolean | null | undefined;
  /** HEAD is on the refreshed default branch: no commits of its own. */
  readonly headInDefault: boolean | null | undefined;
  readonly pullRequest: FinishedPullRequest | null | undefined;
}

export interface FinishedMember {
  /** Where it sits in the folder; "" is the folder itself. */
  readonly relativePath: string;
  /** Why its Git registration cannot be trusted; null when it can. */
  readonly registration: string | null;
  /** `git worktree lock` was run on it. */
  readonly locked: boolean;
  readonly git: FinishedMemberGit | undefined;
}

export interface FinishedFolderFacts {
  /** The chats using it; null when only deleted chats recorded it. */
  readonly chats: FinishedFolderChats | null;
  /** Only deleted chats recorded it; their cleanup effects may still run. */
  readonly deleted: { readonly cleanupPending: boolean } | null;
  /** The branch its chats record; null when none does or they disagree. */
  readonly chatBranch: string | null;
  /** Why cleanup must never touch it (outside the worktree folders, holds a project). */
  readonly outOfReach: string | null;
  /** Something about it could not be read (the worktree-set manifest). */
  readonly unreadable: string | null;
  /** An open chat of another folder inside it or around it. */
  readonly openNearby: string | null;
  /** A terminal, live agent session or process working in it. */
  readonly inUse: string | null;
  readonly processesUnknown: boolean;
  /** Entries of a folder whose worktree set has no member yet. */
  readonly looseFiles: number;
  readonly members: ReadonlyArray<FinishedMember>;
}

/** The rules in force for the folder's project. */
export interface FinishedWorktreeRules {
  readonly worktreeAfterDays: number | null;
  readonly worktreeOnMerge: boolean;
  readonly worktreeOnDelete: boolean;
  readonly worktreeUnchanged: boolean;
  /** Off too when the project's worktree cleanup is Off. */
  readonly removeResolvedWorktrees: boolean;
}

export type FinishedWorktreeNeed =
  | "git"
  | "default-branch"
  | "pull-request"
  | "nested-repositories";

export type FinishedWorktreeDecision =
  | {
      readonly action: "remove";
      readonly reason: StorageCleanupRemoveReason;
      readonly detail: string | null;
    }
  | {
      readonly action: "keep";
      readonly reason: StorageCleanupKeepReason;
      readonly detail: string | null;
      /** Facts that may change this answer; gather them and decide again. */
      readonly needs?: FinishedWorktreeNeed;
    };

const keep = (
  reason: StorageCleanupKeepReason,
  detail: string | null,
  needs?: FinishedWorktreeNeed,
): FinishedWorktreeDecision =>
  needs === undefined
    ? { action: "keep", reason, detail }
    : { action: "keep", reason, detail, needs };
const notChecked = (needs: FinishedWorktreeNeed) => keep("unknown", "Not checked yet.", needs);

const label = (member: FinishedMember) =>
  member.relativePath === "" ? "The folder" : member.relativePath;
const plural = (count: number, noun: string) => `${count} ${noun}${count === 1 ? "" : "s"}`;

/** Content a removal would lose, in every member; null when nothing does. */
function contentKeep(
  member: FinishedMember,
  git: FinishedMemberGit,
  chatBranch: string,
): FinishedWorktreeDecision | null {
  const name = label(member);
  if (
    git.changes === null ||
    git.untracked === null ||
    git.ignoredOther === null ||
    git.media === null ||
    git.hiddenTrackedChanges === null ||
    git.restorable === null
  )
    return keep("unknown", `${name}: Git gave no answer.`);
  // The folder's own worktree must hold the chat's branch: resume restores that one.
  if (member.relativePath === "" && git.branch !== chatBranch)
    return keep(
      "unknown",
      `${name} has ${git.branch ?? "no branch"} checked out; its chat records ${chatBranch}.`,
    );
  if (git.changes) return keep("changes", `${name}: files changed and not committed.`);
  if (git.untracked.length > 0)
    return keep(
      "untracked",
      `${name}: ${plural(git.untracked.length, "new file")}, such as ${git.untracked[0]}.`,
    );
  if (git.hiddenTrackedChanges)
    return keep("nested-work", `${name}: changes that Git status hides.`);
  if (git.ignoredOther.length > 0)
    return keep(
      "ignored-files",
      `${name}: ${plural(git.ignoredOther.length, "ignored file")} that may hold data, such as ${git.ignoredOther[0]}.`,
    );
  if (!git.restorable)
    return keep(
      "unknown",
      `${name}: its repository no longer has ${chatBranch}, so a resumed chat could not get it back.`,
    );
  return null;
}

/** Content on the default branch: an ancestor, or a merged pull request that adds nothing. */
const integrated = (git: FinishedMemberGit) =>
  git.headInDefault === true || git.pullRequest?.contentIntegrated === true;

/** What happens to one folder now. `needs` asks for more facts before answering. */
export function decideFinishedWorktree(
  facts: FinishedFolderFacts,
  rules: FinishedWorktreeRules,
  now: number,
): FinishedWorktreeDecision {
  // Nothing in a folder whose registration points elsewhere is trusted, not even to read it.
  for (const member of facts.members)
    if (member.registration !== null)
      return keep("broken-registration", `${label(member)}: ${member.registration}`);
  if (facts.unreadable !== null) return keep("unknown", facts.unreadable);
  if (facts.outOfReach !== null) return keep("no-rule", facts.outOfReach);

  const chats = facts.chats;
  if (facts.deleted?.cleanupPending)
    return keep("running", "Its deleted chat's cleanup has not finished.");
  if (chats?.notQuiet != null) return keep("running", `${chats.notQuiet} is not finished.`);
  if (facts.openNearby !== null) return keep("open", facts.openNearby);
  if (facts.inUse !== null) return keep("in-use", facts.inUse);
  if (facts.processesUnknown)
    return keep("unknown", "The list of running processes could not be read.");
  if (facts.looseFiles > 0)
    return keep("untracked", `${plural(facts.looseFiles, "file")} outside any repository.`);
  for (const member of facts.members)
    if (member.locked) return keep("in-use", `${label(member)} is locked (git worktree lock).`);
  const chatBranch = facts.chatBranch;
  if (chatBranch === null) return keep("unknown", "Its chats record no branch, or different ones.");

  const heads = chats?.heads ?? [];
  const openHead = heads.find((head) => head.state === "open");
  const unclosedHead = heads.find((head) => head.state !== "resolved" && head.state !== "archived");
  const headsClosed = heads.length > 0 && unclosedHead === undefined;
  /** Every head chat is finished, resolved or archived. */
  const headsFinished = heads.length > 0 && openHead === undefined;
  const newestActivityAt = chats?.newestActivityAt ?? null;
  const quietLongEnough = olderThan(newestActivityAt, ORPHAN_MERGED_IDLE_MS, now);
  // Settled before any Git command: most folders belong to chats still at work.
  if (facts.deleted !== null && !rules.worktreeOnDelete)
    return keep("no-rule", "Its chat was deleted, and deleting those worktrees is off.");
  if (openHead !== undefined && !(rules.worktreeOnMerge && quietLongEnough)) {
    if (rules.worktreeOnMerge && chats?.pullRequestFinished === true) {
      const quiet = elapsedMs(newestActivityAt, now);
      return quiet === null
        ? keep("unknown", "When it was last used is unknown, so it is kept.")
        : keep(
            "recent",
            `Quiet for ${plural(Math.floor(quiet / HOUR_MS), "hour")}; it goes after 6.`,
          );
    }
    return keep("open", `${openHead.title} is open.`);
  }
  // A finished chat that is not resolved goes only under the merged rule.
  if (unclosedHead !== undefined && !rules.worktreeOnMerge)
    return keep(
      "no-rule",
      `${unclosedHead.title} is finished but not resolved, and deleting merged worktrees is off.`,
    );
  if (
    facts.deleted === null &&
    rules.worktreeAfterDays === null &&
    !rules.worktreeUnchanged &&
    !rules.worktreeOnMerge &&
    !rules.removeResolvedWorktrees
  )
    return keep("no-rule", "No cleanup rule that is switched on covers it.");

  const gits: Array<{ readonly member: FinishedMember; readonly git: FinishedMemberGit }> = [];
  for (const member of facts.members) {
    if (member.git === undefined) return notChecked("git");
    gits.push({ member, git: member.git });
  }
  for (const { member, git } of gits) {
    const content = contentKeep(member, git, chatBranch);
    if (content !== null) return content;
  }
  const media = gits.reduce(
    (total, { git }) => ({
      files: total.files + (git.media?.files ?? 0),
      bytes: total.bytes + (git.media?.bytes ?? 0),
    }),
    { files: 0, bytes: 0 },
  );
  if (media.files > MEDIA_LIMIT_FILES || media.bytes > MEDIA_LIMIT_BYTES)
    return keep(
      "media",
      `${plural(media.files, "file")} to keep, ${(media.bytes / 1024 ** 3).toFixed(1)} GB: more than is copied to evidence automatically.`,
    );

  let applied: {
    readonly reason: StorageCleanupRemoveReason;
    readonly detail: string;
  } | null = null;
  let unpushedBlocker: string | null = null;
  let unknownHistory: string | null = null;

  if (facts.deleted !== null && rules.worktreeOnDelete) {
    applied = { reason: "deleted", detail: "Its chat was deleted." };
  } else if (
    headsClosed &&
    rules.worktreeAfterDays !== null &&
    olderThan(newestActivityAt, rules.worktreeAfterDays * DAY_MS, now)
  ) {
    applied = {
      reason: "inactive",
      detail: `Nothing happened in it for ${plural(rules.worktreeAfterDays, "day")}.`,
    };
  }
  if (applied === null && headsClosed && rules.worktreeUnchanged && gits.length > 0) {
    if (gits.some(({ git }) => git.headInDefault === undefined))
      return notChecked("default-branch");
    if (gits.every(({ git }) => git.headInDefault === true))
      applied = { reason: "unchanged", detail: "No commits of its own." };
  }
  // Resolved chats with everything pushed go under the resolved rule, which
  // asks the host nothing: one lookup per finished folder on every sweep is
  // what exhausts a host's rate limit.
  const resolvedAndPushed =
    facts.deleted === null &&
    headsClosed &&
    rules.removeResolvedWorktrees &&
    gits.every(({ git }) => git.unpushedCommits === 0);
  if (
    applied === null &&
    !resolvedAndPushed &&
    facts.deleted === null &&
    rules.worktreeOnMerge &&
    gits.length > 0 &&
    (headsFinished || quietLongEnough)
  ) {
    if (gits.some(({ git }) => git.headInDefault === undefined))
      return notChecked("default-branch");
    // Nothing of its own and no pull request its chats know as finished: the
    // host is not asked. It goes once it has been quiet, so a chat that only
    // answered a question keeps its folder while the person may still reply.
    const nothingOfItsOwn =
      !headsClosed &&
      gits.every(({ git }) => git.headInDefault === true) &&
      chats?.pullRequestFinished !== true;
    if (nothingOfItsOwn) {
      if (quietLongEnough)
        applied = { reason: "unchanged", detail: "Everything in it is on the default branch." };
    } else if (gits.some(({ git }) => git.branch !== null && git.pullRequest === undefined))
      return notChecked("pull-request");
  }
  if (
    applied === null &&
    !resolvedAndPushed &&
    facts.deleted === null &&
    rules.worktreeOnMerge &&
    gits.length > 0 &&
    (headsFinished || quietLongEnough) &&
    gits.every(({ git }) => git.branch === null || git.pullRequest !== undefined)
  ) {
    const state = (git: FinishedMemberGit) => (git.branch === null ? null : git.pullRequest?.state);
    const finished = gits.some(({ git }) => state(git) === "merged" || state(git) === "closed");
    const everyDone = gits.every(
      ({ git }) =>
        git.headInDefault === true ||
        (state(git) === "merged" && integrated(git)) ||
        (state(git) === "closed" && git.unpushedCommits === 0),
    );
    const merged = gits.some(({ git }) => state(git) === "merged");
    // A closed pull request can be reopened by the person still in the chat.
    if (finished && everyDone && (merged || headsClosed || quietLongEnough)) {
      applied = {
        reason: merged ? "merged" : "closed",
        detail: merged
          ? "Its pull request merged."
          : "Its pull request closed and every commit is on the remote.",
      };
    }
  }
  if (applied === null && facts.deleted === null && rules.removeResolvedWorktrees && headsClosed) {
    let pushed = true;
    for (const { member, git } of gits) {
      if (git.unpushedCommits === null) {
        unknownHistory ??= `${label(member)}: its unpushed commits could not be counted.`;
        pushed = false;
      } else if (git.unpushedCommits > 0) {
        if (git.headInDefault === undefined) return notChecked("default-branch");
        if (git.headInDefault !== true && git.branch !== null && git.pullRequest === undefined)
          return notChecked("pull-request");
        if (!integrated(git)) {
          unpushedBlocker ??= `${label(member)}: ${plural(git.unpushedCommits, "commit")} on no remote.`;
          pushed = false;
        }
      }
    }
    if (pushed) {
      const head = heads[0]!;
      applied = {
        reason: "resolved",
        detail:
          heads.length === 1
            ? `${head.title} is ${head.state}.`
            : "Its chats are resolved or archived.",
      };
    }
  }

  if (applied !== null) {
    // The branch stays, so removal deletes no commit; but commits on no remote
    // exist on this machine only, and every rule keeps the folder for them.
    for (const { member, git } of gits) {
      if (git.unpushedCommits === null)
        return keep("unknown", `${label(member)}: its unpushed commits could not be counted.`);
      if (git.unpushedCommits === 0) continue;
      if (git.headInDefault === undefined) return notChecked("default-branch");
      if (git.headInDefault !== true && git.branch !== null && git.pullRequest === undefined)
        return notChecked("pull-request");
      if (!integrated(git))
        return keep(
          "unpushed",
          `${label(member)}: ${plural(git.unpushedCommits, "commit")} on no remote.`,
        );
    }
    // Walked last: a walk through every untracked and ignored folder is slow.
    for (const { member, git } of gits) {
      if (git.nestedRepository === undefined) return notChecked("nested-repositories");
      if (git.nestedRepository === null)
        return keep("unknown", `${label(member)}: its folders could not be fully checked.`);
      if (git.nestedRepository)
        return keep("nested-work", `${label(member)}: another repository is inside it.`);
    }
    for (const { member, git } of gits) {
      if (git.reflogOnlyCommits === null)
        return keep("unknown", `${label(member)}: its commit history could not be read.`);
      if (git.reflogOnlyCommits > 0)
        return keep(
          "unpushed",
          `${label(member)}: ${plural(git.reflogOnlyCommits, "commit")} that only its own history reaches.`,
        );
      // The stash is the repository's, so removal loses nothing; a person who
      // stashed on this branch may still mean to come back to the folder.
      if (git.stash !== false)
        return git.stash === null
          ? keep("unknown", `${label(member)}: its stash could not be read.`)
          : keep("stash", `${label(member)}: a stash entry made on ${git.branch ?? chatBranch}.`);
    }
    return { action: "remove", reason: applied.reason, detail: applied.detail };
  }

  // A host that gave no answer is why nothing applied: say so, not "open" or "unpushed".
  const silentHost = gits.find(({ git }) => git.pullRequest === null);
  if (silentHost !== undefined)
    return keep(
      "unknown",
      `${label(silentHost.member)}: the Git host gave no answer about its pull request.`,
    );
  if (openHead !== undefined) return keep("open", `${openHead.title} is open.`);
  if (unpushedBlocker !== null) return keep("unpushed", unpushedBlocker);
  if (unknownHistory !== null) return keep("unknown", unknownHistory);
  if (unclosedHead !== undefined && rules.worktreeOnMerge) {
    if (gits.every(({ git }) => git.headInDefault === true)) {
      const quiet = elapsedMs(newestActivityAt, now);
      return quiet === null
        ? keep("unknown", "When it was last used is unknown, so it is kept.")
        : keep(
            "recent",
            `Quiet for ${plural(Math.floor(quiet / HOUR_MS), "hour")}; it goes after 6.`,
          );
    }
    return keep("open", `${unclosedHead.title} is finished, but its work is not merged.`);
  }
  return keep("no-rule", "No cleanup rule that is switched on covers it.");
}
