/**
 * SkillAdopt — moving user skills another tool put on this machine into the
 * vskill lock (increment 1399, AC-10).
 *
 * A folder in `~/.agents/skills` that vskill does not track is either one the
 * `npx skills` CLI tracks in `~/.agents/.skill-lock.json`, or a hand copy.
 * Adopt matches its SKILL.md against the skills of the repos connected here,
 * by the same normalized match the fleet path uses (no BOM, LF endings, and a
 * copy whose Claude Code-only fields were stripped still matches). On a
 * match it records the skill in `~/.agents/vskill.lock` with that source, the
 * way vskill records a GitHub install, reads the entry back, and only then
 * removes the skill's entry from the `npx skills` lock, so one CLI owns the
 * folder. The folder itself is never deleted or rewritten.
 *
 * A folder that matches nothing can be proposed to a connected skill repo: a
 * pull request with the folder's text files, after its own confirmation each
 * time (D-07). It is never merged here. Every `gh` call has a fixed argv; the
 * request bodies go on stdin.
 *
 * @module project/SkillAdopt
 */
import {
  ProjectSkillsActionError,
  SKILL_REPO_SKILL_PATTERN,
  type ProjectId,
  type ProjectSkillAdoptCandidate,
  type ProjectSkillAdoptMatch,
  type ProjectSkillAdoptOutcome,
  type ProjectSkillProposal,
  type ProjectSkillsAdoptInput,
  type ProjectSkillsAdoptResult,
} from "@specweave-studio/contracts";
import * as Clock from "effect/Clock";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Option from "effect/Option";
import * as Path from "effect/Path";
import * as Semaphore from "effect/Semaphore";

import { claudeFieldsStripped } from "../fleet/fleetSkills.ts";
import { sha256 } from "../nodeCrypto.ts";
import { actionError, type CliRun } from "./ProjectSkillsActionsCommon.ts";
import { parseVskillLock, vskillContentSha } from "./projectSkillsInventory.ts";
import type { SkillRepoRead } from "./SkillRepoSources.ts";

const MAX_SKILL_BYTES = 512 * 1024;
const MAX_LOCK_BYTES = 4 * 1024 * 1024;
const MAX_FOLDER_FILES = 200;
const MAX_PROPOSED_FILES = 50;
const MAX_PROPOSED_FILE_BYTES = 256 * 1024;
const MAX_PROPOSED_BYTES = 1024 * 1024;

export interface SkillAdoptDeps {
  readonly home: string;
  readonly stateDir: string;
  /** The `owner/repo` ids connected on this machine. */
  readonly connectedIds: Effect.Effect<ReadonlyArray<string>>;
  readonly readRepo: (repo: string) => Effect.Effect<SkillRepoRead>;
  /** One file of a repo at one commit, through this machine's own GitHub access. */
  readonly readText: (repo: string, path: string, commit: string) => Effect.Effect<string | null>;
  /** `gh <args>` on this machine with `stdin`; `exitCode: null` when gh is missing. */
  readonly gh: (args: ReadonlyArray<string>, stdin?: string) => Effect.Effect<CliRun>;
  /** Called after the vskill lock is written (tests use it to lose the write). */
  readonly afterLockWrite?: (file: string) => Effect.Effect<void>;
}

const normalized = (text: string) => text.replace(/^﻿/, "").replace(/\r\n/g, "\n");

/** Plain JSON text, outside the Effect code that writes it. */
const jsonText = (value: unknown) => `${JSON.stringify(value, null, 2)}\n`;
const compactJson = (value: unknown) => JSON.stringify(value);

/** Whether a local SKILL.md is the source's copy, as installed or with Claude-only fields stripped. */
export function adoptMatches(local: string, source: string): boolean {
  const mine = normalized(local);
  return mine === normalized(source) || mine === claudeFieldsStripped(source);
}

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

const parseJson = (text: string | null): Record<string, unknown> | null => {
  if (text === null) return null;
  try {
    const value: unknown = JSON.parse(text);
    return isRecord(value) ? value : null;
  } catch {
    return null;
  }
};

export const makeSkillAdopt = Effect.fn("SkillAdopt.make")(function* (deps: SkillAdoptDeps) {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const writes = yield* Semaphore.make(1);
  const agentsDir = path.join(deps.home, ".agents");
  const skillsDir = path.join(agentsDir, "skills");
  const vskillLock = path.join(agentsDir, "vskill.lock");
  const npxLock = path.join(agentsDir, ".skill-lock.json");

  const nowIso = Clock.currentTimeMillis.pipe(
    Effect.map((millis) => DateTime.formatIso(DateTime.makeUnsafe(millis))),
  );

  const readSmall = (file: string, limit: number) =>
    Effect.gen(function* () {
      // A link is not followed: the folder must be the skill's own.
      if (Option.isSome(yield* fs.readLink(file).pipe(Effect.option))) return null;
      const info = yield* fs.stat(file).pipe(Effect.option);
      if (Option.isNone(info) || info.value.type !== "File" || info.value.size > BigInt(limit))
        return null;
      return Option.getOrNull(yield* fs.readFileString(file).pipe(Effect.option));
    });

  /** Writes beside the file and renames over it, so no reader sees half a lock. */
  const writeAtomic = (file: string, text: string) =>
    Effect.gen(function* () {
      yield* fs.makeDirectory(path.dirname(file), { recursive: true });
      const temporary = `${file}.adopt-${yield* Clock.currentTimeMillis}.tmp`;
      yield* fs.writeFileString(temporary, text, { flag: "wx", mode: 0o644 }).pipe(
        Effect.andThen(fs.rename(temporary, file)),
        Effect.onError(() => fs.remove(temporary).pipe(Effect.ignore)),
      );
    });

  /** The folder's regular files, relative, hidden segments and links left out. */
  const folderFiles = (folder: string) =>
    Effect.gen(function* () {
      const kept: string[] = [];
      const skipped: string[] = [];
      const queue = [""];
      while (queue.length > 0 && kept.length + skipped.length < MAX_FOLDER_FILES) {
        const relative = queue.shift()!;
        const names = yield* fs
          .readDirectory(path.join(folder, relative))
          .pipe(Effect.orElseSucceed(() => []));
        for (const name of names.toSorted()) {
          const entry = relative === "" ? name : `${relative}/${name}`;
          const full = path.join(folder, entry);
          if (name.startsWith(".") || Option.isSome(yield* fs.readLink(full).pipe(Effect.option))) {
            skipped.push(entry);
            continue;
          }
          const info = yield* fs.stat(full).pipe(Effect.option);
          if (Option.isNone(info)) continue;
          if (info.value.type === "Directory") queue.push(entry);
          else if (info.value.type === "File") kept.push(entry);
          else skipped.push(entry);
        }
      }
      return { kept, skipped };
    });

  const npxEntries = Effect.gen(function* () {
    const lock = parseJson(yield* readSmall(npxLock, MAX_LOCK_BYTES));
    return lock !== null && isRecord(lock.skills) ? lock.skills : {};
  });

  /** A connected repo's skill this folder matches: the tracked source's repo first. */
  const findMatch = (skill: string, local: string, preferred: string | undefined) =>
    Effect.gen(function* () {
      const ids = yield* deps.connectedIds;
      const ordered = [
        ...ids.filter((id) => id.toLowerCase() === preferred?.toLowerCase()),
        ...ids.filter((id) => id.toLowerCase() !== preferred?.toLowerCase()),
      ];
      const localHash = vskillContentSha(local);
      for (const id of ordered) {
        const read = yield* deps.readRepo(id);
        if (read.state !== "ok") continue;
        const listed = read.skills.filter((entry) => entry.name === skill);
        if (listed.length !== 1) continue;
        const candidate = listed[0]!;
        let matches = candidate.contentHash === localHash;
        if (!matches) {
          const text = yield* deps.readText(read.repo, candidate.path, candidate.commit);
          matches = text !== null && adoptMatches(local, text);
        }
        if (!matches) continue;
        return {
          repo: read.repo,
          source: {
            kind: "github",
            path: candidate.path,
            branch: read.branch,
            commit: candidate.commit,
          },
          version: candidate.version,
          contentHash: candidate.contentHash,
          visibility: read.visibility,
        } satisfies ProjectSkillAdoptMatch;
      }
      return null;
    });

  const candidates = Effect.gen(function* () {
    const tracked =
      parseVskillLock((yield* readSmall(vskillLock, MAX_LOCK_BYTES)) ?? "") ?? new Map();
    const npx = yield* npxEntries;
    const names = yield* fs.readDirectory(skillsDir).pipe(Effect.orElseSucceed(() => []));
    const found: ProjectSkillAdoptCandidate[] = [];
    for (const skill of names.toSorted()) {
      if (!SKILL_REPO_SKILL_PATTERN.test(skill) || tracked.has(skill)) continue;
      const local = yield* readSmall(path.join(skillsDir, skill, "SKILL.md"), MAX_SKILL_BYTES);
      if (local === null) continue;
      const entry = npx[skill];
      const trackedSource =
        isRecord(entry) && typeof entry.source === "string" ? entry.source : undefined;
      const match = yield* findMatch(skill, local, trackedSource);
      found.push({
        skill,
        tracker: entry === undefined ? "none" : "npx-skills",
        ...(trackedSource ? { trackedSource } : {}),
        match,
        ...(match === null
          ? { detail: "No connected repo holds this copy. Connect its repo, or add it to one." }
          : {}),
      });
    }
    return found;
  });

  const adoptOne = (skill: string) =>
    writes.withPermits(1)(
      Effect.gen(function* () {
        const failed = (message: string): ProjectSkillAdoptOutcome => ({
          skill,
          outcome: "failed",
          message,
        });
        const all = yield* candidates;
        const candidate = all.find((entry) => entry.skill === skill);
        if (candidate === undefined)
          return failed(`${skill} is not an untracked skill in ~/.agents/skills on this machine.`);
        if (candidate.match === null)
          return failed(candidate.detail ?? "No connected repo holds this copy.");
        const match = candidate.match;
        const folder = path.join(skillsDir, skill);
        const { kept } = yield* folderFiles(folder);
        const now = yield* nowIso;
        const lockText = yield* readSmall(vskillLock, MAX_LOCK_BYTES);
        // A lock that is there but cannot be read (a link, too large, unreadable) is never
        // replaced by a fresh one: that would untrack every other skill.
        const lockPresent =
          Option.isSome(yield* fs.readLink(vskillLock).pipe(Effect.option)) ||
          (yield* fs.exists(vskillLock).pipe(Effect.orElseSucceed(() => true)));
        if (lockText === null && lockPresent)
          return failed("~/.agents/vskill.lock could not be read, so nothing was changed.");
        const lock = parseJson(lockText) ?? {
          version: 1,
          agents: [],
          skills: {},
          createdAt: now,
        };
        if (lockText !== null && parseJson(lockText) === null)
          return failed("~/.agents/vskill.lock could not be read, so nothing was changed.");
        if (lock.skills !== undefined && !isRecord(lock.skills))
          return failed("~/.agents/vskill.lock could not be read, so nothing was changed.");
        const skills = isRecord(lock.skills) ? lock.skills : {};
        skills[skill] = {
          version: match.version ?? "1.0.0",
          sha: match.contentHash,
          tier: "UNSCANNED",
          installedAt: now,
          source: `github:${match.repo}`,
          scope: "user",
          files: kept.length > 0 ? kept : ["SKILL.md"],
          sourceType: "github",
          sourceRepoUrl: `https://github.com/${match.repo}`,
          sourceSkillPath: match.source.path,
          sourceBranch: match.source.branch,
          sourceCommitSha: match.source.commit,
          ...(match.visibility === "private" ? { sourcePrivate: true } : {}),
        };
        lock.skills = skills;
        lock.updatedAt = now;
        const written = yield* writeAtomic(vskillLock, jsonText(lock)).pipe(
          Effect.as(true),
          Effect.orElseSucceed(() => false),
        );
        if (!written) return failed("~/.agents/vskill.lock could not be written.");
        if (deps.afterLockWrite) yield* deps.afterLockWrite(vskillLock);
        const back = parseVskillLock((yield* readSmall(vskillLock, MAX_LOCK_BYTES)) ?? "")?.get(
          skill,
        );
        if (
          back === undefined ||
          back.sha !== match.contentHash ||
          back.sourceCommitSha !== match.source.commit
        )
          return failed(
            "The vskill lock did not read back with this skill, so the npx skills entry was left as it is.",
          );
        // Only now, with vskill owning the skill, is it taken out of the npx skills lock.
        let released = false;
        if (candidate.tracker === "npx-skills") {
          const text = yield* readSmall(npxLock, MAX_LOCK_BYTES);
          const npx = parseJson(text);
          if (npx !== null && isRecord(npx.skills) && Object.hasOwn(npx.skills, skill)) {
            delete npx.skills[skill];
            released = yield* writeAtomic(npxLock, jsonText(npx)).pipe(
              Effect.as(true),
              Effect.orElseSucceed(() => false),
            );
            if (released) {
              const after = parseJson(yield* readSmall(npxLock, MAX_LOCK_BYTES));
              released =
                after !== null && isRecord(after.skills) && !Object.hasOwn(after.skills, skill);
            }
          }
        }
        return {
          skill,
          outcome: "adopted",
          version: back.version ?? match.version ?? "1.0.0",
          commit: match.source.commit.slice(0, 7),
          releasedFromNpxSkills: released,
          ...(candidate.tracker === "npx-skills" && !released
            ? { message: "vskill tracks it now, but its npx skills entry could not be removed." }
            : {}),
        } satisfies ProjectSkillAdoptOutcome;
      }),
    );

  // -- Add to a skill repo ---------------------------------------------------

  const proposal = (projectId: ProjectId, skill: string, repo: string) =>
    Effect.gen(function* () {
      const ids = yield* deps.connectedIds;
      const connected = ids.find((id) => id.toLowerCase() === repo.toLowerCase());
      if (connected === undefined)
        return yield* actionError(
          projectId,
          "scope_unsupported",
          `Connect ${repo} on this machine first.`,
        );
      const read = yield* deps.readRepo(connected);
      if (read.state !== "ok")
        return yield* actionError(
          projectId,
          "agent_unavailable",
          `${repo} could not be read from this machine.`,
        );
      if (read.skills.some((entry) => entry.name === skill))
        return yield* actionError(
          projectId,
          "scope_unsupported",
          `${repo} already holds a skill named ${skill}. Adopt it from there instead.`,
        );
      const folder = path.join(skillsDir, skill);
      const local = yield* readSmall(path.join(folder, "SKILL.md"), MAX_SKILL_BYTES);
      if (local === null)
        return yield* actionError(projectId, "skill_not_found", `${skill} has no SKILL.md here.`);
      const listed = yield* folderFiles(folder);
      const files: Array<{ path: string; text: string }> = [];
      const skipped = [...listed.skipped];
      let total = 0;
      for (const entry of listed.kept) {
        const text = yield* readSmall(path.join(folder, entry), MAX_PROPOSED_FILE_BYTES);
        // Text files only: a NUL byte means binary.
        if (
          text === null ||
          text.includes("\u0000") ||
          files.length >= MAX_PROPOSED_FILES ||
          total + text.length > MAX_PROPOSED_BYTES
        ) {
          skipped.push(entry);
          continue;
        }
        total += text.length;
        files.push({ path: `skills/${skill}/${entry}`, text });
      }
      const fingerprint = sha256(
        [
          compactJson({
            repo: read.repo,
            skill,
            files: files.map((file) => [file.path, sha256([file.text], "hex")]),
          }),
        ],
        "hex",
      );
      return {
        read,
        files,
        proposal: {
          repo: read.repo,
          skill,
          files: files.map((file) => file.path),
          skipped,
          fingerprint,
        } satisfies ProjectSkillProposal,
      };
    });

  const ghJson = (projectId: ProjectId, args: ReadonlyArray<string>, body?: unknown) =>
    Effect.gen(function* () {
      const run = yield* deps.gh(
        [
          "api",
          "--hostname",
          "github.com",
          ...args,
          ...(body === undefined ? [] : ["--input", "-"]),
        ],
        body === undefined ? undefined : compactJson(body),
      );
      if (run.exitCode !== 0 || run.timedOut)
        return yield* actionError(
          projectId,
          "agent_unavailable",
          run.exitCode === null
            ? "GitHub CLI (gh) is not installed on this machine."
            : `GitHub refused the request: ${(run.stderr || run.stdout).trim().slice(-300) || "no details"}`,
        );
      return parseJson(run.stdout) ?? {};
    });

  const propose = (input: Extract<ProjectSkillsAdoptInput, { operation: "propose" }>) =>
    Effect.gen(function* () {
      const prepared = yield* proposal(input.projectId, input.skill, input.repo);
      if (prepared.proposal.fingerprint !== input.fingerprint)
        return yield* actionError(
          input.projectId,
          "scope_unsupported",
          "The folder changed since you confirmed it. Review the files again.",
        );
      const repo = prepared.read.repo;
      const record = yield* ghJson(input.projectId, [`repos/${repo}`]);
      const base =
        typeof record.default_branch === "string" ? record.default_branch : prepared.read.branch;
      const head = yield* ghJson(input.projectId, [
        `repos/${repo}/git/ref/heads/${encodeURIComponent(base)}`,
      ]);
      const sha =
        isRecord(head.object) && typeof head.object.sha === "string" ? head.object.sha : null;
      if (sha === null || !/^[0-9a-f]{40}$/.test(sha))
        return yield* actionError(
          input.projectId,
          "agent_unavailable",
          `${repo} did not report its ${base} branch.`,
        );
      const branch = `add-skill-${input.skill}-${yield* Clock.currentTimeMillis}`;
      yield* ghJson(input.projectId, ["--method", "POST", `repos/${repo}/git/refs`], {
        ref: `refs/heads/${branch}`,
        sha,
      });
      // A proposal that fails part way leaves no half-filled branch behind on GitHub.
      const dropBranch = deps
        .gh([
          "api",
          "--hostname",
          "github.com",
          "--method",
          "DELETE",
          `repos/${repo}/git/refs/heads/${encodeURIComponent(branch)}`,
        ])
        .pipe(Effect.ignore);
      const pull = yield* Effect.gen(function* () {
        for (const file of prepared.files)
          yield* ghJson(
            input.projectId,
            [
              "--method",
              "PUT",
              `repos/${repo}/contents/${file.path.split("/").map(encodeURIComponent).join("/")}`,
            ],
            {
              message: `Add ${input.skill} skill: ${file.path}`,
              content: Buffer.from(file.text, "utf8").toString("base64"),
              branch,
            },
          );
        const pull = yield* ghJson(input.projectId, ["--method", "POST", `repos/${repo}/pulls`], {
          title: `Add ${input.skill} skill`,
          head: branch,
          base,
          body: `Adds the ${input.skill} skill folder (${prepared.files.length} files) so it can be installed with vskill.`,
        });
        const opened = typeof pull.html_url === "string";
        if (!opened) yield* dropBranch;
        return pull;
      }).pipe(Effect.tapError(() => dropBranch));
      const url = typeof pull.html_url === "string" ? pull.html_url : undefined;
      if (url === undefined)
        return yield* actionError(
          input.projectId,
          "agent_unavailable",
          "GitHub did not return the pull request.",
        );
      return url;
    });

  const adopt = (
    input: ProjectSkillsAdoptInput,
  ): Effect.Effect<ProjectSkillsAdoptResult, ProjectSkillsActionError> =>
    Effect.gen(function* () {
      const checkedAt = yield* nowIso;
      switch (input.operation) {
        case "check":
          return { checkedAt, candidates: yield* candidates };
        case "adopt":
          return { checkedAt, outcome: yield* adoptOne(input.skill) };
        case "propose-preview":
          return {
            checkedAt,
            proposal: (yield* proposal(input.projectId, input.skill, input.repo)).proposal,
          };
        case "propose":
          return { checkedAt, pullRequestUrl: yield* propose(input) };
      }
    });

  return { adopt };
});

export type SkillAdopt = Effect.Success<ReturnType<typeof makeSkillAdopt>>;
