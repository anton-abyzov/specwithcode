import { describe, expect, it } from "vite-plus/test";
import type { ServerTraceDiagnosticsResult } from "@specweave-studio/contracts";
import * as DateTime from "effect/DateTime";
import * as Option from "effect/Option";
import {
  buildPrivateDiagnosticsReport,
  diagnosticFailureCategory,
  productUsageStatusLabel,
} from "./PrivacySettings.logic";

const sensitive =
  "private-prompt alice@example.com /Users/alice/private-repo ghp_DO_NOT_EXPORT secret-token";
const now = DateTime.makeUnsafe(0);
const diagnostics: ServerTraceDiagnosticsResult = {
  traceFilePath: sensitive,
  scannedFilePaths: [sensitive],
  readAt: now,
  recordCount: 20,
  parseErrorCount: 1,
  firstSpanAt: Option.some(now),
  lastSpanAt: Option.some(now),
  failureCount: 3,
  interruptionCount: 1,
  slowSpanThresholdMs: 500,
  slowSpanCount: 2,
  logLevelCounts: { [sensitive]: 99 },
  topSpansByCount: [
    {
      name: sensitive,
      count: 99,
      failureCount: 3,
      totalDurationMs: 4,
      averageDurationMs: 2,
      maxDurationMs: 3,
    },
  ],
  slowestSpans: [
    { name: sensitive, durationMs: 3, endedAt: now, traceId: sensitive, spanId: sensitive },
  ],
  commonFailures: [
    {
      name: sensitive,
      cause: `Unauthorized ${sensitive}`,
      count: 3,
      lastSeenAt: now,
      traceId: sensitive,
      spanId: sensitive,
    },
  ],
  latestFailures: [
    {
      name: sensitive,
      cause: sensitive,
      durationMs: 2,
      endedAt: now,
      traceId: sensitive,
      spanId: sensitive,
    },
  ],
  latestWarningAndErrorLogs: [
    {
      spanName: sensitive,
      level: sensitive,
      message: sensitive,
      seenAt: now,
      traceId: sensitive,
      spanId: sensitive,
    },
  ],
  partialFailure: Option.some(true),
  error: Option.some({ kind: "trace-file-read-failed", message: sensitive }),
};

describe("private diagnostics report", () => {
  it("shows unknown for older hosts and distinguishes enabled, disabled and unconfigured collection", () => {
    const observability = {
      logsDirectoryPath: "/private",
      localTracingEnabled: true,
      otlpTracesEnabled: false,
      otlpMetricsEnabled: false,
      otlpLogsEnabled: false,
    };
    expect(productUsageStatusLabel(observability)).toMatch(/^Unknown/);
    expect(
      productUsageStatusLabel({
        ...observability,
        productUsageEnabled: true,
        productUsageDestinationConfigured: true,
      }),
    ).toMatch(/^On/);
    expect(
      productUsageStatusLabel({
        ...observability,
        productUsageEnabled: false,
        productUsageDestinationConfigured: true,
      }),
    ).toContain("collection is disabled");
    expect(
      productUsageStatusLabel({
        ...observability,
        productUsageEnabled: false,
        productUsageDestinationConfigured: false,
      }),
    ).toContain("no analytics destination");
  });
  it("exports only selected facts, excluding sensitive data in every untrusted string field", () => {
    const report = buildPrivateDiagnosticsReport({
      appVersion: "1.0.7+private-build-label",
      serverVersion: sensitive,
      os: sensitive,
      architecture: sensitive,
      observability: {
        logsDirectoryPath: sensitive,
        localTracingEnabled: true,
        otlpTracesEnabled: true,
        otlpTracesUrl: sensitive,
        otlpMetricsEnabled: false,
        otlpLogsEnabled: false,
      },
      diagnostics,
    });
    const serialized = JSON.stringify(report);
    for (const secret of sensitive.split(" ")) expect(serialized).not.toContain(secret);
    expect(serialized).not.toContain("private-build-label");
    expect(report.application).toEqual({
      version: "1.0.7",
      serverVersion: "unknown",
      os: "unknown",
      architecture: "other",
    });
    expect(report.traces).toMatchObject({
      records: 20,
      failures: 3,
      parseErrors: 1,
      partial: true,
      readError: "trace-file-read-failed",
      failureSampleCategories: { authentication: 3 },
    });
    expect(report.observability.externalTracesConfigured).toBe(true);
  });
  it("keeps absent trace files distinct from a clean scan and bounds invalid counters", () => {
    const report = buildPrivateDiagnosticsReport({
      appVersion: "1.0.7",
      serverVersion: "1.0.7",
      os: "darwin",
      architecture: "arm64",
      observability: {
        logsDirectoryPath: "/private",
        localTracingEnabled: false,
        otlpTracesEnabled: false,
        otlpMetricsEnabled: false,
        otlpLogsEnabled: false,
      },
      diagnostics: {
        ...diagnostics,
        recordCount: NaN,
        failureCount: -1,
        partialFailure: Option.none(),
        error: Option.some({ kind: "trace-file-not-found", message: sensitive }),
      },
    });
    expect(report.traces.records).toBe(0);
    expect(report.traces.failures).toBe(0);
    expect(report.traces.readError).toBe("trace-file-not-found");
    expect(report.traces.partial).toBe(false);
  });
  it.each([
    ["Unauthorized request", "authentication"],
    ["Rate limit 429", "rate-limit"],
    ["Model is unsupported", "model-unavailable"],
    ["spawn ENOENT", "provider-startup"],
    ["Request timed out", "timeout"],
    [sensitive, "other"],
  ])("classifies %s without retaining its text", (text, category) => {
    expect(diagnosticFailureCategory(text)).toBe(category);
  });
});
