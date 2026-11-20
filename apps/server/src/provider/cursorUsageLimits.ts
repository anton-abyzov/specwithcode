import * as NodeOS from "node:os";
import type { CursorSettings, ServerProviderUsageWindow } from "@specweave-studio/contracts";
import { HostProcessPlatform } from "@specweave-studio/shared/hostProcess";
import {
  CURSOR_LEGACY_USAGE_WINDOWS,
  CURSOR_USAGE_WINDOWS,
} from "@specweave-studio/shared/usageLimits";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Option from "effect/Option";
import * as Path from "effect/Path";
import * as Schema from "effect/Schema";
import { HttpClient, HttpClientRequest, HttpClientResponse } from "effect/http";
import {
  clampPercent,
  makeUnavailableUsageLimits,
  makeUsageLimits,
} from "./providerUsageLimits.ts";
import {
  CursorAccess,
  cursorDesktopStatePath,
  isExpiredCursorToken,
} from "./cursorDesktopToken.ts";

const CursorCredentials = Schema.Struct({ accessToken: Schema.optional(Schema.String) });
const DEFAULT_CURSOR_API_ENDPOINT = "https://api2.cursor.sh";
const decodeCredentials = Schema.decodeEffect(Schema.fromJsonString(CursorCredentials));
const CursorUsageResponse = Schema.Struct({
  billingCycleStart: Schema.optional(Schema.Union([Schema.String, Schema.Number])),
  billingCycleEnd: Schema.optional(Schema.Union([Schema.String, Schema.Number])),
  planUsage: Schema.optional(
    Schema.Struct({
      totalPercentUsed: Schema.optional(Schema.Number),
      autoPercentUsed: Schema.optional(Schema.Number),
      apiPercentUsed: Schema.optional(Schema.Number),
    }),
  ),
});
/** Cursor's own client reads the weekly reset and the X Subscription flag from GetPlanInfo. */
const CursorPlanInfoResponse = Schema.Struct({
  isMerged: Schema.optional(Schema.Boolean),
  planInfo: Schema.optional(
    Schema.Struct({
      planName: Schema.optional(Schema.String),
      includedUsagePeriod: Schema.optional(Schema.Union([Schema.String, Schema.Number])),
      includedUsageResetsAt: Schema.optional(Schema.Union([Schema.String, Schema.Number])),
    }),
  ),
});
export type CursorPlanInfoResponse = typeof CursorPlanInfoResponse.Type;
const CursorEmailResponse = Schema.Struct({ email: Schema.optional(Schema.String) });

/**
 * The account an instance signed in with. Limits read the machine's Cursor CLI
 * login, so they are shown only when that login is the same account.
 */
export interface CursorUsageAccount {
  readonly email: string | undefined;
}

const WEEK_MINUTES = 7 * 24 * 60;

function timestampMillis(value: string | number | undefined): number | undefined {
  const millis = Number(value);
  return Number.isFinite(millis) && millis > 0 ? millis : undefined;
}

function isoTimestamp(millis: number | undefined): string | undefined {
  if (millis === undefined) return undefined;
  const value = DateTime.make(millis);
  return Option.isSome(value) ? DateTime.formatIso(value.value) : undefined;
}

/** Connect JSON sends the enum by name; tolerate the number too. */
function isWeeklyPeriod(period: string | number | undefined): boolean {
  return period === 2 || (typeof period === "string" && /WEEKLY$/i.test(period));
}

/**
 * The renewal date Cursor reports, only for a plan whose period it names as
 * monthly: there "usage resets monthly with your billing cycle", so the
 * cycle's end is when the subscription renews. A weekly plan, a number, an
 * unknown text or no plan information at all (where the reader assumes
 * monthly) reports none.
 */
function monthlyRenewal(
  planInfo: CursorPlanInfoResponse | undefined,
  cycleEnd: number | undefined,
  checkedAt: string,
): string | undefined {
  const period = planInfo?.planInfo?.includedUsagePeriod;
  if (typeof period !== "string" || !/MONTHLY$/i.test(period.trim())) return undefined;
  const readAt = DateTime.make(checkedAt);
  if (cycleEnd === undefined || Option.isNone(readAt)) return undefined;
  if (cycleEnd <= DateTime.toEpochMillis(readAt.value)) return undefined;
  return isoTimestamp(cycleEnd);
}

/** Cursor's dashboard percentages include bonus usage; spend / limit does not. */
export function cursorUsageResponseToLimits(
  response: typeof CursorUsageResponse.Type,
  checkedAt: string,
  planInfo?: CursorPlanInfoResponse,
) {
  const weekly = isWeeklyPeriod(planInfo?.planInfo?.includedUsagePeriod);
  const cycleStart = timestampMillis(response.billingCycleStart);
  const cycleEnd = timestampMillis(response.billingCycleEnd);
  const cycleMinutes =
    cycleStart !== undefined && cycleEnd !== undefined && cycleEnd > cycleStart
      ? Math.round((cycleEnd - cycleStart) / 60_000)
      : undefined;
  // Cursor's client treats the weekly reset date as optional; the period alone sets the window.
  const timing = weekly
    ? {
        kind: "weekly" as const,
        resetsAt: isoTimestamp(timestampMillis(planInfo?.planInfo?.includedUsageResetsAt)),
        windowDurationMins: WEEK_MINUTES,
      }
    : {
        kind: "monthly" as const,
        resetsAt: isoTimestamp(cycleEnd),
        windowDurationMins: cycleMinutes,
      };
  // Cursor's client keeps the split view for enterprise plans even when merged.
  const merged =
    planInfo?.isMerged === true && !/enterprise/iu.test(planInfo.planInfo?.planName ?? "");
  const windows: ServerProviderUsageWindow[] = [];
  const push = (id: string, label: string, usedPercent: number | undefined) => {
    if (usedPercent === undefined || !Number.isFinite(usedPercent)) return;
    windows.push({
      id,
      kind: timing.kind,
      label,
      usedPercent: clampPercent(usedPercent),
      ...(timing.resetsAt ? { resetsAt: timing.resetsAt } : {}),
      ...(timing.windowDurationMins ? { windowDurationMins: timing.windowDurationMins } : {}),
    });
  };
  if (response.planUsage) {
    if (merged) {
      // X Subscription accounts have one included pool; third-party models bill prepaid credit.
      const [pool] = CURSOR_USAGE_WINDOWS;
      push(pool.id, pool.label, response.planUsage.totalPercentUsed);
    } else {
      for (const { id, label } of CURSOR_LEGACY_USAGE_WINDOWS) {
        push(id, label, response.planUsage[id]);
      }
    }
  }
  if (windows.length === 0) return makeUnavailableUsageLimits({ checkedAt, reason: "unsupported" });
  const renewsAt = monthlyRenewal(planInfo, cycleEnd, checkedAt);
  const limits = makeUsageLimits({ checkedAt, windows });
  return renewsAt === undefined ? limits : { ...limits, renewsAt };
}

export interface CursorUsageReadOptions {
  /**
   * The person's opt-in (`cursorKeychainUsageEnabled`). Off means no Cursor
   * sign-in is read and no Cursor endpoint is called, on every OS.
   */
  readonly enabled: boolean;
  readonly account?: CursorUsageAccount | undefined;
}

export const CURSOR_USAGE_OFF_MESSAGE =
  "Turn on Cursor account usage in SpecWithCode to show its plan limits.";

export const readCursorUsageLimits = Effect.fn("readCursorUsageLimits")(function* (
  settings: Pick<CursorSettings, "apiEndpoint">,
  environment: NodeJS.ProcessEnv,
  options: CursorUsageReadOptions,
) {
  const checkedAt = DateTime.formatIso(yield* DateTime.now);
  // Checked before anything reads a token: the endpoints are what Cursor's terms forbid.
  if (!options.enabled) {
    return makeUnavailableUsageLimits({
      checkedAt,
      reason: "unsupported",
      message: CURSOR_USAGE_OFF_MESSAGE,
    });
  }
  const { account } = options;
  return yield* Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const platform = yield* HostProcessPlatform;
    const access = yield* CursorAccess;
    const nowMs = DateTime.toEpochMillis(yield* DateTime.now);
    const endpoint = (
      settings.apiEndpoint?.trim() ||
      environment.CURSOR_API_ENDPOINT?.trim() ||
      DEFAULT_CURSOR_API_ENDPOINT
    ).replace(/\/$/, "");
    const defaultEndpoint = endpoint === DEFAULT_CURSOR_API_ENDPOINT;
    let token = environment.CURSOR_AUTH_TOKEN?.trim();
    // An explicit API key can name a different account from the stored login.
    if (!token && environment.CURSOR_API_KEY?.trim()) {
      return makeUnavailableUsageLimits({ checkedAt, reason: "unsupported" });
    }
    const home =
      (platform === "win32" ? environment.USERPROFILE : environment.HOME) || NodeOS.homedir();
    const credentialStore = environment.AGENT_CLI_CREDENTIAL_STORE;
    let keychainFailure: unknown;
    if (!token && credentialStore !== "memory") {
      if (platform === "darwin" && credentialStore !== "file") {
        if (!defaultEndpoint) {
          return makeUnavailableUsageLimits({
            checkedAt,
            reason: "unsupported",
            message:
              "Cursor account usage requires the default Cursor endpoint when using Keychain.",
          });
        }
        const keychain = yield* Effect.result(Effect.tryPromise(access.keychainToken));
        if (keychain._tag === "Success") token = keychain.success?.trim();
        else keychainFailure = keychain.failure;
      } else {
        const directory =
          platform === "win32"
            ? path.join(environment.APPDATA || path.join(home, "AppData", "Roaming"), "Cursor")
            : platform === "darwin"
              ? path.join(home, ".cursor")
              : path.join(environment.XDG_CONFIG_HOME || path.join(home, ".config"), "cursor");
        const credentials = yield* fs.readFileString(path.join(directory, "auth.json")).pipe(
          Effect.catchTags({
            PlatformError: (error) =>
              error.reason._tag === "NotFound" ? Effect.succeed("{}") : Effect.fail(error),
          }),
          Effect.flatMap(decodeCredentials),
        );
        token = credentials.accessToken?.trim();
      }
      if (token && isExpiredCursorToken(token, nowMs)) token = undefined;
    }
    // The desktop app's sign-in covers a missing or expired CLI login. It goes
    // only to Cursor's own endpoint, and only when it is the instance's account.
    if (!token && defaultEndpoint) {
      const signIn = yield* Effect.sync(() =>
        access.desktopSignIn(cursorDesktopStatePath(platform, environment, home)),
      ).pipe(Effect.orElseSucceed(() => null));
      const expected = account?.email?.trim().toLowerCase();
      if (
        signIn &&
        !isExpiredCursorToken(signIn.accessToken, nowMs) &&
        (expected === undefined || signIn.email === undefined || signIn.email === expected)
      ) {
        token = signIn.accessToken;
      }
    }
    if (!token && keychainFailure !== undefined) return yield* Effect.fail(keychainFailure);
    if (!token) return makeUnavailableUsageLimits({ checkedAt, reason: "unsupported" });
    const client = yield* HttpClient.HttpClient;
    const serviceRequest = (service: string, method: string) =>
      HttpClientRequest.post(`${endpoint}/aiserver.v1.${service}/${method}`).pipe(
        HttpClientRequest.bearerToken(token),
        HttpClientRequest.setHeaders({
          "connect-protocol-version": "1",
          "x-cursor-client-type": "cli",
        }),
        HttpClientRequest.bodyJsonUnsafe({}),
      );
    const dashboardRequest = (method: string) => serviceRequest("DashboardService", method);
    if (account !== undefined) {
      const expected = account.email?.trim().toLowerCase();
      const loginEmail = expected
        ? yield* client.execute(serviceRequest("AuthService", "GetEmail")).pipe(
            Effect.flatMap(HttpClientResponse.filterStatusOk),
            Effect.flatMap(HttpClientResponse.schemaBodyJson(CursorEmailResponse)),
            Effect.map((response) => response.email?.trim().toLowerCase()),
            Effect.timeout("4 seconds"),
            Effect.orElseSucceed(() => undefined),
          )
        : undefined;
      if (!expected || loginEmail !== expected) {
        return makeUnavailableUsageLimits({
          checkedAt,
          reason: "unsupported",
          message: !expected
            ? "Cursor did not report this sign-in's account, so its usage cannot be matched to this machine's Cursor sign-in. Sign in again."
            : loginEmail === undefined
              ? "Could not confirm which Cursor account this machine's Cursor sign-in uses. Run `agent login` again if it has expired."
              : "Cursor usage reads this machine's Cursor sign-in, which is not the account this instance signed in with.",
        });
      }
    }
    const [body, planInfo] = yield* Effect.all(
      [
        client
          .execute(dashboardRequest("GetCurrentPeriodUsage"))
          .pipe(
            Effect.flatMap(HttpClientResponse.filterStatusOk),
            Effect.flatMap(HttpClientResponse.schemaBodyJson(CursorUsageResponse)),
          ),
        // Plan details only refine the windows; without them the legacy monthly view stays.
        client.execute(dashboardRequest("GetPlanInfo")).pipe(
          Effect.flatMap(HttpClientResponse.filterStatusOk),
          Effect.flatMap(HttpClientResponse.schemaBodyJson(CursorPlanInfoResponse)),
          Effect.timeout("4 seconds"),
          Effect.orElseSucceed(() => undefined),
        ),
      ],
      { concurrency: 2 },
    );
    return cursorUsageResponseToLimits(body, checkedAt, planInfo);
  }).pipe(
    Effect.timeout("10 seconds"),
    Effect.orElseSucceed(() =>
      makeUnavailableUsageLimits({
        checkedAt,
        reason: "probeFailed",
        message: "Cursor could not read usage limits.",
      }),
    ),
  );
});
