// node:sqlite opens the Cursor desktop app's own state database read-only.
// @effect-diagnostics nodeBuiltinImport:off
import * as NodeFS from "node:fs";
import * as NodePath from "node:path";
import * as NodeSqlite from "node:sqlite";
import * as Context from "effect/Context";

import { liveDatabaseReadOnlyUri } from "../persistence/liveDatabaseSnapshot.ts";
import { readMacCursorAccessToken } from "./cursorKeychainToken.ts";

/** The access token and account the Cursor desktop app keeps for its own sign-in. */
export interface CursorDesktopSignIn {
  readonly accessToken: string;
  readonly email: string | undefined;
}

/**
 * Where the Cursor desktop app keeps `state.vscdb`. It is a VS Code fork, so the
 * folder is `Cursor` under the OS's application data folder.
 */
export function cursorDesktopStatePath(
  platform: NodeJS.Platform,
  environment: NodeJS.ProcessEnv,
  home: string,
): string {
  const configHome = environment.XDG_CONFIG_HOME?.trim();
  const root =
    platform === "darwin"
      ? NodePath.join(home, "Library", "Application Support")
      : platform === "win32"
        ? environment.APPDATA || NodePath.join(home, "AppData", "Roaming")
        : configHome && NodePath.isAbsolute(configHome)
          ? configHome
          : NodePath.join(home, ".config");
  return NodePath.join(root, "Cursor", "User", "globalStorage", "state.vscdb");
}

const ACCESS_TOKEN_KEY = "cursorAuth/accessToken";
const EMAIL_KEY = "cursorAuth/cachedEmail";

function text(value: unknown): string | undefined {
  const raw =
    typeof value === "string"
      ? value
      : value instanceof Uint8Array
        ? Buffer.from(value).toString("utf8")
        : undefined;
  let trimmed = raw?.trim();
  if (trimmed?.startsWith('"')) {
    try {
      const parsed: unknown = JSON.parse(trimmed);
      trimmed = typeof parsed === "string" ? parsed.trim() : undefined;
    } catch {
      return undefined;
    }
  }
  return trimmed || undefined;
}

/**
 * Read the desktop app's access token and account email, nothing else.
 *
 * The file is Cursor's live database, so it is opened with the same flags the
 * app uses for its own live database: `mode=ro` (never writes, checkpoints or
 * deletes `-wal`) and `readonly_shm` (never rebuilds `-shm`). The refresh token
 * is never selected. Any failure means there is no desktop sign-in to use.
 */
export function readCursorDesktopSignIn(statePath: string): CursorDesktopSignIn | null {
  if (!NodeFS.existsSync(statePath)) return null;
  let database: NodeSqlite.DatabaseSync | undefined;
  try {
    database = new NodeSqlite.DatabaseSync(liveDatabaseReadOnlyUri(statePath), {
      readOnly: true,
    });
    database.exec("PRAGMA busy_timeout = 250; PRAGMA query_only = ON;");
    const rows = database
      .prepare("SELECT key, value FROM ItemTable WHERE key IN (?, ?)")
      .all(ACCESS_TOKEN_KEY, EMAIL_KEY);
    const value = (key: string) => text(rows.find((row) => row.key === key)?.value);
    const accessToken = value(ACCESS_TOKEN_KEY);
    return accessToken ? { accessToken, email: value(EMAIL_KEY)?.toLowerCase() } : null;
  } catch {
    return null;
  } finally {
    database?.close();
  }
}

/** True for a JWT whose `exp` has passed; an opaque token is never called stale. */
export function isExpiredCursorToken(token: string, nowMs: number): boolean {
  try {
    const payload: unknown = JSON.parse(
      Buffer.from(token.split(".")[1] ?? "", "base64url").toString("utf8"),
    );
    const exp =
      typeof payload === "object" && payload !== null
        ? (payload as Record<string, unknown>).exp
        : undefined;
    return typeof exp === "number" && Number.isFinite(exp) && exp * 1000 <= nowMs;
  } catch {
    return false;
  }
}

/**
 * The places Cursor usage reads a sign-in from and sends it to. Tests replace
 * all three so they never reach the real Keychain, Cursor's live database or
 * Cursor's servers.
 */
export interface CursorAccessShape {
  readonly keychainToken: () => Promise<string | null>;
  readonly desktopSignIn: (statePath: string) => CursorDesktopSignIn | null;
  readonly fetch: (url: string, init: RequestInit) => Promise<Response>;
}

export const CursorAccess = Context.Reference<CursorAccessShape>(
  "@specweave-studio/server/provider/CursorAccess",
  {
    defaultValue: () => ({
      keychainToken: readMacCursorAccessToken,
      desktopSignIn: readCursorDesktopSignIn,
      fetch: globalThis.fetch,
    }),
  },
);
