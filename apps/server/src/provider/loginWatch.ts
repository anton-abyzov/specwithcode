/**
 * Notices a CLI login switching accounts outside Studio (`claude /login`,
 * `codex login` or `muse login` in a terminal) so the provider re-reads its usage straight
 * away instead of showing the previous account's meter until the next probe.
 *
 * Watches the directory that holds the login file, because CLIs replace the
 * file rather than edit it in place. Each change re-reads the file and only a
 * different account identity triggers `onChange`; the CLIs also rewrite these
 * files for token refreshes and session bookkeeping.
 *
 * @module provider/loginWatch
 */
import * as NodeOS from "node:os";

import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Option from "effect/Option";
import * as Path from "effect/Path";
import type * as Scope from "effect/Scope";
import * as Stream from "effect/Stream";

function parseObject(text: string): Record<string, unknown> | undefined {
  try {
    const value: unknown = JSON.parse(text);
    return typeof value === "object" && value !== null && !Array.isArray(value)
      ? (value as Record<string, unknown>)
      : undefined;
  } catch {
    return undefined;
  }
}

function field(value: unknown, key: string): unknown {
  return typeof value === "object" && value !== null
    ? (value as Record<string, unknown>)[key]
    : undefined;
}

function text(value: unknown): string | null {
  return typeof value === "string" && value.length > 0 ? value : null;
}

/** The CLI keeps the account record beside its settings, or in the home directory by default. */
export const claudeAccountConfigPath = (configDir: string | undefined) =>
  Effect.map(Path.Path, (path) =>
    configDir ? path.join(configDir, ".claude.json") : path.join(NodeOS.homedir(), ".claude.json"),
  );

/** The signed-in Claude account recorded in `.claude.json` (`oauthAccount`). */
export function claudeLoginIdentity(contents: string): string | undefined {
  const parsed = parseObject(contents);
  if (!parsed) return undefined;
  const account = parsed.oauthAccount;
  return JSON.stringify([
    text(field(account, "accountUuid")),
    text(field(account, "organizationUuid")),
    text(field(account, "emailAddress"))?.toLowerCase() ?? null,
  ]);
}

function jwtEmail(token: unknown): string | null {
  const payload = typeof token === "string" ? token.split(".")[1] : undefined;
  if (!payload) return null;
  try {
    const claims = parseObject(Buffer.from(payload, "base64url").toString("utf8"));
    return text(claims?.email)?.toLowerCase() ?? null;
  } catch {
    return null;
  }
}

/**
 * The signed-in Codex account recorded in `auth.json`. Tokens rotate on every
 * refresh, so only the mode, workspace, email and whether a key is set count.
 */
export function codexLoginIdentity(contents: string): string | undefined {
  const parsed = parseObject(contents);
  if (!parsed) return undefined;
  const tokens = parsed.tokens;
  return JSON.stringify([
    text(parsed.auth_mode),
    text(parsed.OPENAI_API_KEY) !== null,
    text(field(tokens, "account_id")),
    jwtEmail(field(tokens, "id_token")),
  ]);
}

/**
 * Muse Code keeps its account beside its settings: `$XDG_CONFIG_HOME/muse`,
 * or `~/.config/muse` by default.
 */
export const museAccountConfigPath = (environment: NodeJS.ProcessEnv) =>
  Effect.map(Path.Path, (path) =>
    path.join(
      environment.XDG_CONFIG_HOME?.trim() || path.join(NodeOS.homedir(), ".config"),
      "muse",
      "auth.json",
    ),
  );

/** The signed-in Muse Code account recorded in `auth.json` (`providers.meta`). */
export function museLoginIdentity(contents: string): string | undefined {
  const parsed = parseObject(contents);
  if (!parsed) return undefined;
  const meta = field(parsed.providers, "meta");
  return JSON.stringify([
    text(field(meta, "mechanism")),
    text(field(meta, "user_email"))?.toLowerCase() ?? null,
    field(meta, "subs_active") === true,
  ]);
}

/** A 53-bit hash of a text (cyrb53): enough to tell two versions of one small file apart. */
function textHash(value: string): string {
  let high = 0xdeadbeef;
  let low = 0x41c6ce57;
  for (let index = 0; index < value.length; index += 1) {
    const code = value.charCodeAt(index);
    high = Math.imul(high ^ code, 2654435761);
    low = Math.imul(low ^ code, 1597334677);
  }
  high = Math.imul(high ^ (high >>> 16), 2246822507) ^ Math.imul(low ^ (low >>> 13), 3266489909);
  low = Math.imul(low ^ (low >>> 16), 2246822507) ^ Math.imul(high ^ (high >>> 13), 3266489909);
  return (4294967296 * (2097151 & low) + (high >>> 0)).toString(16);
}

/**
 * A mark of the whole login file. Unlike an identity it also changes when the
 * same account signs in again, which is what an expired sign-in needs. It is a
 * short hash and a length: nothing in the file can be read back from it. Never
 * fails: a missing or unreadable file is its own mark. Only a regular file of
 * a login file's size is read; anything else is marked by its size alone.
 */
export const loginFileMark = (
  filePath: string,
): Effect.Effect<string, never, FileSystem.FileSystem> =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const info = yield* fs.stat(filePath);
    if (info.type !== "File") return "none";
    const size = Number(info.size);
    if (size > LOGIN_FILE_MARK_MAX_BYTES) return `${size}:unread`;
    const contents = yield* fs.readFileString(filePath);
    return `${contents.length}:${textHash(contents)}`;
  }).pipe(Effect.orElseSucceed(() => "none"));

/** Login files are a few kilobytes; a larger file at that path is not read. */
const LOGIN_FILE_MARK_MAX_BYTES = 1_048_576;

/**
 * The account recorded in a login file, by `readIdentity`. Never fails: a
 * missing or unreadable file is undefined, which counts as signed out.
 */
export const readLoginIdentity = (
  filePath: string,
  readIdentity: (contents: string) => string | undefined,
): Effect.Effect<string | undefined, never, FileSystem.FileSystem> =>
  Effect.flatMap(FileSystem.FileSystem, (fs) =>
    fs.readFileString(filePath).pipe(
      Effect.map(readIdentity),
      Effect.orElseSucceed(() => undefined),
    ),
  );

/**
 * Where Claude Code keeps Anthropic profiles (a Claude Console sign-in):
 * `ANTHROPIC_CONFIG_DIR`, else `$XDG_CONFIG_HOME/anthropic`, else
 * `~/.config/anthropic`. A profile there outranks the claude.ai login in every
 * Claude config folder, so signing in or out of one switches the account
 * without touching `.claude.json`.
 */
export const anthropicProfileDirectory = (environment: NodeJS.ProcessEnv) =>
  Effect.map(Path.Path, (path) => {
    const explicit = environment.ANTHROPIC_CONFIG_DIR?.trim();
    if (explicit) return path.resolve(explicit);
    const configHome =
      environment.XDG_CONFIG_HOME?.trim() ||
      path.join(environment.HOME?.trim() || NodeOS.homedir(), ".config");
    return path.join(configHome, "anthropic");
  });

/** Profile folders are small; a folder with more entries than this is not walked further. */
const PROFILE_MARK_MAX_ENTRIES = 200;

/**
 * A mark of the Anthropic profile folder: the names, sizes and modified times
 * of what is in it and one level below. It never reads a file, so no token or
 * address can be read back from it. It changes when a profile is signed in,
 * out or switched (and on a token refresh, which is harmless). Never fails: a
 * missing folder is its own mark.
 */
export const anthropicProfileMark = (
  directory: string,
): Effect.Effect<string, never, FileSystem.FileSystem | Path.Path> =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const entries: Array<string> = [];
    const walk = (folder: string, prefix: string, depth: number): Effect.Effect<void> =>
      Effect.gen(function* () {
        const names = yield* fs
          .readDirectory(folder)
          .pipe(Effect.orElseSucceed((): ReadonlyArray<string> => []));
        for (const name of [...names].sort()) {
          if (entries.length >= PROFILE_MARK_MAX_ENTRIES) return;
          const full = path.join(folder, name);
          const info = yield* fs.stat(full).pipe(Effect.option);
          if (Option.isNone(info)) continue;
          const modified = Option.match(info.value.mtime, {
            onNone: () => 0,
            onSome: (date) => date.getTime(),
          });
          entries.push(
            `${prefix}${name}:${info.value.type}:${Number(info.value.size)}:${modified}`,
          );
          if (info.value.type === "Directory" && depth > 0) {
            yield* walk(full, `${prefix}${name}/`, depth - 1);
          }
        }
      });
    const root = yield* fs.stat(directory).pipe(Effect.option);
    if (Option.isNone(root) || root.value.type !== "Directory") return "none";
    yield* walk(directory, "", 1);
    return `${entries.length}:${textHash(entries.join("\n"))}`;
  });

/** How many missing parent folders a watch climbs to wait for its folder to appear. */
const WATCH_PARENT_LEVELS = 3;
/** The pause before a watch that ended (its folder was removed) is set up again. */
const WATCH_REARM_DELAY: Duration.Input = "1 second";

/**
 * Changes in `directory` (to the entry named `fileName` only, when given). A
 * folder that does not exist yet is waited for from the nearest parent that
 * does, and its appearing counts as a change: a first Console sign-in creates
 * the Anthropic profile folder. A watch that ends is set up again. Never fails.
 */
const folderChanges = (
  fs: FileSystem.FileSystem,
  path: Path.Path,
  directory: string,
  fileName: string | undefined,
  levels: number,
): Stream.Stream<void> =>
  Stream.unwrap(
    Effect.gen(function* () {
      const exists = yield* fs.exists(directory).pipe(Effect.orElseSucceed(() => false));
      if (exists) {
        // A watch that ends (its folder went away) is set up again; one that
        // fails (no watches left on this system) stays off, as before.
        return fs.watch(directory).pipe(
          Stream.filter(
            (event) => fileName === undefined || path.basename(event.path) === fileName,
          ),
          Stream.as(undefined),
          Stream.concat(
            Stream.fromEffect(Effect.sleep(WATCH_REARM_DELAY)).pipe(
              Stream.flatMap(() =>
                Stream.concat(
                  Stream.succeed(undefined),
                  folderChanges(fs, path, directory, fileName, levels),
                ),
              ),
            ),
          ),
          Stream.catchCause((cause) =>
            Stream.fromEffect(Effect.logDebug("login watch stopped", { directory, cause })).pipe(
              Stream.drain,
            ),
          ),
        );
      }
      const parent = path.dirname(directory);
      if (levels <= 0 || parent === directory) return Stream.empty;
      return folderChanges(fs, path, parent, path.basename(directory), levels - 1).pipe(
        Stream.filterEffect(() => fs.exists(directory).pipe(Effect.orElseSucceed(() => false))),
        Stream.take(1),
        Stream.flatMap(() =>
          Stream.concat(
            Stream.succeed(undefined),
            folderChanges(fs, path, directory, fileName, levels),
          ),
        ),
      );
    }),
  );

/**
 * Runs `onChange` whenever `readMark` answers differently from before, after
 * something changes in one of the watched directories (to the file named
 * `fileName` only, when given). A directory that does not exist yet is
 * watched for from its parent. Never fails: a directory that cannot be
 * watched leaves the periodic probe and the account-keyed probe cache in charge.
 */
export const watchMarkChanges = (input: {
  readonly watches: ReadonlyArray<{ readonly directory: string; readonly fileName?: string }>;
  readonly readMark: Effect.Effect<string | undefined>;
  readonly onChange: Effect.Effect<void>;
  readonly debounce?: Duration.Input;
}): Effect.Effect<void, never, FileSystem.FileSystem | Path.Path | Scope.Scope> =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    let last = yield* input.readMark;
    const check = Effect.gen(function* () {
      const next = yield* input.readMark;
      if (next === last) return;
      last = next;
      yield* input.onChange;
    });
    const changes = Stream.mergeAll(
      input.watches.map(({ directory, fileName }) =>
        folderChanges(fs, path, directory, fileName, WATCH_PARENT_LEVELS),
      ),
      { concurrency: "unbounded" },
    );
    yield* changes.pipe(
      Stream.debounce(Duration.fromInputUnsafe(input.debounce ?? "500 millis")),
      Stream.runForEach(() => check),
      Effect.ignoreCause({ log: true }),
      Effect.forkScoped,
    );
  });

/**
 * Runs `onChange` whenever the account in `filePath` differs from the one
 * seen before. A missing or unreadable file counts as signed out. Never fails:
 * a directory that cannot be watched leaves the periodic probe in charge.
 */
export const watchLoginChanges = (input: {
  readonly filePath: string;
  readonly readIdentity: (contents: string) => string | undefined;
  readonly onChange: Effect.Effect<void>;
  readonly debounce?: Duration.Input;
}): Effect.Effect<void, never, FileSystem.FileSystem | Path.Path | Scope.Scope> =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    yield* watchMarkChanges({
      watches: [
        { directory: path.dirname(input.filePath), fileName: path.basename(input.filePath) },
      ],
      readMark: readLoginIdentity(input.filePath, input.readIdentity).pipe(
        Effect.provideService(FileSystem.FileSystem, fs),
      ),
      onChange: input.onChange,
      ...(input.debounce === undefined ? {} : { debounce: input.debounce }),
    });
  });
