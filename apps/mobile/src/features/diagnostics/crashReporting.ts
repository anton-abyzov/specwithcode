import Constants from "expo-constants";
import * as Crypto from "expo-crypto";
import * as Device from "expo-device";
import { Directory, File, Paths } from "expo-file-system";
import { Platform } from "react-native";

import {
  crashReportEndpoint,
  crashReportMachineLabel,
  encodeCrashReport,
} from "@specweave-studio/shared/crashReport";

import { resolveCloudPublicConfig } from "../cloud/publicConfig";
import {
  buildMobileCrashReport,
  crashReportArch,
  crashReportsForcedOffByBuild,
  createSessionCrashReportLimiter,
  encodeCrashReportPreference,
  encodePendingCrashReports,
  enqueuePendingCrashReport,
  mobileCrashReportsEnabled,
  parseCrashReportPreference,
  parsePendingCrashReports,
  removePendingCrashReport,
  settlePendingCrashReports,
  type CrashReportSendOutcome,
} from "./crash-report-model";

/**
 * Automatic JavaScript error reports. A global handler builds a sanitized
 * report (no prompts, file contents, ids or paths) and posts it to the relay.
 * Fatal reports are written to disk first, because the app can die before the
 * request finishes, and the next launch sends them. Everything is best effort
 * and never throws into the app.
 */

const SEND_TIMEOUT_MS = 5_000;
const FLUSH_DELAY_MS = 4_000;
const DIRECTORY_NAME = "crash-reports";
const INSTALL_ID_FILE = "install-id";
const PREFERENCE_FILE = "preference.json";
const PENDING_FILE = "pending.json";
const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u;

// Read as a literal so Expo inlines it at build time.
const BUILD_VALUE = process.env.EXPO_PUBLIC_CRASH_REPORTS;

let installed = false;
let reporting = false;
let preferenceCache: boolean | null = null;
let machineHash = "";
const allowReport = createSessionCrashReportLimiter();

function directory(create: boolean): Directory {
  const dir = new Directory(Paths.document, DIRECTORY_NAME);
  if (create && !dir.exists) dir.create({ idempotent: true, intermediates: true });
  return dir;
}

function readText(name: string): string | null {
  try {
    const file = new File(directory(false), name);
    return file.exists ? file.textSync() : null;
  } catch {
    return null;
  }
}

function writeText(name: string, contents: string): void {
  try {
    const file = new File(directory(true), name);
    if (!file.exists) file.create({ intermediates: true });
    file.writeSync(contents);
  } catch {
    // Best effort.
  }
}

function deleteFile(name: string): void {
  try {
    const file = new File(directory(false), name);
    if (file.exists) file.delete();
  } catch {
    // Best effort.
  }
}

function userPreference(): boolean {
  if (preferenceCache === null)
    preferenceCache = parseCrashReportPreference(readText(PREFERENCE_FILE));
  return preferenceCache;
}

function enabled(): boolean {
  return mobileCrashReportsEnabled({
    buildValue: BUILD_VALUE,
    isDev: __DEV__,
    userPreference: userPreference(),
  });
}

/** The Diagnostics switch. Off also discards reports waiting to be sent. */
export function getCrashReportsPreference(): boolean {
  return userPreference();
}

export function setCrashReportsPreference(value: boolean): void {
  preferenceCache = value;
  writeText(PREFERENCE_FILE, encodeCrashReportPreference(value));
  if (!value) deleteFile(PENDING_FILE);
}

export function crashReportsDisabledByBuild(): boolean {
  return crashReportsForcedOffByBuild(BUILD_VALUE);
}

function installId(): string {
  const existing = readText(INSTALL_ID_FILE)?.trim();
  if (existing && UUID_PATTERN.test(existing)) return existing;
  const created = Crypto.randomUUID().toLowerCase();
  writeText(INSTALL_ID_FILE, created);
  return created;
}

function osName(): string {
  return Platform.OS;
}

function arch(): string {
  return crashReportArch(Device.supportedCpuArchitectures);
}

function endpoint(): string {
  return crashReportEndpoint(resolveCloudPublicConfig().relay.url);
}

async function send(body: string): Promise<CrashReportSendOutcome> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), SEND_TIMEOUT_MS);
  try {
    const response = await fetch(endpoint(), {
      method: "POST",
      headers: { "content-type": "application/json" },
      body,
      signal: controller.signal,
    });
    if (response.ok) return "sent";
    // A 4xx will not get better on retry; a 5xx or 429 might.
    return response.status >= 400 && response.status < 500 && response.status !== 429
      ? "rejected"
      : "failed";
  } catch {
    return "failed";
  } finally {
    clearTimeout(timer);
  }
}

function pendingQueue() {
  return parsePendingCrashReports(readText(PENDING_FILE));
}

function savePendingQueue(queue: ReturnType<typeof pendingQueue>): void {
  if (queue.length === 0) deleteFile(PENDING_FILE);
  else writeText(PENDING_FILE, encodePendingCrashReports(queue));
}

function report(error: unknown, isFatal: boolean): void {
  if (reporting || !enabled()) return;
  reporting = true;
  try {
    const os = osName();
    const id = installId();
    const machineArch = arch();
    const crashReport = buildMobileCrashReport({
      error,
      isFatal,
      installId: id,
      machine: crashReportMachineLabel(os, machineArch, machineHash),
      appVersion: Constants.expoConfig?.version ?? "0.0.0",
      os,
      osVersion: Device.osVersion ?? String(Platform.Version),
      arch: machineArch,
    });
    if (!allowReport(crashReport)) return;
    const body = encodeCrashReport(crashReport);
    // Written first: a fatal error may end the process before fetch returns.
    if (isFatal) savePendingQueue(enqueuePendingCrashReport(pendingQueue(), body));
    void send(body).then((outcome) => {
      if (isFatal) {
        if (outcome !== "failed") savePendingQueue(removePendingCrashReport(pendingQueue(), body));
      } else if (outcome === "failed" && enabled()) {
        savePendingQueue(enqueuePendingCrashReport(pendingQueue(), body));
      }
    });
  } catch {
    // Reporting must never add a second failure.
  } finally {
    reporting = false;
  }
}

async function prepareAndFlush(): Promise<void> {
  if (!enabled()) return;
  try {
    // A hash of the random install id: stable per install, says nothing about the device.
    machineHash = await Crypto.digestStringAsync(Crypto.CryptoDigestAlgorithm.SHA256, installId());
  } catch {
    machineHash = "";
  }
  const queue = pendingQueue();
  if (queue.length === 0) return;
  const outcomes = new Map<string, CrashReportSendOutcome>();
  // One at a time, once per launch: no tight retry loop.
  for (const entry of queue) {
    outcomes.set(entry.body, await send(entry.body));
  }
  if (!enabled()) return;
  savePendingQueue(settlePendingCrashReports(pendingQueue(), outcomes));
}

/**
 * Installs the global handler before the root component registers. The
 * previous handler still runs, so the red box and the native crash stay as
 * they were.
 */
export function installCrashReporting(): void {
  if (installed) return;
  installed = true;
  try {
    const previous = ErrorUtils.getGlobalHandler();
    ErrorUtils.setGlobalHandler((error: unknown, isFatal?: boolean) => {
      try {
        report(error, isFatal === true);
      } catch {
        // Ignore.
      }
      previous(error, isFatal);
    });
  } catch {
    return;
  }
  // Off the startup path.
  setTimeout(() => {
    void prepareAndFlush().catch(() => undefined);
  }, FLUSH_DELAY_MS);
}
