/**
 * SkillRepoSources — the skill repos this machine has connected and what each
 * offers.
 *
 * A repo is read straight from GitHub at its default branch's head commit:
 * the repo record, the commit, the file tree and each SKILL.md. Two layouts
 * count as skills: `skills/<name>/SKILL.md` and
 * `plugins/<plugin>/skills/<name>/SKILL.md`.
 *
 * Reads go through this machine's own GitHub sign-in when it has one:
 * `gh api`, with a fixed argv, so no token is ever handled here. Without a
 * sign-in, GitHub's public API is asked anonymously, which only ever answers
 * for a public repo; a private one then reads as "sign in to GitHub". A repo
 * GitHub reports as private is read through `gh` alone. No other host is
 * asked about any repo, and no skill registry is involved.
 *
 * The connected list is one small file in this machine's state folder.
 *
 * @module project/SkillRepoSources
 */
import {
  parseSkillRepoRef,
  ProjectSkillsActionError,
  SKILL_REPO_SKILL_PATTERN,
  SUGGESTED_SKILL_REPOS,
  type ProjectSkillRepo,
  type ProjectSkillRepoSkill,
  type ProjectSkillReposInput,
  type ProjectSkillReposResult,
  type SkillRepoRefusalReason,
} from "@specweave-studio/contracts";
import * as Clock from "effect/Clock";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Option from "effect/Option";
import * as Path from "effect/Path";
import * as Schema from "effect/Schema";
import * as Semaphore from "effect/Semaphore";

import { sha256 } from "../nodeCrypto.ts";
import type { CliRun } from "./ProjectSkillsActionsCommon.ts";
import { readSkillFrontmatter } from "./projectSkillsInventory.ts";

const CACHE_TTL_MS = 60_000;
const MAX_SKILLS_PER_REPO = 200;
const MAX_SKILL_FILE_BYTES = 512 * 1024;
const MAX_STORE_BYTES = 256 * 1024;
const FILE_READS_AT_ONCE = 6;
const JSON_ACCEPT = "application/vnd.github+json";
const SHA_ACCEPT = "application/vnd.github.sha";
const RAW_ACCEPT = "application/vnd.github.raw";
const COMMIT_SHA = /^[0-9a-f]{40}$/;
const BRANCH_NAME = /^[A-Za-z0-9][A-Za-z0-9._/-]{0,199}$/;

export interface SkillRepoSourcesDeps {
  /** Where this machine keeps its connected repos. */
  readonly storePath: string;
  /** `gh <args>` on this machine; `exitCode: null` when gh is not installed. */
  readonly gh: (args: ReadonlyArray<string>) => Effect.Effect<CliRun>;
  /** An anonymous GET to GitHub; `status: 0` when the request did not complete. */
  readonly get: (
    url: string,
    accept: string,
  ) => Effect.Effect<{ readonly status: number; readonly body: string }>;
}

/** One repo read at its head, or why it could not be read. */
export type SkillRepoRead =
  | {
      readonly state: "ok";
      readonly repo: string;
      readonly visibility: "public" | "private";
      readonly commit: string;
      readonly checkedAt: string;
      readonly skills: ReadonlyArray<ProjectSkillRepoSkill>;
      readonly truncated: boolean;
    }
  | { readonly state: SkillRepoRefusalReason };

/** One skill at its source's head, or why it could not be read. */
export type SkillSourceRead =
  | {
      readonly state: "ok";
      readonly visibility: "public" | "private";
      readonly skill: ProjectSkillRepoSkill;
    }
  | { readonly state: SkillRepoRefusalReason };

const RepoRecord = Schema.fromJsonString(
  Schema.Struct({
    full_name: Schema.optionalKey(Schema.String),
    private: Schema.optionalKey(Schema.Boolean),
    visibility: Schema.optionalKey(Schema.String),
    default_branch: Schema.optionalKey(Schema.String),
  }),
);
const TreeRecord = Schema.fromJsonString(
  Schema.Struct({
    truncated: Schema.optionalKey(Schema.Boolean),
    tree: Schema.Array(
      Schema.Struct({
        path: Schema.String,
        type: Schema.optionalKey(Schema.String),
        size: Schema.optionalKey(Schema.Number),
      }),
    ),
  }),
);
const decodeRepoRecord = Schema.decodeUnknownOption(RepoRecord);
const decodeTreeRecord = Schema.decodeUnknownOption(TreeRecord);

const StoreFile = Schema.fromJsonString(
  Schema.Struct({
    version: Schema.Literal(1),
    repos: Schema.Array(
      Schema.Struct({
        repo: Schema.String,
        visibility: Schema.Literals(["public", "private"]),
        connectedAt: Schema.String,
      }),
    ),
  }),
);
const decodeStoreFile = Schema.decodeUnknownOption(StoreFile);
const encodeStoreFile = Schema.encodeSync(StoreFile);
type StoredRepo = (typeof StoreFile.Type)["repos"][number];

/**
 * The skills in a repo's file tree: `skills/<name>/SKILL.md` first, then
 * `plugins/<plugin>/skills/<name>/SKILL.md`. A name found in both keeps the
 * `skills/` copy. Names that could read as a flag or a hidden folder are left out.
 */
export function discoverRepoSkillPaths(
  tree: ReadonlyArray<{ readonly path: string; readonly type?: string | undefined }>,
): ReadonlyArray<{ readonly name: string; readonly path: string; readonly plugin: string | null }> {
  const found = new Map<string, { name: string; path: string; plugin: string | null }>();
  const blobs = tree.filter((entry) => entry.type === undefined || entry.type === "blob");
  for (const entry of blobs) {
    const match = /^skills\/([^/]+)\/SKILL\.md$/.exec(entry.path);
    if (match && SKILL_REPO_SKILL_PATTERN.test(match[1]!))
      found.set(match[1]!, { name: match[1]!, path: entry.path, plugin: null });
  }
  for (const entry of blobs) {
    const match = /^plugins\/([^/]+)\/skills\/([^/]+)\/SKILL\.md$/.exec(entry.path);
    if (
      match &&
      SKILL_REPO_SKILL_PATTERN.test(match[1]!) &&
      SKILL_REPO_SKILL_PATTERN.test(match[2]!) &&
      !found.has(match[2]!)
    )
      found.set(match[2]!, { name: match[2]!, path: entry.path, plugin: match[1]! });
  }
  return [...found.values()].toSorted((left, right) => left.name.localeCompare(right.name));
}

const unquote = (value: string) => {
  const text = value.trim();
  const quoted = /^(["'])([\s\S]*)\1$/.exec(text);
  return quoted ? quoted[2]! : text.replace(/\s+#.*$/, "");
};

/** `description` from a SKILL.md's frontmatter, one line, at most 400 characters. */
export function readSkillDescription(content: string): string | undefined {
  const normalized = content.replace(/^﻿/, "").replace(/\r\n/g, "\n");
  const match = /^---\n([\s\S]*?)\n---/.exec(normalized);
  if (!match) return undefined;
  const lines = match[1]!.split("\n");
  const index = lines.findIndex((line) => /^description[ \t]*:/.test(line));
  if (index === -1) return undefined;
  const inline = lines[index]!.replace(/^description[ \t]*:/, "").trim();
  let text = inline;
  if (inline === "" || /^[>|][+-]?$/.test(inline)) {
    const block: string[] = [];
    for (const line of lines.slice(index + 1)) {
      if (!/^\s+\S/.test(line) && line.trim() !== "") break;
      block.push(line.trim());
    }
    text = block.filter((line) => line !== "").join(" ");
  } else text = unquote(inline);
  const flat = text.replace(/\s+/g, " ").trim();
  if (flat === "") return undefined;
  return flat.length > 400 ? `${flat.slice(0, 399)}…` : flat;
}

const encodePath = (path: string) => path.split("/").map(encodeURIComponent).join("/");

/** The HTTP status in what `gh api` printed for a failed request, or 0. */
const ghStatus = (run: CliRun): number => {
  if (run.timedOut || run.exitCode === null) return 0;
  const match = /HTTP (\d{3})/.exec(`${run.stderr}\n${run.stdout}`);
  return match ? Number(match[1]) : 0;
};

const refusalFor = (status: number, via: "gh" | "anonymous"): SkillRepoRefusalReason =>
  status === 404
    ? via === "gh"
      ? "not-found"
      : "needs-sign-in"
    : status === 403 || status === 429
      ? "rate-limited"
      : status === 401
        ? "needs-sign-in"
        : "unreachable";

export const makeSkillRepoSources = Effect.fn("SkillRepoSources.make")(function* (
  deps: SkillRepoSourcesDeps,
) {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const storeLock = yield* Semaphore.make(1);
  const cache = new Map<string, { readonly at: number; readonly read: SkillRepoRead }>();

  const nowIso = Clock.currentTimeMillis.pipe(
    Effect.map((millis) => DateTime.formatIso(DateTime.makeUnsafe(millis))),
  );

  // -- GitHub ---------------------------------------------------------------

  type Answer = { readonly status: number; readonly body: string };
  interface Session {
    readonly via: "gh" | "anonymous";
    readonly api: (endpoint: string, accept: string) => Effect.Effect<Answer>;
    readonly file: (
      repo: string,
      commit: string,
      filePath: string,
    ) => Effect.Effect<Answer>;
  }

  const ghSession: Session = {
    via: "gh",
    api: (endpoint, accept) =>
      deps
        .gh(["api", "--hostname", "github.com", "-H", `Accept: ${accept}`, endpoint])
        .pipe(
          Effect.map((run) =>
            run.exitCode === 0
              ? { status: 200, body: run.stdout }
              : { status: ghStatus(run), body: "" },
          ),
        ),
    file: (repo, commit, filePath) =>
      ghSession.api(`repos/${repo}/contents/${encodePath(filePath)}?ref=${commit}`, RAW_ACCEPT),
  };
  const anonymousSession: Session = {
    via: "anonymous",
    api: (endpoint, accept) => deps.get(`https://api.github.com/${endpoint}`, accept),
    file: (repo, commit, filePath) =>
      deps.get(
        `https://raw.githubusercontent.com/${repo}/${commit}/${encodePath(filePath)}`,
        RAW_ACCEPT,
      ),
  };

  const signedIn = deps
    .gh(["auth", "status", "--hostname", "github.com"])
    .pipe(Effect.map((run) => run.exitCode === 0 && !run.timedOut));

  interface Opened {
    readonly session: Session;
    readonly repo: string;
    readonly visibility: "public" | "private";
    readonly defaultBranch: string;
  }

  /** The repo's record, through the sign-in when there is one. */
  const open = (repo: string): Effect.Effect<Opened | { readonly state: SkillRepoRefusalReason }> =>
    Effect.gen(function* () {
      const record = (session: Session) =>
        session.api(`repos/${repo}`, JSON_ACCEPT).pipe(
          Effect.map((answer) => {
            if (answer.status !== 200) return { state: refusalFor(answer.status, session.via) };
            const decoded = decodeRepoRecord(answer.body);
            if (Option.isNone(decoded)) return { state: "unreachable" as const };
            const isPrivate =
              decoded.value.private === true ||
              (decoded.value.visibility !== undefined && decoded.value.visibility !== "public");
            const branch = decoded.value.default_branch ?? "";
            if (!BRANCH_NAME.test(branch)) return { state: "unreachable" as const };
            const canonical = parseSkillRepoRef(decoded.value.full_name ?? "") ?? repo;
            return {
              session,
              repo: canonical,
              visibility: isPrivate ? ("private" as const) : ("public" as const),
              defaultBranch: branch,
            };
          }),
        );
      if (yield* signedIn) {
        const viaGh = yield* record(ghSession);
        // A sign-in GitHub no longer accepts reads like none at all.
        if (!("state" in viaGh) || viaGh.state !== "needs-sign-in") return viaGh;
      }
      const anonymous = yield* record(anonymousSession);
      // The anonymous API only answers for public repos; anything else stays unread.
      if (!("state" in anonymous) && anonymous.visibility === "private")
        return { state: "needs-sign-in" as const };
      return anonymous;
    });

  const headCommit = (
    opened: Opened,
    branch: string,
  ): Effect.Effect<
    | { readonly state: SkillRepoRefusalReason; readonly commit?: never }
    | { readonly commit: string; readonly state?: never }
  > =>
    opened.session
      .api(`repos/${opened.repo}/commits/${encodeURIComponent(branch)}`, SHA_ACCEPT)
      .pipe(
        Effect.map((answer) => {
          const commit = answer.body.trim();
          if (answer.status === 200 && COMMIT_SHA.test(commit)) return { commit };
          return {
            state: answer.status === 200 ? "unreachable" : refusalFor(answer.status, "gh"),
          };
        }),
      );

  const readFile = (
    opened: Opened,
    commit: string,
    entry: { readonly name: string; readonly path: string; readonly plugin: string | null },
  ) =>
    opened.session.file(opened.repo, commit, entry.path).pipe(
      Effect.map((answer): ProjectSkillRepoSkill | null => {
        if (answer.status !== 200 || answer.body.length > MAX_SKILL_FILE_BYTES) return null;
        const description = readSkillDescription(answer.body);
        return {
          name: entry.name,
          path: entry.path,
          plugin: entry.plugin,
          version: readSkillFrontmatter(answer.body).version,
          ...(description === undefined ? {} : { description }),
          commit,
          contentHash: sha256([answer.body], "hex"),
        };
      }),
    );

  const readRepoNow = (repo: string): Effect.Effect<SkillRepoRead> =>
    Effect.gen(function* () {
      const opened = yield* open(repo);
      if ("state" in opened) return opened;
      const head = yield* headCommit(opened, opened.defaultBranch);
      if (head.state !== undefined) return { state: head.state };
      const treeAnswer = yield* opened.session.api(
        `repos/${opened.repo}/git/trees/${head.commit}?recursive=1`,
        JSON_ACCEPT,
      );
      if (treeAnswer.status !== 200) return { state: refusalFor(treeAnswer.status, "gh") };
      const tree = decodeTreeRecord(treeAnswer.body);
      if (Option.isNone(tree)) return { state: "unreachable" as const };
      const paths = discoverRepoSkillPaths(
        tree.value.tree.filter((entry) => (entry.size ?? 0) <= MAX_SKILL_FILE_BYTES),
      );
      const skills = yield* Effect.forEach(
        paths.slice(0, MAX_SKILLS_PER_REPO),
        (entry) => readFile(opened, head.commit, entry),
        { concurrency: FILE_READS_AT_ONCE },
      );
      return {
        state: "ok" as const,
        repo: opened.repo,
        visibility: opened.visibility,
        commit: head.commit,
        checkedAt: yield* nowIso,
        skills: skills.filter((skill): skill is ProjectSkillRepoSkill => skill !== null),
        truncated: tree.value.truncated === true || paths.length > MAX_SKILLS_PER_REPO,
      };
    });

  /** One repo at its head; a recent answer is reused unless `refresh` is set. */
  const readRepo = (repo: string, refresh = false): Effect.Effect<SkillRepoRead> =>
    Effect.gen(function* () {
      const key = repo.toLowerCase();
      const now = yield* Clock.currentTimeMillis;
      const cached = cache.get(key);
      if (!refresh && cached !== undefined && now - cached.at < CACHE_TTL_MS) return cached.read;
      const read = yield* readRepoNow(repo);
      if (read.state === "ok") cache.set(key, { at: now, read });
      else cache.delete(key);
      return read;
    });

  /**
   * One skill at its source's head. The recorded path is read when given;
   * otherwise, or when it is gone, the repo's skills are searched by name.
   */
  const readSkill = (input: {
    readonly repo: string;
    readonly name: string;
    readonly path?: string | null | undefined;
    readonly branch?: string | null | undefined;
    readonly refresh?: boolean | undefined;
  }): Effect.Effect<SkillSourceRead> =>
    Effect.gen(function* () {
      const repo = parseSkillRepoRef(input.repo);
      if (repo === null || !SKILL_REPO_SKILL_PATTERN.test(input.name))
        return { state: "invalid" as const };
      const cached = cache.get(repo.toLowerCase());
      const now = yield* Clock.currentTimeMillis;
      const recorded =
        input.path && /^[A-Za-z0-9._/-]{1,400}$/.test(input.path) && !input.path.includes("..")
          ? input.path
          : null;
      // A listing read moments ago already holds the standard layouts.
      if (input.refresh !== true && cached !== undefined && now - cached.at < CACHE_TTL_MS) {
        const read = cached.read;
        if (read.state === "ok") {
          const listed = read.skills.find((skill) =>
            recorded === null ? skill.name === input.name : skill.path === recorded,
          );
          if (listed) return { state: "ok" as const, visibility: read.visibility, skill: listed };
        }
      }
      if (recorded !== null) {
        const opened = yield* open(repo);
        if ("state" in opened) return opened;
        const branch =
          input.branch && BRANCH_NAME.test(input.branch) ? input.branch : opened.defaultBranch;
        const head = yield* headCommit(opened, branch);
        if (head.commit !== undefined) {
          const skill = yield* readFile(opened, head.commit, {
            name: input.name,
            path: recorded,
            plugin: /^plugins\/([^/]+)\/skills\//.exec(recorded)?.[1] ?? null,
          });
          if (skill !== null)
            return { state: "ok" as const, visibility: opened.visibility, skill };
        }
      }
      const read = yield* readRepo(repo, input.refresh === true);
      if (read.state !== "ok") return read;
      const listed = read.skills.find((skill) => skill.name === input.name);
      return listed
        ? { state: "ok" as const, visibility: read.visibility, skill: listed }
        : { state: "not-found" as const };
    });

  // -- The connected list ---------------------------------------------------

  const readStore: Effect.Effect<ReadonlyArray<StoredRepo>> = Effect.gen(function* () {
    const info = yield* fs.stat(deps.storePath).pipe(Effect.option);
    if (Option.isNone(info) || info.value.type !== "File" || info.value.size > BigInt(MAX_STORE_BYTES))
      return [];
    const text = yield* fs.readFileString(deps.storePath).pipe(Effect.option);
    if (Option.isNone(text)) return [];
    const decoded = decodeStoreFile(text.value);
    return Option.isNone(decoded)
      ? []
      : decoded.value.repos.filter((entry) => parseSkillRepoRef(entry.repo) === entry.repo);
  });

  const writeStore = (repos: ReadonlyArray<StoredRepo>) =>
    Effect.gen(function* () {
      const millis = yield* Clock.currentTimeMillis;
      const temporary = `${deps.storePath}.${millis}.tmp`;
      yield* fs.makeDirectory(path.dirname(deps.storePath), { recursive: true });
      yield* fs
        .writeFileString(temporary, `${encodeStoreFile({ version: 1, repos: [...repos] })}\n`, {
          flag: "wx",
          mode: 0o600,
        })
        .pipe(
          Effect.andThen(fs.rename(temporary, deps.storePath)),
          Effect.onError(() => fs.remove(temporary).pipe(Effect.ignore)),
        );
    });

  const listed = (entry: StoredRepo, read: SkillRepoRead): ProjectSkillRepo =>
    read.state === "ok"
      ? {
          repo: entry.repo,
          visibility: read.visibility,
          connectedAt: entry.connectedAt,
          state: "ok",
          commit: read.commit,
          checkedAt: read.checkedAt,
          skills: read.skills,
          ...(read.truncated ? { truncated: true } : {}),
        }
      : {
          repo: entry.repo,
          visibility: entry.visibility,
          connectedAt: entry.connectedAt,
          state: read.state,
          commit: null,
          checkedAt: null,
          skills: [],
        };

  /** Every connected repo with what it offers now. */
  const connected = (refresh = false): Effect.Effect<ReadonlyArray<ProjectSkillRepo>> =>
    readStore.pipe(
      Effect.flatMap((stored) =>
        Effect.forEach(
          stored,
          (entry) => readRepo(entry.repo, refresh).pipe(Effect.map((read) => listed(entry, read))),
          { concurrency: 3 },
        ),
      ),
    );

  const answer = (
    repos: ReadonlyArray<ProjectSkillRepo>,
    refusal?: ProjectSkillReposResult["refusal"],
  ): ProjectSkillReposResult => {
    const have = new Set(repos.map((repo) => repo.repo.toLowerCase()));
    return {
      repos,
      suggestions: SUGGESTED_SKILL_REPOS.filter((repo) => !have.has(repo.toLowerCase())),
      ...(refusal === undefined ? {} : { refusal }),
    };
  };

  const storeFailed = (input: ProjectSkillReposInput) => (cause: unknown) =>
    new ProjectSkillsActionError({
      projectId: input.projectId,
      reason: "read_failed",
      detail: "The list of connected skill repos could not be saved on this machine.",
      cause,
    });

  const repos = (
    input: ProjectSkillReposInput,
  ): Effect.Effect<ProjectSkillReposResult, ProjectSkillsActionError> =>
    Effect.gen(function* () {
      if (input.operation === "read") return answer(yield* connected(input.refresh === true));
      const repo = parseSkillRepoRef(input.repo ?? "");
      if (repo === null)
        return answer(yield* connected(), { reason: "invalid", repo: (input.repo ?? "").trim() });
      if (input.operation === "disconnect") {
        yield* storeLock.withPermits(1)(
          readStore.pipe(
            Effect.flatMap((stored) =>
              writeStore(stored.filter((entry) => entry.repo.toLowerCase() !== repo.toLowerCase())),
            ),
            Effect.mapError(storeFailed(input)),
          ),
        );
        cache.delete(repo.toLowerCase());
        return answer(yield* connected());
      }
      const read = yield* readRepo(repo, true);
      if (read.state !== "ok") return answer(yield* connected(), { reason: read.state, repo });
      const connectedAt = yield* nowIso;
      yield* storeLock.withPermits(1)(
        readStore.pipe(
          Effect.flatMap((stored) =>
            stored.some((entry) => entry.repo.toLowerCase() === read.repo.toLowerCase())
              ? Effect.void
              : writeStore([
                  ...stored,
                  { repo: read.repo, visibility: read.visibility, connectedAt },
                ]),
          ),
          Effect.mapError(storeFailed(input)),
        ),
      );
      cache.set(read.repo.toLowerCase(), { at: yield* Clock.currentTimeMillis, read });
      return answer(yield* connected());
    });

  return { repos, connected, readRepo, readSkill };
});

export type SkillRepoSources = Effect.Success<ReturnType<typeof makeSkillRepoSources>>;
