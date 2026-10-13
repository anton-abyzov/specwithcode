import type {
  ServerObservability,
  ServerTraceDiagnosticsResult,
} from "@specweave-studio/contracts";
import * as Option from "effect/Option";

const FAILURE_CATEGORIES = [
  "authentication",
  "rate-limit",
  "model-unavailable",
  "provider-startup",
  "timeout",
  "other",
] as const;
type FailureCategory = (typeof FAILURE_CATEGORIES)[number];

/** Classify locally; never put arbitrary provider text into a support report. */
export function diagnosticFailureCategory(text: string): FailureCategory {
  if (
    /unauthoriz|authenticat|sign.?in|\b401\b|\b403\b|invalid.{0,12}(token|credential)/i.test(text)
  )
    return "authentication";
  if (/rate.?limit|quota|\b429\b|capacity/i.test(text)) return "rate-limit";
  if (/model.{0,30}(unavailable|unsupported|not found|not supported)|unknown model/i.test(text))
    return "model-unavailable";
  if (/timed?\s?out|timeout/i.test(text)) return "timeout";
  if (/spawn|ENOENT|could not start|failed to start|provider.{0,20}start/i.test(text))
    return "provider-startup";
  return "other";
}

const safeCount = (value: number) => (Number.isFinite(value) ? Math.max(0, Math.trunc(value)) : 0);
export function productUsageStatusLabel(observability: ServerObservability | undefined): string {
  if (
    observability?.productUsageEnabled === undefined ||
    observability.productUsageDestinationConfigured === undefined
  )
    return "Unknown — this environment does not report its usage collection settings.";
  if (observability.productUsageEnabled)
    return observability.productUsageDestinationConfigured
      ? "On — usage events are enabled for a configured destination."
      : "Unknown — collection configuration is incomplete.";
  return observability.productUsageDestinationConfigured
    ? "Off — a destination is configured, but collection is disabled."
    : "Off — no analytics destination is configured.";
}
const safeVersion = (value: string) =>
  /^(\d+\.\d+\.\d+)(?:[-+][\w.-]+)?$/.exec(value)?.[1] ?? "unknown";

/** Explicit field selection, rather than redacting a copy of sensitive logs. */
export function buildPrivateDiagnosticsReport(input: {
  readonly appVersion: string;
  readonly serverVersion: string;
  readonly os: string;
  readonly architecture: string;
  readonly observability: ServerObservability;
  readonly diagnostics: ServerTraceDiagnosticsResult;
}) {
  const diagnostics = input.diagnostics;
  const failureCategories = Object.fromEntries(
    FAILURE_CATEGORIES.map((category) => [category, 0]),
  ) as Record<FailureCategory, number>;
  for (const failure of diagnostics.commonFailures) {
    failureCategories[diagnosticFailureCategory(failure.cause)] += safeCount(failure.count);
  }
  const traceError = Option.getOrNull(diagnostics.error);
  return {
    format: "specwithcode-private-diagnostics-v1",
    application: {
      version: safeVersion(input.appVersion),
      serverVersion: safeVersion(input.serverVersion),
      os: ["darwin", "windows", "linux", "unknown"].includes(input.os) ? input.os : "unknown",
      architecture: ["arm64", "x64", "other"].includes(input.architecture)
        ? input.architecture
        : "other",
    },
    observability: {
      productUsageEnabled:
        typeof input.observability.productUsageEnabled === "boolean"
          ? input.observability.productUsageEnabled
          : null,
      productUsageDestinationConfigured:
        typeof input.observability.productUsageDestinationConfigured === "boolean"
          ? input.observability.productUsageDestinationConfigured
          : null,
      localTracingEnabled: input.observability.localTracingEnabled === true,
      externalTracesConfigured: input.observability.otlpTracesEnabled === true,
      externalMetricsConfigured: input.observability.otlpMetricsEnabled === true,
      externalLogsConfigured: input.observability.otlpLogsEnabled === true,
    },
    traces: {
      records: safeCount(diagnostics.recordCount),
      parseErrors: safeCount(diagnostics.parseErrorCount),
      failures: safeCount(diagnostics.failureCount),
      interruptions: safeCount(diagnostics.interruptionCount),
      slowSpans: safeCount(diagnostics.slowSpanCount),
      partial: Option.getOrNull(diagnostics.partialFailure) === true,
      readError:
        traceError?.kind === "trace-file-not-found" || traceError?.kind === "trace-file-read-failed"
          ? traceError.kind
          : null,
      // These are aggregate categories for the server's bounded failure sample.
      failureSampleCategories: failureCategories,
    },
    excluded: [
      "conversation content",
      "raw logs",
      "files and attachments",
      "credentials",
      "account and conversation identifiers",
      "paths and connection addresses",
      "process commands",
      "free-text errors",
    ],
  };
}

export type PrivateDiagnosticsReport = ReturnType<typeof buildPrivateDiagnosticsReport>;
