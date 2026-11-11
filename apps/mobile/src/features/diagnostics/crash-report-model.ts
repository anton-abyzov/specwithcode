import {
  buildCrashReport,
  CRASH_REPORT_MAX_BYTES,
  crashReportFingerprint,
  crashReportsEnabledFromEnv,
  type CrashReport,
} from "@specweave-studio/shared/crashReport";

/**
 * Pure parts of mobile crash reporting: building the report, the on/off
 * decision and the pending queue a fatal error leaves for the next launch.
 * No native modules here, so it runs under the unit tests.
 */

/** Reports kept for the next launch. Older ones are dropped first. */
export const PENDING_CRASH_REPORT_LIMIT = 5;
/** Delivery attempts before a pending report is dropped. */
export const PENDING_CRASH_REPORT_MAX_ATTEMPTS = 3;
/** Reports one app session sends at most, so a render loop cannot flood the relay. */
export const SESSION_CRASH_REPORT_LIMIT = 10;

export interface MobileCrashReportInput {
  readonly error: unknown;
  readonly isFatal: boolean;
  readonly installId: string;
  readonly machine: string;
  readonly appVersion: string;
  readonly os: string;
  readonly osVersion: string | null;
  readonly arch: string;
}

export function buildMobileCrashReport(input: MobileCrashReportInput): CrashReport {
  return buildCrashReport({
    installId: input.installId,
    machine: input.machine,
    surface: "mobile",
    kind: input.isFatal ? "fatal" : "js_error",
    category: input.isFatal ? "js_fatal" : "js_error",
    appVersion: input.appVersion,
    os: input.os,
    osVersion: input.osVersion,
    arch: input.arch,
    error: input.error,
  });
}

/** Coarse CPU family from expo-device's `supportedCpuArchitectures`. */
export function crashReportArch(architectures: ReadonlyArray<string> | null | undefined): string {
  const first = architectures?.[0]?.toLowerCase() ?? "";
  if (first.startsWith("arm64") || first.startsWith("aarch64")) return "arm64";
  if (first.startsWith("armeabi") || first.startsWith("armv7")) return "arm";
  if (first.includes("x86_64") || first.includes("x86-64")) return "x64";
  if (first.startsWith("x86") || first.startsWith("i386")) return "x86";
  return "unknown";
}

/**
 * Reports are on unless the build turns them off (`EXPO_PUBLIC_CRASH_REPORTS`)
 * or the user switched them off in Diagnostics. Development builds only send
 * when the build variable asks for it, so red-box errors while coding stay local.
 */
export function mobileCrashReportsEnabled(input: {
  readonly buildValue: string | undefined;
  readonly isDev: boolean;
  readonly userPreference: boolean;
}): boolean {
  if (!crashReportsEnabledFromEnv(input.buildValue)) return false;
  if (input.isDev && !crashReportsExplicitlyOn(input.buildValue)) return false;
  return input.userPreference;
}

export function crashReportsForcedOffByBuild(buildValue: string | undefined): boolean {
  return !crashReportsEnabledFromEnv(buildValue);
}

function crashReportsExplicitlyOn(value: string | undefined): boolean {
  return ["true", "1", "on", "yes"].includes(value?.trim().toLowerCase() ?? "");
}

/** The persisted switch. A missing or unreadable file means on. */
export function parseCrashReportPreference(text: string | null): boolean {
  if (text === null) return true;
  try {
    const value = JSON.parse(text) as unknown;
    if (typeof value === "object" && value !== null && "enabled" in value) {
      return (value as { enabled: unknown }).enabled !== false;
    }
  } catch {
    // Fall through to the default.
  }
  return true;
}

export function encodeCrashReportPreference(enabled: boolean): string {
  return JSON.stringify({ enabled });
}

export interface PendingCrashReport {
  /** Encoded report body, ready to post. */
  readonly body: string;
  readonly attempts: number;
}

export function parsePendingCrashReports(text: string | null): ReadonlyArray<PendingCrashReport> {
  if (text === null || text.trim().length === 0) return [];
  try {
    const value = JSON.parse(text) as unknown;
    if (!Array.isArray(value)) return [];
    return value
      .filter(
        (entry): entry is PendingCrashReport =>
          typeof entry === "object" &&
          entry !== null &&
          typeof (entry as PendingCrashReport).body === "string" &&
          (entry as PendingCrashReport).body.length <= CRASH_REPORT_MAX_BYTES &&
          typeof (entry as PendingCrashReport).attempts === "number",
      )
      .slice(-PENDING_CRASH_REPORT_LIMIT);
  } catch {
    return [];
  }
}

export function encodePendingCrashReports(queue: ReadonlyArray<PendingCrashReport>): string {
  return JSON.stringify(queue);
}

export function enqueuePendingCrashReport(
  queue: ReadonlyArray<PendingCrashReport>,
  body: string,
): ReadonlyArray<PendingCrashReport> {
  if (body.length > CRASH_REPORT_MAX_BYTES) return queue;
  if (queue.some((entry) => entry.body === body)) return queue;
  return [...queue, { body, attempts: 0 }].slice(-PENDING_CRASH_REPORT_LIMIT);
}

export function removePendingCrashReport(
  queue: ReadonlyArray<PendingCrashReport>,
  body: string,
): ReadonlyArray<PendingCrashReport> {
  return queue.filter((entry) => entry.body !== body);
}

export type CrashReportSendOutcome = "sent" | "rejected" | "failed";

/**
 * Queue after one delivery pass: sent and rejected reports leave, failed ones
 * count an attempt and leave after {@link PENDING_CRASH_REPORT_MAX_ATTEMPTS}.
 */
export function settlePendingCrashReports(
  queue: ReadonlyArray<PendingCrashReport>,
  outcomes: ReadonlyMap<string, CrashReportSendOutcome>,
): ReadonlyArray<PendingCrashReport> {
  const next: PendingCrashReport[] = [];
  for (const entry of queue) {
    const outcome = outcomes.get(entry.body);
    if (outcome === undefined) {
      next.push(entry);
      continue;
    }
    if (outcome !== "failed") continue;
    const attempts = entry.attempts + 1;
    if (attempts < PENDING_CRASH_REPORT_MAX_ATTEMPTS) next.push({ body: entry.body, attempts });
  }
  return next;
}

/** Once per fingerprint and at most `limit` reports per app session. */
export function createSessionCrashReportLimiter(limit = SESSION_CRASH_REPORT_LIMIT) {
  const seen = new Set<string>();
  return (report: CrashReport): boolean => {
    if (seen.size >= limit) return false;
    const fingerprint = crashReportFingerprint(report);
    if (seen.has(fingerprint)) return false;
    seen.add(fingerprint);
    return true;
  };
}
