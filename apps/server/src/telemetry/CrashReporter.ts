/**
 * Automatic crash and error reports from the server.
 *
 * On by default. Reports are off when any of these say so:
 * - `STUDIO_CRASH_REPORTS=false` (also `0`, `off`, `no`, `disabled`),
 * - the `crashReportsEnabled` server setting (read live, so turning it off
 *   applies to the next report without a restart),
 * - team rules with `telemetry.export: false`.
 * When off, nothing is sent and no file is created or removed.
 *
 * Each report is built with `buildCrashReport` from
 * `@specweave-studio/shared/crashReport`, which keeps product metadata and a
 * sanitized error only: never prompts, responses, file contents, tokens,
 * conversation, thread or project ids, or raw paths. The install id is a
 * random UUID in `<STUDIO_HOME>/crash-install-id`, shared with the desktop app.
 *
 * Delivery is best effort: one POST per report to
 * `<relay>/v1/crash-reports` (`STUDIO_CRASH_REPORT_URL` overrides the origin)
 * with a 5 second timeout, never retried in a loop and never awaited by the
 * caller, startup or shutdown. Repeats of one failure are folded: one send per
 * fingerprint per hour, with the folded count on the next send, and at most
 * 30 sends per hour per process.
 *
 * At startup the service sends the reports a previous run stored when it died
 * (`<stateDir>/crash-reports/pending-*.json`): sent or rejected (4xx) files are
 * deleted, files older than 7 days are deleted unsent, the rest wait.
 *
 * Self-test: `STUDIO_CRASH_REPORT_SELF_TEST=1` sends one report of kind
 * `test` (category `self_test`) at startup when reports are on, to check the
 * path to the relay end to end.
 *
 * @module CrashReporter
 */
import {
  CRASH_REPORT_URL_ENV,
  CRASH_REPORTS_ENV,
  crashReportEndpoint,
  crashReportFingerprint,
  crashReportsEnabledFromEnv,
  encodeCrashReport,
  parseCrashReport,
  type CrashReport,
  type CrashReportKind,
} from "@specweave-studio/shared/crashReport";
import * as Clock from "effect/Clock";
import * as Config from "effect/Config";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as FiberSet from "effect/FiberSet";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Path from "effect/Path";
import * as Schema from "effect/Schema";
import * as HttpClient from "effect/http/HttpClient";
import * as HttpClientRequest from "effect/http/HttpClientRequest";

import * as ServerConfig from "../config.ts";
import { ServerSettingsService } from "../serverSettings.ts";
import { currentTeamRules } from "../teamRules/TeamRules.ts";
import {
  buildServerCrashReport,
  PENDING_CRASH_REPORT_MAX_AGE_MS,
  PENDING_CRASH_REPORT_PATTERN,
  pendingCrashReportsDir,
  readOrCreateCrashInstallId,
} from "./crashReportFiles.ts";

export const CRASH_REPORT_SELF_TEST_ENV = "STUDIO_CRASH_REPORT_SELF_TEST";
export const CRASH_REPORT_SEND_TIMEOUT = "5 seconds";
export const CRASH_REPORT_FOLD_WINDOW_MS = 60 * 60 * 1000;
export const CRASH_REPORT_MAX_SENDS_PER_WINDOW = 30;
const MAX_FOLD_ENTRIES = 500;
const decodeJson = Schema.decodeUnknownOption(Schema.fromJsonString(Schema.Unknown));
const SETTINGS_READY_TIMEOUT = "2 minutes";

export interface CrashReportEvent {
  readonly kind: CrashReportKind;
  readonly category?: string | null;
  readonly provider?: string | null;
  readonly model?: string | null;
  readonly error?: unknown;
  readonly detail?: Readonly<Record<string, unknown>> | null;
  /** Folds repeats by this key instead of the report fingerprint. */
  readonly foldKey?: string;
}

export interface CrashReportStatus {
  /** Reports are on right now. */
  readonly active: boolean;
  /** `STUDIO_CRASH_REPORTS=false` or team rules keep reports off regardless of the setting. */
  readonly forcedOff: boolean;
}

export type CrashReportDelivery = "sent" | "rejected" | "failed";

export class CrashReporter extends Context.Service<
  CrashReporter,
  {
    readonly status: Effect.Effect<CrashReportStatus>;
    /** Queues one report for best-effort delivery. Never fails and never waits on the network. */
    readonly report: (event: CrashReportEvent) => Effect.Effect<void>;
    /** Waits for sends in flight. For tests; shutdown never waits on it. */
    readonly awaitIdle: Effect.Effect<void>;
  }
>()("specweave-studio/telemetry/CrashReporter") {
  /** No-op layer: reports off, nothing sent. */
  static readonly layerTest = Layer.succeed(
    CrashReporter,
    CrashReporter.of({
      status: Effect.succeed({ active: false, forcedOff: false }),
      report: () => Effect.void,
      awaitIdle: Effect.void,
    }),
  );
}

const CrashReportEnvConfig = Config.all({
  reports: Config.String(CRASH_REPORTS_ENV).pipe(Config.option),
  url: Config.String(CRASH_REPORT_URL_ENV).pipe(Config.option),
  selfTest: Config.String(CRASH_REPORT_SELF_TEST_ENV).pipe(Config.option),
});

interface FoldEntry {
  /** Null while every report of this fingerprint was over the cap. */
  readonly lastSentAt: number | null;
  /** Reports folded since the last send. */
  readonly folded: number;
}

/**
 * Local budget: one send per fingerprint per window, and a hard cap on sends
 * per window. Mutable state is confined to one service instance.
 */
export function makeCrashReportBudget(options?: {
  readonly windowMs?: number;
  readonly maxSends?: number;
}) {
  const windowMs = options?.windowMs ?? CRASH_REPORT_FOLD_WINDOW_MS;
  const maxSends = options?.maxSends ?? CRASH_REPORT_MAX_SENDS_PER_WINDOW;
  const entries = new Map<string, FoldEntry>();
  let sendTimes: Array<number> = [];

  const underCap = (now: number): boolean => {
    sendTimes = sendTimes.filter((at) => now - at < windowMs);
    return sendTimes.length < maxSends;
  };

  return {
    /** Returns the count to send with, or null when the report is folded or over the cap. */
    admit: (fingerprint: string, now: number): number | null => {
      const entry = entries.get(fingerprint);
      if (entry && entry.lastSentAt !== null && now - entry.lastSentAt < windowMs) {
        entries.set(fingerprint, { ...entry, folded: entry.folded + 1 });
        return null;
      }
      if (!underCap(now)) {
        entries.set(fingerprint, {
          lastSentAt: entry?.lastSentAt ?? null,
          folded: (entry?.folded ?? 0) + 1,
        });
        return null;
      }
      const count = (entry?.folded ?? 0) + 1;
      entries.delete(fingerprint);
      entries.set(fingerprint, { lastSentAt: now, folded: 0 });
      if (entries.size > MAX_FOLD_ENTRIES) {
        const oldest = entries.keys().next().value;
        if (oldest !== undefined) entries.delete(oldest);
      }
      sendTimes.push(now);
      return count;
    },
    /** Counts a send that bypassed `admit`, such as a stored fatal report. */
    consume: (now: number): boolean => {
      if (!underCap(now)) return false;
      sendTimes.push(now);
      return true;
    },
  };
}

/** @public Service construction is part of the canonical Effect module API. */
export const make = Effect.gen(function* () {
  const env = yield* CrashReportEnvConfig;
  const envEnabled = crashReportsEnabledFromEnv(Option.getOrUndefined(env.reports));
  const settings = yield* ServerSettingsService;
  const serverConfig = yield* ServerConfig.ServerConfig;
  const httpClient = yield* HttpClient.HttpClient;
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const endpoint = crashReportEndpoint(Option.getOrUndefined(env.url));
  const fibers = yield* FiberSet.make<unknown, never>();
  const budget = makeCrashReportBudget();

  const teamRulesRefuse = currentTeamRules.pipe(
    Effect.map((rules) => rules.status === "active" && rules.rules.telemetry?.export === false),
    Effect.orElseSucceed(() => false),
  );
  // A settings read that fails counts as off: never report on a guess.
  const settingAllows = settings.getSettings.pipe(
    Effect.map((current) => current.crashReportsEnabled !== false),
    Effect.orElseSucceed(() => false),
  );

  const status: CrashReporter["Service"]["status"] = Effect.gen(function* () {
    const forcedOff = !envEnabled || (yield* teamRulesRefuse);
    if (forcedOff) return { active: false, forcedOff };
    return { active: yield* settingAllows, forcedOff };
  }).pipe(Effect.orElseSucceed(() => ({ active: false, forcedOff: false })));

  const isActive = Effect.map(status, (current) => current.active);

  let installId: string | null | undefined;
  const getInstallId = Effect.sync(() => {
    if (installId === undefined) {
      installId = readOrCreateCrashInstallId(serverConfig.baseDir);
    }
    return installId;
  });

  const send = (report: CrashReport): Effect.Effect<CrashReportDelivery> =>
    httpClient
      .execute(
        HttpClientRequest.post(endpoint).pipe(
          HttpClientRequest.bodyText(encodeCrashReport(report), "application/json"),
        ),
      )
      .pipe(
        Effect.map((response): CrashReportDelivery => {
          if (response.status >= 200 && response.status < 300) return "sent";
          if (response.status >= 400 && response.status < 500) return "rejected";
          return "failed";
        }),
        Effect.timeout(CRASH_REPORT_SEND_TIMEOUT),
        Effect.catchCause(() => Effect.succeed<CrashReportDelivery>("failed")),
      );

  const report: CrashReporter["Service"]["report"] = (event) =>
    Effect.gen(function* () {
      if (!envEnabled) return;
      if (!(yield* isActive)) return;
      const id = yield* getInstallId;
      if (!id) return;
      const base = buildServerCrashReport({
        installId: id,
        kind: event.kind,
        category: event.category ?? null,
        provider: event.provider ?? null,
        model: event.model ?? null,
        error: event.error,
        detail: event.detail ?? null,
      });
      const fingerprint =
        event.foldKey === undefined
          ? crashReportFingerprint(base)
          : `${base.surface}|${base.kind}|${event.foldKey}`;
      const now = yield* Clock.currentTimeMillis;
      const count = budget.admit(fingerprint, now);
      if (count === null) return;
      const outgoing: CrashReport = count > 1 ? { ...base, count } : base;
      yield* FiberSet.run(fibers, send(outgoing));
    }).pipe(Effect.ignoreCause());

  const flushPending = Effect.gen(function* () {
    const dir = pendingCrashReportsDir(serverConfig.stateDir);
    const names = yield* fs.readDirectory(dir).pipe(Effect.orElseSucceed(() => []));
    const pending = names
      .map((name) => ({ name, match: PENDING_CRASH_REPORT_PATTERN.exec(name) }))
      .filter((entry) => entry.match !== null)
      .map((entry) => ({ name: entry.name, writtenAt: Number(entry.match![1]) }))
      .toSorted((left, right) => left.writtenAt - right.writtenAt);
    for (const entry of pending) {
      const filePath = path.join(dir, entry.name);
      const remove = fs.remove(filePath).pipe(Effect.ignore);
      const now = yield* Clock.currentTimeMillis;
      if (now - entry.writtenAt > PENDING_CRASH_REPORT_MAX_AGE_MS) {
        yield* remove;
        continue;
      }
      const raw = yield* fs.readFileString(filePath).pipe(Effect.option);
      if (Option.isNone(raw)) continue;
      const stored = parseCrashReport(Option.getOrNull(decodeJson(raw.value)));
      if (!stored) {
        yield* remove;
        continue;
      }
      if (!budget.consume(now)) return;
      const delivery = yield* send(stored);
      if (delivery === "failed") return; // Offline or relay down: keep the rest for next start.
      yield* remove;
    }
  }).pipe(Effect.ignoreCause());

  const startup = Effect.gen(function* () {
    if (!envEnabled) return;
    yield* settings.ready.pipe(Effect.timeout(SETTINGS_READY_TIMEOUT), Effect.ignore);
    if (!(yield* isActive)) return;
    yield* flushPending;
    if (Option.getOrUndefined(env.selfTest)?.trim() === "1") {
      yield* report({
        kind: "test",
        category: "self_test",
        error: { name: "CrashReportSelfTest", message: "Crash report self-test" },
      });
    }
  }).pipe(Effect.ignoreCause());

  if (envEnabled) {
    yield* FiberSet.run(fibers, startup);
  }

  return CrashReporter.of({
    status,
    report,
    awaitIdle: FiberSet.awaitEmpty(fibers),
  });
});

export const layer = Layer.effect(CrashReporter, make);
