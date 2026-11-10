import { describe, expect, it } from "vite-plus/test";

import { encodeCrashReport, parseCrashReport } from "@specweave-studio/shared/crashReport";

import {
  buildMobileCrashReport,
  crashReportArch,
  createSessionCrashReportLimiter,
  encodeCrashReportPreference,
  encodePendingCrashReports,
  enqueuePendingCrashReport,
  mobileCrashReportsEnabled,
  parseCrashReportPreference,
  parsePendingCrashReports,
  PENDING_CRASH_REPORT_LIMIT,
  removePendingCrashReport,
  settlePendingCrashReports,
} from "./crash-report-model";

const INSTALL_ID = "3f2b8c1e-4d5a-4b6c-8d7e-9f0a1b2c3d4e";

function sampleError(message: string): Error {
  const error = new TypeError(message);
  error.stack = [
    `TypeError: ${message}`,
    "    at NewTaskFlowProvider (/Users/expo/workingdir/build/main.jsbundle:590585:51)",
  ].join("\n");
  return error;
}

function report(input: { message?: string; isFatal?: boolean } = {}) {
  return buildMobileCrashReport({
    error: sampleError(input.message ?? "Cannot read property 'x' of null"),
    isFatal: input.isFatal ?? false,
    installId: INSTALL_ID,
    machine: "ios-arm64-abcdef012345",
    appVersion: "0.2.2",
    os: "ios",
    osVersion: "18.1",
    arch: "arm64",
  });
}

describe("buildMobileCrashReport", () => {
  it("labels fatal and non-fatal errors and passes relay validation", () => {
    const fatal = report({ isFatal: true });
    expect(fatal).toMatchObject({
      surface: "mobile",
      kind: "fatal",
      category: "js_fatal",
      appVersion: "0.2.2",
      os: "ios",
      arch: "arm64",
      errorName: "TypeError",
    });
    expect(report().kind).toBe("js_error");
    expect(report().category).toBe("js_error");
    expect(parseCrashReport(JSON.parse(encodeCrashReport(fatal)))).not.toBeNull();
  });

  it("strips emails, paths and home folders from the error", () => {
    const built = report({ message: "Failed for jane@example.com at /Users/jane/Documents/a.txt" });
    expect(built.message).not.toContain("jane");
    expect(built.message).toContain("<email>");
    expect(built.stack).not.toContain("/Users/expo");
  });
});

describe("crashReportArch", () => {
  it("maps expo-device architectures to a coarse family", () => {
    expect(crashReportArch(["arm64-v8a", "armeabi-v7a"])).toBe("arm64");
    expect(crashReportArch(["arm64e"])).toBe("arm64");
    expect(crashReportArch(["x86_64"])).toBe("x64");
    expect(crashReportArch(["armeabi-v7a"])).toBe("arm");
    expect(crashReportArch(null)).toBe("unknown");
    expect(crashReportArch([])).toBe("unknown");
  });
});

describe("mobileCrashReportsEnabled", () => {
  it("is on by default in release builds", () => {
    expect(
      mobileCrashReportsEnabled({ buildValue: undefined, isDev: false, userPreference: true }),
    ).toBe(true);
  });

  it("honors the build switch and the user switch", () => {
    expect(
      mobileCrashReportsEnabled({ buildValue: "false", isDev: false, userPreference: true }),
    ).toBe(false);
    expect(
      mobileCrashReportsEnabled({ buildValue: undefined, isDev: false, userPreference: false }),
    ).toBe(false);
  });

  it("stays local in development unless the build asks for reports", () => {
    expect(
      mobileCrashReportsEnabled({ buildValue: undefined, isDev: true, userPreference: true }),
    ).toBe(false);
    expect(mobileCrashReportsEnabled({ buildValue: "1", isDev: true, userPreference: true })).toBe(
      true,
    );
  });
});

describe("crash report preference", () => {
  it("defaults to on and round-trips", () => {
    expect(parseCrashReportPreference(null)).toBe(true);
    expect(parseCrashReportPreference("not json")).toBe(true);
    expect(parseCrashReportPreference(encodeCrashReportPreference(false))).toBe(false);
    expect(parseCrashReportPreference(encodeCrashReportPreference(true))).toBe(true);
  });
});

describe("pending crash reports", () => {
  it("queues unique bodies, caps the queue and round-trips through storage", () => {
    let queue = enqueuePendingCrashReport([], "a");
    queue = enqueuePendingCrashReport(queue, "a");
    expect(queue).toEqual([{ body: "a", attempts: 0 }]);
    for (let index = 0; index < PENDING_CRASH_REPORT_LIMIT + 2; index += 1) {
      queue = enqueuePendingCrashReport(queue, `r${index}`);
    }
    expect(queue).toHaveLength(PENDING_CRASH_REPORT_LIMIT);
    expect(queue[0]?.body).toBe("r2");
    expect(parsePendingCrashReports(encodePendingCrashReports(queue))).toEqual(queue);
    expect(removePendingCrashReport(queue, "r2").map((entry) => entry.body)).not.toContain("r2");
  });

  it("ignores corrupt storage", () => {
    expect(parsePendingCrashReports(null)).toEqual([]);
    expect(parsePendingCrashReports("{")).toEqual([]);
    expect(parsePendingCrashReports('[{"body":1}]')).toEqual([]);
  });

  it("drops sent and rejected reports and gives failed ones three tries", () => {
    const queue = [
      { body: "sent", attempts: 0 },
      { body: "rejected", attempts: 0 },
      { body: "retry", attempts: 0 },
      { body: "last", attempts: 2 },
      { body: "untouched", attempts: 1 },
    ];
    const next = settlePendingCrashReports(
      queue,
      new Map([
        ["sent", "sent"],
        ["rejected", "rejected"],
        ["retry", "failed"],
        ["last", "failed"],
      ] as const),
    );
    expect(next).toEqual([
      { body: "retry", attempts: 1 },
      { body: "untouched", attempts: 1 },
    ]);
  });
});

describe("createSessionCrashReportLimiter", () => {
  it("sends each failure once and caps the session", () => {
    const allow = createSessionCrashReportLimiter(2);
    expect(allow(report())).toBe(true);
    expect(allow(report())).toBe(false);
    expect(allow(report({ isFatal: true }))).toBe(true);
    expect(allow(buildMobileCrashReport({ ...baseInput(), error: new RangeError("x") }))).toBe(
      false,
    );
  });
});

function baseInput() {
  return {
    error: null,
    isFatal: false,
    installId: INSTALL_ID,
    machine: "ios-arm64-abcdef012345",
    appVersion: "0.2.2",
    os: "ios",
    osVersion: null,
    arch: "arm64",
  };
}
