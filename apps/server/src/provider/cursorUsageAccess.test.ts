// node:sqlite builds a fixture of the Cursor desktop app's state database in a temp home.
// @effect-diagnostics nodeBuiltinImport:off
import * as NodeCrypto from "node:crypto";
import * as NodeFS from "node:fs";
import * as NodeFSP from "node:fs/promises";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";
import * as NodeSqlite from "node:sqlite";

import { NodeServices } from "@effect/platform-node";
import { afterEach, beforeEach, describe, expect, it } from "@effect/vitest";
import { HostProcessPlatform } from "@specweave-studio/shared/hostProcess";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import { HttpClient, HttpClientResponse } from "effect/http";

import {
  CursorAccess,
  type CursorAccessShape,
  cursorDesktopStatePath,
  isExpiredCursorToken,
  readCursorDesktopSignIn,
} from "./cursorDesktopToken.ts";
import { CURSOR_USAGE_OFF_MESSAGE, readCursorUsageLimits } from "./cursorUsageLimits.ts";
import { readCursorAccountUsage } from "../usage/cursorUsageReader.ts";

const PLATFORMS = ["darwin", "win32", "linux"] as const;
const NOW_MS = Date.parse("2026-11-18T12:00:00Z");

function jwt(claims: Record<string, unknown>): string {
  const part = (value: unknown) => Buffer.from(JSON.stringify(value)).toString("base64url");
  return `${part({ alg: "none" })}.${part(claims)}.signature`;
}
// Far from today either way, since the limits reader checks expiry against the real clock.
const LIVE_EXP = Date.parse("2100-01-01T00:00:00Z") / 1000;
const EXPIRED_EXP = Date.parse("2001-01-01T00:00:00Z") / 1000;
const DESKTOP_TOKEN = jwt({ sub: "auth0|user_desktop", exp: LIVE_EXP });
const CLI_TOKEN = jwt({ sub: "auth0|user_cli", exp: LIVE_EXP });
const EXPIRED_CLI_TOKEN = jwt({ sub: "auth0|user_cli", exp: EXPIRED_EXP });

let home: string;
beforeEach(async () => {
  home = await NodeFSP.mkdtemp(NodePath.join(NodeOS.tmpdir(), "cursor-usage-access-"));
});
afterEach(async () => {
  await NodeFSP.rm(home, { recursive: true, force: true });
});

/** Environment that points every Cursor location at the private temp home. */
const environmentFor = (extra: NodeJS.ProcessEnv = {}): NodeJS.ProcessEnv => ({
  HOME: home,
  USERPROFILE: home,
  APPDATA: NodePath.join(home, "AppData", "Roaming"),
  XDG_CONFIG_HOME: NodePath.join(home, ".config"),
  ...extra,
});

const cliAuthPath = (platform: NodeJS.Platform) =>
  platform === "win32"
    ? NodePath.join(home, "AppData", "Roaming", "Cursor", "auth.json")
    : platform === "darwin"
      ? NodePath.join(home, ".cursor", "auth.json")
      : NodePath.join(home, ".config", "cursor", "auth.json");

async function writeCliLogin(platform: NodeJS.Platform, accessToken: string) {
  const file = cliAuthPath(platform);
  await NodeFSP.mkdir(NodePath.dirname(file), { recursive: true });
  await NodeFSP.writeFile(file, JSON.stringify({ accessToken, refreshToken: "cli-refresh" }));
}

/** The desktop app's `ItemTable`, with the refresh token the reader must never return. */
function writeDesktopState(
  platform: NodeJS.Platform,
  rows: Record<string, string> = {
    "cursorAuth/accessToken": DESKTOP_TOKEN,
    "cursorAuth/refreshToken": "desktop-refresh",
    "cursorAuth/cachedEmail": "Alice@Example.com",
  },
): string {
  const file = cursorDesktopStatePath(platform, environmentFor(), home);
  NodeFS.mkdirSync(NodePath.dirname(file), { recursive: true });
  const db = new NodeSqlite.DatabaseSync(file);
  try {
    db.exec("CREATE TABLE ItemTable (key TEXT UNIQUE ON CONFLICT REPLACE, value BLOB)");
    const insert = db.prepare("INSERT INTO ItemTable VALUES (?, ?)");
    for (const [key, value] of Object.entries(rows)) insert.run(key, value);
  } finally {
    db.close();
  }
  return file;
}

const digest = (file: string) =>
  NodeCrypto.createHash("sha256").update(NodeFS.readFileSync(file)).digest("hex");

interface Calls {
  keychain: number;
  desktop: string[];
  fetch: string[];
}
function recordingAccess(calls: Calls, keychain: string | null = null): CursorAccessShape {
  return {
    keychainToken: async () => {
      calls.keychain++;
      return keychain;
    },
    desktopSignIn: (statePath) => {
      calls.desktop.push(statePath);
      return readCursorDesktopSignIn(statePath);
    },
    fetch: async (url) => {
      calls.fetch.push(url);
      return new Response("unauthorized", { status: 401 });
    },
  };
}

function usageClient(requests: Array<{ url: string; authorization: string | undefined }>) {
  return HttpClient.make((request) => {
    requests.push({ url: request.url, authorization: request.headers.authorization });
    const body = request.url.endsWith("/GetEmail")
      ? Response.json({ email: "alice@example.com" })
      : request.url.endsWith("/GetPlanInfo")
        ? Response.json({})
        : Response.json({ planUsage: { totalPercentUsed: 33 } });
    return Effect.succeed(HttpClientResponse.fromWeb(request, body));
  });
}

describe("Cursor account usage switch", () => {
  it.effect("reads no Cursor sign-in and calls no Cursor endpoint while it is off", () =>
    Effect.gen(function* () {
      for (const platform of PLATFORMS) {
        yield* Effect.promise(() => writeCliLogin(platform, CLI_TOKEN));
        writeDesktopState(platform);
        const calls: Calls = { keychain: 0, desktop: [], fetch: [] };
        let fileReads = 0;
        const limits = yield* readCursorUsageLimits(
          { apiEndpoint: "" },
          environmentFor({ CURSOR_AUTH_TOKEN: "environment-token" }),
          { enabled: false, account: { email: "alice@example.com" } },
        ).pipe(
          Effect.provideService(HostProcessPlatform, platform),
          Effect.provideService(CursorAccess, recordingAccess(calls, CLI_TOKEN)),
          Effect.provideService(
            FileSystem.FileSystem,
            FileSystem.makeNoop({
              readFileString: () => {
                fileReads++;
                return Effect.die("must not read a Cursor credential file");
              },
            }),
          ),
          Effect.provideService(
            HttpClient.HttpClient,
            HttpClient.make(() => Effect.die("must not call Cursor")),
          ),
          Effect.provide(NodeServices.layer),
        );
        expect(limits.unavailable).toEqual({
          reason: "unsupported",
          message: CURSOR_USAGE_OFF_MESSAGE,
        });
        expect({ platform, ...calls, fileReads }).toEqual({
          platform,
          keychain: 0,
          desktop: [],
          fetch: [],
          fileReads: 0,
        });
      }
    }),
  );

  it.effect("reads the CLI auth file on Windows and Linux once it is on", () =>
    Effect.gen(function* () {
      for (const platform of ["win32", "linux"] as const) {
        yield* Effect.promise(() => writeCliLogin(platform, CLI_TOKEN));
        const calls: Calls = { keychain: 0, desktop: [], fetch: [] };
        const requests: Array<{ url: string; authorization: string | undefined }> = [];
        const limits = yield* readCursorUsageLimits({ apiEndpoint: "" }, environmentFor(), {
          enabled: true,
          account: { email: "alice@example.com" },
        }).pipe(
          Effect.provideService(HostProcessPlatform, platform),
          Effect.provideService(CursorAccess, recordingAccess(calls)),
          Effect.provideService(HttpClient.HttpClient, usageClient(requests)),
          Effect.provide(NodeServices.layer),
        );
        expect(limits.windows[0]?.usedPercent).toBe(33);
        expect(requests.every((request) => request.authorization === `Bearer ${CLI_TOKEN}`)).toBe(
          true,
        );
        expect(calls.keychain).toBe(0);
        expect(calls.desktop).toEqual([]);
      }
    }),
  );

  // Live clock: expiry is checked against now, and the test clock starts at 1970.
  it.live(
    "falls back to the desktop app's state.vscdb when the CLI login is missing or expired",
    () =>
      Effect.gen(function* () {
        for (const platform of PLATFORMS) {
          // win32: an expired CLI login; darwin: an empty Keychain; linux: no CLI login.
          if (platform === "win32") {
            yield* Effect.promise(() => writeCliLogin(platform, EXPIRED_CLI_TOKEN));
          }
          const statePath = writeDesktopState(platform);
          const before = digest(statePath);
          const calls: Calls = { keychain: 0, desktop: [], fetch: [] };
          const requests: Array<{ url: string; authorization: string | undefined }> = [];
          const limits = yield* readCursorUsageLimits({ apiEndpoint: "" }, environmentFor(), {
            enabled: true,
            account: { email: "alice@example.com" },
          }).pipe(
            Effect.provideService(HostProcessPlatform, platform),
            Effect.provideService(CursorAccess, recordingAccess(calls)),
            Effect.provideService(HttpClient.HttpClient, usageClient(requests)),
            Effect.provide(NodeServices.layer),
          );
          expect(limits.windows[0]?.usedPercent).toBe(33);
          expect(calls.desktop).toEqual([statePath]);
          expect(statePath.startsWith(home)).toBe(true);
          expect(calls.keychain).toBe(platform === "darwin" ? 1 : 0);
          expect(
            requests.every((request) => request.authorization === `Bearer ${DESKTOP_TOKEN}`),
          ).toBe(true);
          expect(digest(statePath)).toBe(before);
          yield* Effect.promise(() => NodeFSP.rm(home, { recursive: true, force: true }));
          yield* Effect.promise(() => NodeFSP.mkdir(home, { recursive: true }));
        }
      }),
  );

  it.effect(
    "keeps the desktop sign-in away from another account and from a custom endpoint",
    () =>
      Effect.gen(function* () {
        writeDesktopState("linux");
        for (const [apiEndpoint, email] of [
          ["", "bob@example.com"],
          ["https://cursor-proxy.example", "alice@example.com"],
        ] as const) {
          const calls: Calls = { keychain: 0, desktop: [], fetch: [] };
          const limits = yield* readCursorUsageLimits({ apiEndpoint }, environmentFor(), {
            enabled: true,
            account: { email },
          }).pipe(
            Effect.provideService(HostProcessPlatform, "linux"),
            Effect.provideService(CursorAccess, recordingAccess(calls)),
            Effect.provideService(
              HttpClient.HttpClient,
              HttpClient.make(() => Effect.die("must not send the desktop sign-in")),
            ),
            Effect.provide(NodeServices.layer),
          );
          expect(limits.unavailable?.reason).toBe("unsupported");
          expect(calls.desktop.length).toBe(apiEndpoint ? 0 : 1);
        }
      }),
  );

  it("reads only the access token and email from state.vscdb, never writing it", () => {
    const statePath = writeDesktopState("linux");
    const before = digest(statePath);
    expect(readCursorDesktopSignIn(statePath)).toEqual({
      accessToken: DESKTOP_TOKEN,
      email: "alice@example.com",
    });
    expect(digest(statePath)).toBe(before);
    expect(NodeFS.existsSync(`${statePath}-journal`)).toBe(false);
    expect(readCursorDesktopSignIn(NodePath.join(home, "missing.vscdb"))).toBeNull();
    const other = NodePath.join(home, "other.vscdb");
    const db = new NodeSqlite.DatabaseSync(other);
    db.exec("CREATE TABLE cursorDiskKV (key TEXT, value TEXT)");
    db.close();
    expect(readCursorDesktopSignIn(other)).toBeNull();
  });

  it("calls a JWT stale only after its exp", () => {
    expect(isExpiredCursorToken(EXPIRED_CLI_TOKEN, NOW_MS)).toBe(true);
    expect(isExpiredCursorToken(CLI_TOKEN, NOW_MS)).toBe(false);
    expect(isExpiredCursorToken("opaque-token", NOW_MS)).toBe(false);
  });

  it("history uses the desktop sign-in when the CLI login file is missing", async () => {
    const statePath = writeDesktopState("linux");
    const calls: Calls = { keychain: 0, desktop: [], fetch: [] };
    const cookies: string[] = [];
    const recording = recordingAccess(calls);
    const result = await readCursorAccountUsage(cliAuthPath("linux"), 0, NOW_MS, {
      request: async (url, init) => {
        cookies.push(String((init.headers as Record<string, string>).Cookie));
        return recording.fetch(url, init);
      },
      keychainToken: recording.keychainToken,
      desktop: { statePath, read: recording.desktopSignIn },
      nowMs: NOW_MS,
    });
    expect(result.error).toBe("Sign in to Cursor again to read account usage.");
    expect(calls.fetch).toEqual(["https://cursor.com/api/dashboard/get-filtered-usage-events"]);
    expect(cookies).toEqual([
      `WorkosCursorSessionToken=${encodeURIComponent(`user_desktop::${DESKTOP_TOKEN}`)}`,
    ]);
  });
});
