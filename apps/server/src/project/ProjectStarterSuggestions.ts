/**
 * Reads a project's folder for first-task ideas: what is unfinished, what can
 * be run, what was handed off. Only reads, with short timeouts, so opening an
 * empty project never waits on a large repository or changes anything in it.
 */
import {
  DEFAULT_PROJECT_WORKSPACE_SETTINGS,
  ProjectWorkspaceError,
  type ProjectId,
  type ProjectStarterSuggestionsResult,
} from "@specweave-studio/contracts";
import {
  buildStarterSuggestions,
  isPlainSourcePath,
  type ProjectStarterSignals,
} from "@specweave-studio/shared/projectStarterSuggestions";
import { compareIncrementFoldersNewestFirst } from "@specweave-studio/shared/specweaveIncrement";
import * as Clock from "effect/Clock";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Path from "effect/Path";
import * as Schema from "effect/Schema";
import * as SqlClient from "effect/sql/SqlClient";
import * as ProjectStore from "../orchestration-v2/ProjectStore.ts";
import * as ProcessRunner from "../processRunner.ts";

export class ProjectStarterSuggestionsService extends Context.Service<
  ProjectStarterSuggestionsService,
  {
    readonly read: (input: {
      projectId: ProjectId;
    }) => Effect.Effect<ProjectStarterSuggestionsResult, ProjectWorkspaceError>;
  }
>()("specweave-studio/project/ProjectStarterSuggestions/ProjectStarterSuggestionsService") {}

/** Entries that do not make a folder a workspace on their own. */
const METADATA_ENTRIES = new Set([".git", ".DS_Store", "Thumbs.db", ".specweave-studio"]);
const README = /^readme(?:\.[a-z0-9]+)?$/i;
const INCREMENT_DIRECTORY = /^\d{3,5}[A-Z]?-[a-z0-9]+(?:-[a-z0-9]+)*$/;
const OPEN_INCREMENT_STATUSES = new Set(["active", "in-progress"]);
/**
 * Every increment's small metadata file is read to find the open ones, since
 * an increment left open stays open however many closed ones follow it. This
 * only bounds a runaway folder.
 */
const INCREMENTS_SCANNED = 5_000;
const INCREMENT_METADATA_CONCURRENCY = 16;
/**
 * Open increments whose ledger and handoff note are read, newest first. All of
 * them are counted and any of them may hold the pending handoff.
 */
const OPEN_INCREMENTS_READ = 60;
const MANIFEST_BYTES = 524_288;
const HANDOFF_FRESH_MS = 3 * 24 * 60 * 60 * 1000;
/** Dated handoff notes pile up in `.specweave/handoffs/`; the newest few are enough. */
const HANDOFF_NOTES_READ = 20;
const HANDOFF_NOTE = /\.(?:json|md)$/i;
const NPM_PLACEHOLDER_TEST = /no test specified/i;
const PLACEHOLDER_SCRIPT = /^\s*(?:echo\b|exit\b|true\s*$)/;
const LINT_SCRIPTS = ["lint"] as const;
const TYPECHECK_SCRIPTS = ["typecheck", "type-check", "check-types", "tsc"] as const;
/** Commits read for the files that change most, as Claude Code does for its prompt hints. */
const HOT_FILE_COMMITS = 300;
const HOT_FILE_LOG_BYTES = 262_144;
const HOT_FILE_MIN_COMMITS = 2;
const HOT_FILE_CANDIDATES = 8;
const HOT_FILES_KEPT = 3;
const HOT_FILE_BYTES = 524_288;
const SOURCE_EXTENSIONS = new Set(
  (
    "ts tsx mts cts js jsx mjs cjs py go rs java kt kts swift rb php cs c cc cpp cxx h hpp m mm " +
    "scala sh vue svelte astro ex exs erl dart lua r jl clj hs ml fs zig nim"
  ).split(" "),
);
/** Folders that hold built, vendored or tool output rather than code someone wrote. */
const GENERATED_SEGMENTS = new Set([
  "node_modules",
  "dist",
  "build",
  "out",
  "target",
  "vendor",
  "third_party",
  "coverage",
  "generated",
  "__generated__",
  "Pods",
]);
const GENERATED_FILE = /\.(?:min|generated|gen|pb|d)\.[a-z]+$|_pb2\.py$/i;
const TEST_FILE =
  /(?:^|\/)(?:__tests__|__mocks__|tests?|spec|e2e|fixtures?)\/|\.(?:test|spec)\.[a-z]+$|_test\.[a-z]+$|(?:^|\/)test_[^/]+$/i;
/** JVM, .NET and Apple tests: `ParserTests.swift`, `ParserTest.java`. Case matters here. */
const CLASS_TEST_FILE = /[a-z0-9]Tests?\.(?:swift|kt|java|cs|m|mm|scala)$/;

function packageScripts(manifest: string): Record<string, unknown> | null {
  try {
    const scripts = (JSON.parse(manifest) as { scripts?: unknown } | null)?.scripts;
    return typeof scripts === "object" && scripts !== null
      ? (scripts as Record<string, unknown>)
      : null;
  } catch {
    return null;
  }
}

/** How the package manager the lockfile names runs a script. */
function scriptRunner(entries: ReadonlySet<string>): "pnpm" | "yarn" | "bun run" | "npm run" {
  if (entries.has("pnpm-lock.yaml")) return "pnpm";
  if (entries.has("yarn.lock")) return "yarn";
  if (entries.has("bun.lock") || entries.has("bun.lockb")) return "bun run";
  return "npm run";
}

/** The test command for a JavaScript project: its own script, run by the manager its lockfile names. */
export function packageTestCommand(manifest: string, entries: ReadonlySet<string>): string | null {
  const test = packageScripts(manifest)?.test;
  if (typeof test !== "string" || test.trim() === "" || NPM_PLACEHOLDER_TEST.test(test))
    return null;
  const runner = scriptRunner(entries);
  return runner === "npm run" ? "npm test" : `${runner} test`;
}

/**
 * The lint and typecheck commands a JavaScript project defines. Only script
 * names from a known list are used, so the command never holds the manifest's text.
 */
export function packageCheckCommands(
  manifest: string,
  entries: ReadonlySet<string>,
): { lintCommand: string | null; typecheckCommand: string | null } {
  const scripts = packageScripts(manifest);
  const pick = (names: readonly string[]) =>
    names.find((name) => {
      const script = scripts?.[name];
      return typeof script === "string" && script.trim() !== "" && !PLACEHOLDER_SCRIPT.test(script);
    }) ?? null;
  const runner = scriptRunner(entries);
  const lint = pick(LINT_SCRIPTS);
  const typecheck = pick(TYPECHECK_SCRIPTS);
  return {
    lintCommand: lint === null ? null : `${runner} ${lint}`,
    typecheckCommand: typecheck === null ? null : `${runner} ${typecheck}`,
  };
}

/** Whether a changed path is source someone wrote: not a test, lockfile, binary or build output. */
export function isHotFileCandidate(path: string): boolean {
  if (
    !isPlainSourcePath(path) ||
    TEST_FILE.test(path) ||
    CLASS_TEST_FILE.test(path) ||
    GENERATED_FILE.test(path)
  )
    return false;
  const segments = path.split("/");
  if (segments.slice(0, -1).some((segment) => GENERATED_SEGMENTS.has(segment))) return false;
  const name = segments[segments.length - 1] ?? "";
  const dot = name.lastIndexOf(".");
  return dot > 0 && SOURCE_EXTENSIONS.has(name.slice(dot + 1).toLowerCase());
}

/**
 * The source files `git log --name-only` names most often, most often first.
 * Output cut short loses its last line, which may be half a path.
 */
export function rankChangedFiles(
  output: string,
  truncated: boolean,
): Array<{ path: string; commits: number }> {
  const lines = output.split("\n");
  if (truncated) lines.pop();
  const counts = new Map<string, number>();
  for (const line of lines) {
    const path = line.trim();
    if (path !== "" && isHotFileCandidate(path)) counts.set(path, (counts.get(path) ?? 0) + 1);
  }
  return [...counts]
    .filter(([, commits]) => commits >= HOT_FILE_MIN_COMMITS)
    .map(([path, commits]) => ({ path, commits }))
    .toSorted((a, b) => b.commits - a.commits || a.path.localeCompare(b.path));
}

/** The test command a project of another kind is run with, by its marker file. */
export function conventionalTestCommand(entries: ReadonlySet<string>): string | null {
  if (entries.has("Cargo.toml")) return "cargo test";
  if (entries.has("go.mod")) return "go test ./...";
  if (entries.has("pytest.ini") || entries.has("pyproject.toml") || entries.has("tox.ini"))
    return "pytest";
  return null;
}

/** Sums `git grep -c` lines, which end in `:<count>`. */
export function sumGrepCounts(output: string): number {
  let total = 0;
  for (const line of output.split("\n")) {
    const count = Number(line.slice(line.lastIndexOf(":") + 1));
    if (Number.isInteger(count) && count > 0) total += count;
  }
  return total;
}

/** The title in a spec's first heading, without the increment number it often starts with. */
export function specHeadingTitle(spec: string): string {
  const heading = spec.match(/^#[ \t]+(.+)$/m)?.[1] ?? "";
  return heading.replace(/^\d{3,5}[A-Z]?\b[\s:.\u2013\u2014-]*/, "").trim();
}

/**
 * When an increment was handed off and not picked up since, read from its
 * ledger as `specweave handoff list` reads it: the handoff's time, null once a
 * pickup follows it, or undefined when the ledger records neither.
 */
export function pendingHandoffAt(ledger: string): number | null | undefined {
  let last: { kind: string; at: number } | undefined;
  for (const line of ledger.split("\n")) {
    let event: { e?: unknown; at?: unknown } | null;
    try {
      event = JSON.parse(line) as { e?: unknown; at?: unknown } | null;
    } catch {
      continue;
    }
    if (event?.e !== "handoff" && event?.e !== "pickup") continue;
    const at = typeof event.at === "string" ? Date.parse(event.at) : Number.NaN;
    if (!Number.isNaN(at) && (last === undefined || at >= last.at)) last = { kind: event.e, at };
  }
  if (last === undefined) return undefined;
  return last.kind === "handoff" ? last.at : null;
}

/** An open increment's title, from its metadata file, or null when it is closed or unreadable. */
export function openIncrementTitle(metadata: string): string | null {
  try {
    const parsed = JSON.parse(metadata) as { status?: unknown; title?: unknown } | null;
    if (typeof parsed?.status !== "string" || !OPEN_INCREMENT_STATUSES.has(parsed.status))
      return null;
    return typeof parsed.title === "string" ? parsed.title : "";
  } catch {
    return null;
  }
}

const isProjectWorkspaceError = Schema.is(ProjectWorkspaceError);

const make = Effect.gen(function* () {
  const projects = yield* ProjectStore.ProjectStoreV2;
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const runner = yield* ProcessRunner.ProcessRunner;
  const sql = yield* SqlClient.SqlClient;

  /** A file's text when it is there and small enough to be a manifest. */
  const smallFile = (file: string, maximum = MANIFEST_BYTES) =>
    Effect.gen(function* () {
      const info = yield* fs.stat(file);
      if (info.type !== "File" || Number(info.size) > maximum) return null;
      return yield* fs.readFileString(file);
    }).pipe(Effect.orElseSucceed(() => null));

  /** Standard output of a read-only git command, or null when it fails or runs long. */
  const git = (cwd: string, args: readonly string[], maxOutputBytes: number) =>
    runner
      .run({
        command: "git",
        args,
        cwd,
        // Reading must not take the index lock from an agent working in this checkout.
        env: { ...process.env, GIT_TERMINAL_PROMPT: "0", GIT_OPTIONAL_LOCKS: "0" },
        timeout: "5 seconds",
        timeoutBehavior: "timedOutResult",
        maxOutputBytes,
        outputMode: "truncate",
      })
      .pipe(
        Effect.map((output) =>
          output.timedOut || output.stdoutInvalidUtf8 || (output.code !== 0 && output.code !== 1)
            ? null
            : { text: output.stdout, truncated: output.stdoutTruncated, code: output.code },
        ),
        Effect.orElseSucceed(() => null),
      );

  /** The most changed files that are still in the checkout and small enough to read. */
  const presentFiles = (root: string, ranked: ReadonlyArray<{ path: string; commits: number }>) =>
    Effect.forEach(
      ranked.slice(0, HOT_FILE_CANDIDATES),
      (file) =>
        fs.stat(path.join(root, file.path)).pipe(
          Effect.map((info) =>
            info.type === "File" && Number(info.size) <= HOT_FILE_BYTES ? [file] : [],
          ),
          Effect.orElseSucceed(() => []),
        ),
      { concurrency: 8 },
    ).pipe(Effect.map((found) => found.flat().slice(0, HOT_FILES_KEPT)));

  const repositorySignals = (root: string) =>
    Effect.gen(function* () {
      const inside = yield* git(root, ["rev-parse", "--is-inside-work-tree"], 64);
      if (inside?.code !== 0 || inside.text.trim() !== "true")
        return {
          recentCommitSubjects: [],
          uncommittedFiles: 0,
          todoCount: 0,
          todoCountIsFloor: false,
          frequentlyChangedFiles: [],
        };
      const [log, status, todos, changed] = yield* Effect.all(
        [
          git(root, ["log", "-5", "--format=%s"], 4_096),
          git(root, ["status", "--porcelain"], 65_536),
          // -I skips binaries, -w matches whole words, -c prints one count per file.
          git(root, ["grep", "-I", "-c", "-w", "-e", "TODO", "-e", "FIXME"], 262_144),
          // Rename detection is the slow part of a large log and is not needed to count paths.
          git(
            root,
            [
              "log",
              "-n",
              String(HOT_FILE_COMMITS),
              "--no-merges",
              "--no-renames",
              // Paths from the project folder, which may sit below the repository's top.
              "--relative",
              "--name-only",
              "--format=",
              "--",
              ".",
              ":(exclude).specweave",
            ],
            HOT_FILE_LOG_BYTES,
          ),
        ],
        { concurrency: 4 },
      );
      return {
        recentCommitSubjects:
          log?.code === 0 ? log.text.split("\n").filter((line) => line.trim() !== "") : [],
        uncommittedFiles:
          status?.code === 0 ? status.text.split("\n").filter((line) => line !== "").length : 0,
        todoCount: todos ? sumGrepCounts(todos.text) : 0,
        todoCountIsFloor: todos?.truncated === true,
        frequentlyChangedFiles:
          changed?.code === 0
            ? yield* presentFiles(root, rankChangedFiles(changed.text, changed.truncated))
            : [],
      };
    });

  const specweaveSignals = (root: string) =>
    Effect.gen(function* () {
      const home = path.join(root, ".specweave");
      const names = yield* fs
        .readDirectory(path.join(home, "increments"))
        .pipe(Effect.orElseSucceed((): string[] => []));
      // Newest first by number, so `10000-x` comes before `9999-x`.
      const folders = names
        .filter((name) => INCREMENT_DIRECTORY.test(name))
        .toSorted(compareIncrementFoldersNewestFirst)
        .slice(0, INCREMENTS_SCANNED);
      const modifiedAt = (file: string) =>
        fs.stat(file).pipe(
          Effect.map((info) =>
            info.type === "File" ? (Option.getOrNull(info.mtime)?.getTime() ?? null) : null,
          ),
          Effect.orElseSucceed(() => null),
        );
      // Only metadata first: an increment opened long ago is as open as a new one.
      const statuses = yield* Effect.forEach(
        folders,
        (id) =>
          // An active increment's metadata grows with sync events; read it at manifest size.
          smallFile(path.join(home, "increments", id, "metadata.json")).pipe(
            Effect.map((metadata) => ({
              id,
              title: metadata === null ? null : openIncrementTitle(metadata),
            })),
          ),
        { concurrency: INCREMENT_METADATA_CONCURRENCY },
      );
      const newestOpen = statuses
        .filter((entry): entry is { id: string; title: string } => entry.title !== null)
        .slice(0, OPEN_INCREMENTS_READ);
      const open = yield* Effect.forEach(
        newestOpen,
        ({ id, title }) =>
          Effect.gen(function* () {
            const folder = path.join(home, "increments", id);
            // Newer increments keep their title in spec.md's heading, not in metadata.
            const spec = title === "" ? yield* smallFile(path.join(folder, "spec.md")) : null;
            // The ledger says whether a handoff was picked up; a note with no
            // handoff events in its ledger, from an older SpecWeave, goes by its date.
            const ledger = yield* smallFile(path.join(folder, "ledger.jsonl"));
            const pending = ledger === null ? undefined : pendingHandoffAt(ledger);
            return {
              id,
              title: spec === null ? title : specHeadingTitle(spec),
              handedOffAt:
                pending !== undefined
                  ? pending
                  : yield* modifiedAt(path.join(folder, "handoff.md")),
            };
          }),
        { concurrency: 8 },
      );
      // The project-wide notes: index.json, and dated notes such as 2026-10-10-INDEX.md.
      const notes = yield* fs
        .readDirectory(path.join(home, "handoffs"))
        .pipe(Effect.orElseSucceed((): string[] => []));
      const noteTimes = yield* Effect.forEach(
        notes
          .filter((name) => HANDOFF_NOTE.test(name))
          .toSorted((a, b) => b.localeCompare(a))
          .slice(0, HANDOFF_NOTES_READ),
        (name) => modifiedAt(path.join(home, "handoffs", name)),
        { concurrency: 8 },
      );
      const projectHandoffAt = Math.max(-Infinity, ...noteTimes.filter((at) => at !== null));
      const latest = open.reduce<{ id: string; at: number } | null>(
        (best, entry) =>
          entry.handedOffAt !== null && entry.handedOffAt > (best?.at ?? -Infinity)
            ? { id: entry.id, at: entry.handedOffAt }
            : best,
        null,
      );
      const handedOffAt = Math.max(projectHandoffAt, latest?.at ?? -Infinity);
      const now = yield* Clock.currentTimeMillis;
      const hasRecentHandoff = now - handedOffAt < HANDOFF_FRESH_MS;
      return {
        openIncrements: open.map((entry) => ({ id: entry.id, title: entry.title })),
        hasRecentHandoff,
        // A project-wide note newer than any increment's speaks for all of them.
        handoffIncrement:
          hasRecentHandoff && latest !== null && latest.at >= projectHandoffAt ? latest.id : null,
      };
    });

  const read = ({ projectId }: { projectId: ProjectId }) =>
    Effect.gen(function* () {
      const project = yield* projects.get(projectId);
      if (Option.isNone(project))
        return yield* new ProjectWorkspaceError({ projectId, code: "not_found" });
      const settings = project.value.workspaceSettings ?? DEFAULT_PROJECT_WORKSPACE_SETTINGS;
      const root = project.value.workspaceRoot;
      const memory = yield* sql<{
        readonly files: number;
      }>`SELECT COUNT(*) AS files FROM project_memory WHERE project_id = ${projectId}`;
      const names = yield* fs.readDirectory(root).pipe(Effect.orElseSucceed((): string[] => []));
      const entries = new Set(names);
      const hasWorkspace = names.some((name) => !METADATA_ENTRIES.has(name));
      // A personal assistant's folder is its own storage, not a repository to work through.
      const readable = hasWorkspace && settings.kind === "code";
      const manifest =
        readable && entries.has("package.json")
          ? yield* smallFile(path.join(root, "package.json"))
          : null;
      const repository = readable
        ? yield* repositorySignals(root)
        : {
            recentCommitSubjects: [],
            uncommittedFiles: 0,
            todoCount: 0,
            todoCountIsFloor: false,
            frequentlyChangedFiles: [],
          };
      const specweave =
        readable && entries.has(".specweave")
          ? yield* specweaveSignals(root)
          : { openIncrements: [], hasRecentHandoff: false, handoffIncrement: null };
      const checks =
        manifest === null
          ? { lintCommand: null, typecheckCommand: null }
          : packageCheckCommands(manifest, entries);
      const signals: ProjectStarterSignals = {
        kind: settings.kind,
        goal: settings.goal,
        hasWorkspace,
        hasReadme: names.some((name) => README.test(name)),
        testCommand:
          (manifest === null ? null : packageTestCommand(manifest, entries)) ??
          (readable ? conventionalTestCommand(entries) : null),
        ...checks,
        ...repository,
        ...specweave,
        hasMemory: (memory[0]?.files ?? 0) > 0,
      };
      return { suggestions: buildStarterSuggestions(signals), hasWorkspace };
    }).pipe(
      Effect.mapError((error) =>
        isProjectWorkspaceError(error)
          ? error
          : new ProjectWorkspaceError({ projectId, code: "operation_failed" }),
      ),
    );
  return ProjectStarterSuggestionsService.of({ read });
});

export const layer = Layer.effect(ProjectStarterSuggestionsService, make);
