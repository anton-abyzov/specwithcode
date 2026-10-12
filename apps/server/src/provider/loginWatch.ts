/**
 * Notices a CLI login switching accounts outside Studio (`claude /login`,
 * `codex login` in a terminal) so the provider re-reads its usage straight
 * away instead of showing the previous account's meter until the next probe.
 *
 * Watches the directory that holds the login file, because CLIs replace the
 * file rather than edit it in place. Each change re-reads the file and only a
 * different account identity triggers `onChange`; the CLIs also rewrite these
 * files for token refreshes and session bookkeeping.
 *
 * @module provider/loginWatch
 */
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
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
    const directory = path.dirname(input.filePath);
    const fileName = path.basename(input.filePath);
    const readIdentity = fs.readFileString(input.filePath).pipe(
      Effect.map(input.readIdentity),
      Effect.orElseSucceed(() => undefined),
    );
    let last = yield* readIdentity;
    yield* fs.watch(directory).pipe(
      Stream.filter((event) => path.basename(event.path) === fileName),
      Stream.debounce(Duration.fromInputUnsafe(input.debounce ?? "500 millis")),
      Stream.runForEach(() =>
        Effect.gen(function* () {
          const next = yield* readIdentity;
          if (next === last) return;
          last = next;
          yield* input.onChange;
        }),
      ),
      Effect.ignoreCause({ log: true }),
      Effect.forkScoped,
    );
  });
