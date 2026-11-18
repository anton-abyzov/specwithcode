/**
 * SkillSearch — one search over three places on this machine: the skills
 * its agents load, the skills its connected repos offer and are not installed
 * yet, and the notes in its Obsidian vault.
 *
 * Searching only reads. It installs nothing and starts no program.
 *
 * The vault is found from Obsidian's own list of vaults, never from a fixed
 * folder: the one Obsidian has open, else the one opened last. Notes are read
 * only, markdown only, and bounded: folders that start with a dot (`.trash`,
 * `.obsidian`) are skipped, and the walk, the files read and the time spent
 * all have limits. When a limit ends the search early, the answer says the
 * notes are partial. The vault's location stays on the machine; a result
 * carries the path inside the vault.
 *
 * @module project/SkillSearch
 */
import type {
  ProjectId,
  ProjectSkillRepo,
  ProjectSkillRow,
  ProjectSkillSearchAvailable,
  ProjectSkillSearchInstalled,
  ProjectSkillSearchNote,
  ProjectSkillsActionError,
  ProjectSkillsSearchInput,
  ProjectSkillsSearchResult,
  ProjectSkillsSnapshot,
  ThreadId,
} from "@specweave-studio/contracts";
import * as Clock from "effect/Clock";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Option from "effect/Option";
import * as Path from "effect/Path";
import * as Schema from "effect/Schema";

const MAX_GROUP_RESULTS = 40;
const VAULT_TTL_MS = 60_000;
const INDEX_TTL_MS = 120_000;
const MAX_CONFIG_BYTES = 1024 * 1024;

export interface SkillNotesLimits {
  /** Markdown files the walk lists before it stops. */
  readonly maxFiles: number;
  readonly maxDepth: number;
  readonly maxResults: number;
  /** Files whose text is read for one query. */
  readonly maxContentFiles: number;
  readonly maxFileBytes: number;
  /** Every name the walk looks at (folders, notes and other files) before it stops. */
  readonly maxEntries: number;
  /** One deadline for the walk and the reads of one query. */
  readonly budgetMs: number;
}

const DEFAULT_LIMITS: SkillNotesLimits = {
  maxFiles: 20_000,
  maxDepth: 16,
  maxResults: 12,
  maxContentFiles: 2_000,
  maxFileBytes: 256 * 1024,
  maxEntries: 100_000,
  budgetMs: 1_500,
};
/** Longest one filesystem call may take; a hung network folder stops nothing else. */
const FS_CALL_TIMEOUT = "2 seconds";

export interface SkillSearchDeps {
  readonly home: string;
  readonly platform: NodeJS.Platform;
  /** The server's environment, for `APPDATA` and `XDG_CONFIG_HOME`. */
  readonly environment: NodeJS.ProcessEnv;
  readonly readSnapshot: (input: {
    readonly projectId: ProjectId;
    readonly cwd?: string | undefined;
    readonly threadId?: ThreadId | undefined;
    readonly userLevel?: boolean | undefined;
  }) => Effect.Effect<ProjectSkillsSnapshot, ProjectSkillsActionError>;
  readonly sources: {
    readonly connected: () => Effect.Effect<ReadonlyArray<ProjectSkillRepo>>;
  };
  /** Hands a link to the operating system; false when nothing took it. */
  readonly openUrl: (url: string) => Effect.Effect<boolean>;
  readonly limits?: Partial<SkillNotesLimits> | undefined;
}

const ObsidianConfig = Schema.fromJsonString(
  Schema.Struct({
    vaults: Schema.optionalKey(
      Schema.Record(
        Schema.String,
        Schema.Struct({
          path: Schema.String,
          ts: Schema.optionalKey(Schema.Number),
          open: Schema.optionalKey(Schema.Boolean),
        }),
      ),
    ),
  }),
);
const decodeObsidianConfig = Schema.decodeUnknownOption(ObsidianConfig);

interface NoteFile {
  /** Inside the vault, with `/` between folders. */
  readonly rel: string;
  readonly title: string;
  readonly titleLower: string;
}

interface NoteIndex {
  readonly at: number;
  readonly files: ReadonlyArray<NoteFile>;
  readonly truncated: boolean;
}

const includes = (value: string | undefined | null, query: string) =>
  value !== undefined && value !== null && value.toLowerCase().includes(query);

function matchInstalled(
  rows: ReadonlyArray<ProjectSkillRow>,
  query: string,
): ReadonlyArray<ProjectSkillSearchInstalled> {
  return rows
    .filter(
      (row) =>
        includes(row.name, query) ||
        includes(row.description, query) ||
        row.aliases?.some((alias) => includes(alias, query)) === true,
    )
    .slice(0, MAX_GROUP_RESULTS)
    .map((row) => {
      const onDisk = row.providers.find((presence) => presence.fileVersion)?.fileVersion;
      return {
        name: row.name,
        ...(row.description === undefined ? {} : { description: row.description }),
        version: onDisk ?? row.lock?.version ?? null,
        agents: [...new Set(row.providers.map((presence) => presence.label))],
      };
    });
}

function matchAvailable(
  repos: ReadonlyArray<ProjectSkillRepo>,
  rows: ReadonlyArray<ProjectSkillRow>,
  query: string,
): ReadonlyArray<ProjectSkillSearchAvailable> {
  const installed = new Set(
    rows.flatMap((row) => [row.name, ...(row.aliases ?? [])]).map((name) => name.toLowerCase()),
  );
  return repos
    .filter((repo) => repo.state === "ok")
    .flatMap((repo) =>
      repo.skills
        .filter(
          (skill) =>
            !installed.has(skill.name.toLowerCase()) &&
            (includes(skill.name, query) ||
              includes(skill.description, query) ||
              includes(skill.plugin, query) ||
              includes(repo.repo, query)),
        )
        .map((skill) => ({ repo: repo.repo, visibility: repo.visibility, skill })),
    )
    .toSorted((left, right) => left.skill.name.localeCompare(right.skill.name))
    .slice(0, MAX_GROUP_RESULTS);
}

/** A few words around the first match, on one line. */
function snippetOf(text: string, query: string): string | undefined {
  const index = text.toLowerCase().indexOf(query);
  const start = index === -1 ? 0 : Math.max(0, index - 70);
  const end = index === -1 ? 160 : Math.min(text.length, index + query.length + 90);
  const flat = text.slice(start, end).replace(/\s+/g, " ").trim();
  if (flat === "") return undefined;
  return `${start > 0 ? "…" : ""}${flat}${end < text.length ? "…" : ""}`;
}

export const makeSkillSearch = Effect.fn("SkillSearch.make")(function* (deps: SkillSearchDeps) {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const limits: SkillNotesLimits = { ...DEFAULT_LIMITS, ...deps.limits };
  let vaultCache: { readonly at: number; readonly root: string | null } | null = null;
  const indexes = new Map<string, NoteIndex>();

  const isDirectory = (target: string) =>
    fs.stat(target).pipe(
      Effect.map((info) => info.type === "Directory"),
      Effect.orElseSucceed(() => false),
    );

  const configPaths = (): ReadonlyArray<string> => {
    if (deps.platform === "darwin")
      return [path.join(deps.home, "Library", "Application Support", "obsidian", "obsidian.json")];
    if (deps.platform === "win32")
      return [
        path.join(
          deps.environment.APPDATA ?? path.join(deps.home, "AppData", "Roaming"),
          "obsidian",
          "obsidian.json",
        ),
      ];
    return [
      path.join(
        deps.environment.XDG_CONFIG_HOME ?? path.join(deps.home, ".config"),
        "obsidian",
        "obsidian.json",
      ),
      path.join(
        deps.home,
        ".var",
        "app",
        "md.obsidian.Obsidian",
        "config",
        "obsidian",
        "obsidian.json",
      ),
    ];
  };

  /** The vault Obsidian has open, else the one opened last; null when there is none. */
  const findVault: Effect.Effect<string | null> = Effect.gen(function* () {
    const now = yield* Clock.currentTimeMillis;
    if (vaultCache !== null && now - vaultCache.at < VAULT_TTL_MS) return vaultCache.root;
    const candidates: Array<{ root: string; open: boolean; ts: number }> = [];
    for (const file of configPaths()) {
      const info = yield* fs.stat(file).pipe(Effect.option);
      if (
        Option.isNone(info) ||
        info.value.type !== "File" ||
        info.value.size > BigInt(MAX_CONFIG_BYTES)
      )
        continue;
      const text = yield* fs.readFileString(file).pipe(Effect.option);
      const config = Option.isNone(text) ? Option.none() : decodeObsidianConfig(text.value);
      if (Option.isNone(config)) continue;
      for (const vault of Object.values(config.value.vaults ?? {})) {
        if (!path.isAbsolute(vault.path) || !(yield* isDirectory(vault.path))) continue;
        const root = yield* fs.realPath(vault.path).pipe(Effect.orElseSucceed(() => vault.path));
        candidates.push({ root, open: vault.open === true, ts: vault.ts ?? 0 });
      }
    }
    const chosen = candidates.toSorted(
      (left, right) => Number(right.open) - Number(left.open) || right.ts - left.ts,
    )[0];
    vaultCache = { at: now, root: chosen?.root ?? null };
    return vaultCache.root;
  });

  /** The vault-relative path of a real location, or null when it leaves the vault or is hidden. */
  const insideVault = (root: string, real: string): string | null => {
    if (real === root) return "";
    if (!real.startsWith(`${root}${path.sep}`)) return null;
    const rel = real.slice(root.length + 1);
    return rel.split(path.sep).some((segment) => segment.startsWith(".")) ? null : rel;
  };

  const bounded = <A, E>(effect: Effect.Effect<A, E>, fallback: A): Effect.Effect<A> =>
    effect.pipe(
      Effect.timeout(FS_CALL_TIMEOUT),
      Effect.orElseSucceed(() => fallback),
    );

  /**
   * Every markdown note in the vault, up to the walk's limits. `deadline` is
   * the query's own; a walk it cuts short is kept for a while as partial.
   */
  const indexOf = (root: string, deadline: number): Effect.Effect<NoteIndex> =>
    Effect.gen(function* () {
      const now = yield* Clock.currentTimeMillis;
      const cached = indexes.get(root);
      if (cached !== undefined && now - cached.at < INDEX_TTL_MS) return cached;
      const files: NoteFile[] = [];
      let truncated = false;
      let entries = 0;
      const visited = new Set<string>([root]);
      const queue: Array<{ readonly dir: string; readonly rel: string; readonly depth: number }> = [
        { dir: root, rel: "", depth: 0 },
      ];
      walk: while (queue.length > 0) {
        if ((yield* Clock.currentTimeMillis) > deadline) {
          truncated = true;
          break;
        }
        const current = queue.shift()!;
        const names = yield* bounded(fs.readDirectory(current.dir), [] as string[]);
        for (const name of names.toSorted()) {
          entries += 1;
          if (entries > limits.maxEntries) {
            truncated = true;
            break walk;
          }
          if (name.startsWith(".")) continue;
          const rel = current.rel === "" ? name : `${current.rel}/${name}`;
          if (/\.md$/i.test(name)) {
            if (files.length >= limits.maxFiles) {
              truncated = true;
              break walk;
            }
            const title = name.replace(/\.md$/i, "");
            files.push({ rel, title, titleLower: title.toLowerCase() });
            continue;
          }
          const child = path.join(current.dir, name);
          if (!(yield* bounded(isDirectory(child), false))) continue;
          if (current.depth + 1 > limits.maxDepth) {
            truncated = true;
            continue;
          }
          // A link that leaves the vault, points into a hidden folder or loops is not walked.
          const real = yield* bounded(fs.realPath(child), "");
          if (insideVault(root, real) === null || visited.has(real)) continue;
          visited.add(real);
          queue.push({ dir: real, rel, depth: current.depth + 1 });
        }
      }
      const index = { at: now, files, truncated };
      indexes.set(root, index);
      return index;
    });

  /** A note's text, read from its real location only when that is inside the vault. */
  const readNote = (root: string, rel: string) =>
    Effect.gen(function* () {
      const real = yield* bounded(fs.realPath(path.join(root, ...rel.split("/"))), "");
      const inside = insideVault(root, real);
      if (inside === null || !/\.md$/i.test(inside)) return null;
      const info = yield* bounded(fs.stat(real).pipe(Effect.asSome), Option.none());
      if (
        Option.isNone(info) ||
        info.value.type !== "File" ||
        info.value.size > BigInt(limits.maxFileBytes)
      )
        return null;
      const text = yield* bounded(fs.readFileString(real), null as string | null);
      return text !== null && text.length <= limits.maxFileBytes ? text : null;
    });

  const searchNotes = (
    query: string,
  ): Effect.Effect<Pick<ProjectSkillsSearchResult, "notes" | "notesState">> =>
    Effect.gen(function* () {
      const root = yield* findVault;
      if (root === null) return { notes: [], notesState: "none" as const };
      if (query === "") return { notes: [], notesState: "ok" as const };
      const started = yield* Clock.currentTimeMillis;
      const deadline = started + limits.budgetMs;
      const index = yield* indexOf(root, deadline);
      const vault = path.basename(root);
      const notes: ProjectSkillSearchNote[] = [];
      const titled = index.files
        .filter((file) => file.titleLower.includes(query))
        .toSorted(
          (left, right) =>
            Number(right.titleLower.startsWith(query)) -
              Number(left.titleLower.startsWith(query)) ||
            left.title.length - right.title.length ||
            left.rel.localeCompare(right.rel),
        )
        .slice(0, limits.maxResults);
      for (const file of titled) {
        const late = (yield* Clock.currentTimeMillis) > deadline;
        const text = late ? null : yield* readNote(root, file.rel);
        const snippet = text === null ? undefined : snippetOf(text, query);
        notes.push({
          title: file.title,
          path: file.rel,
          vault,
          ...(snippet === undefined ? {} : { snippet }),
        });
      }
      const seen = new Set(titled.map((file) => file.rel));
      let partial = index.truncated;
      let examined = 0;
      for (const file of index.files) {
        if (notes.length >= limits.maxResults) break;
        if (seen.has(file.rel)) continue;
        if (examined >= limits.maxContentFiles || (yield* Clock.currentTimeMillis) > deadline) {
          partial = true;
          break;
        }
        examined += 1;
        const text = yield* readNote(root, file.rel);
        if (text === null || !text.toLowerCase().includes(query)) continue;
        const snippet = snippetOf(text, query);
        notes.push({
          title: file.title,
          path: file.rel,
          vault,
          ...(snippet === undefined ? {} : { snippet }),
        });
      }
      return { notes, notesState: partial ? ("partial" as const) : ("ok" as const) };
    });

  const openNote = (note: string): Effect.Effect<ProjectSkillsSearchResult> =>
    Effect.gen(function* () {
      const empty = { query: "", installed: [], available: [], notes: [] };
      const root = yield* findVault;
      if (root === null) return { ...empty, notesState: "none" as const, opened: false };
      // Only a note the walk itself listed can be opened, so no path is built from the request.
      const deadline = (yield* Clock.currentTimeMillis) + limits.budgetMs;
      const found = (yield* indexOf(root, deadline)).files.find((file) => file.rel === note);
      if (found === undefined) return { ...empty, notesState: "ok" as const, opened: false };
      const opened = yield* deps.openUrl(
        `obsidian://open?vault=${encodeURIComponent(path.basename(root))}&file=${encodeURIComponent(
          found.rel.replace(/\.md$/i, ""),
        )}`,
      );
      return { ...empty, notesState: "ok" as const, opened };
    });

  const search = (
    input: ProjectSkillsSearchInput,
  ): Effect.Effect<ProjectSkillsSearchResult, ProjectSkillsActionError> =>
    Effect.gen(function* () {
      if (input.operation === "open-note") return yield* openNote(input.note ?? "");
      const typed = (input.query ?? "").trim();
      const query = typed.toLowerCase();
      if (query.length < 2) {
        const vault = yield* findVault;
        return {
          query: typed,
          installed: [],
          available: [],
          notes: [],
          notesState: vault === null ? ("none" as const) : ("ok" as const),
        };
      }
      const [snapshot, repos, notes] = yield* Effect.all(
        [
          deps.readSnapshot({
            projectId: input.projectId,
            ...(input.cwd === undefined ? {} : { cwd: input.cwd }),
            ...(input.threadId === undefined ? {} : { threadId: input.threadId }),
            ...(input.userLevel === true ? { userLevel: true } : {}),
          }),
          deps.sources.connected(),
          searchNotes(query),
        ],
        { concurrency: "unbounded" },
      );
      return {
        query: typed,
        installed: matchInstalled(snapshot.rows, query),
        available: matchAvailable(repos, snapshot.rows, query),
        ...notes,
      };
    });

  return { search };
});

export type SkillSearch = Effect.Success<ReturnType<typeof makeSkillSearch>>;
