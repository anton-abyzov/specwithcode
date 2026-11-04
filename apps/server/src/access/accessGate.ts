/**
 * The access gate in front of computer and device tools: what each subject is
 * called on the card, and asking only for what the thread may not use yet.
 *
 * @module accessGate
 */
import {
  type AccessRequestSubject,
  accessGrantKey,
  type DeviceSummary,
} from "@specweave-studio/contracts";
import * as Clock from "effect/Clock";
import * as Effect from "effect/Effect";

import * as ComputerUseBroker from "../computerUse/ComputerUseBroker.ts";
import type { McpInvocationScope } from "../mcp/McpInvocationContext.ts";
import * as OrchestratorMcpService from "../mcp/OrchestratorMcpService.ts";
import * as AccessRequests from "./AccessRequests.ts";

export const APP_ACCESS_DETAIL = "See and control its windows";
export const DEVICE_ACCESS_DETAIL = "See its screen, tap, type and install apps";

/** How long an implicit card (raised by a tool, not request_access) waits. */
export const IMPLICIT_ACCESS_TIMEOUT_MS = 5 * 60 * 1000;

/**
 * What agents are told when they aim input at SpecWithCode: the access card
 * is answered there, so an agent that could click in it could allow itself.
 */
export const SELF_CONTROL_REFUSAL =
  "Agents cannot click or type in SpecWithCode itself, so they cannot answer their own access requests.";

/**
 * Names the desktop app goes by: "SpecWithCode", stage builds such as
 * "SpecWithCode (Dev)" or "SpecWithCode (Nightly)", and older "SpecWeave
 * Studio" builds (see apps/desktop DesktopEnvironment and electron-launcher).
 */
const SELF_APP_NAME =
  /^(specwithcode|specweave studio)(\s*\([^)]*\)|\s+(dev|nightly|alpha|beta|preview|desktop))?$/;

/** Whether an app name is SpecWithCode itself, in any of its builds. */
export function isSpecWithCodeApp(name: string): boolean {
  return SELF_APP_NAME.test(
    name
      .trim()
      .toLowerCase()
      .replace(/\.app$/, ""),
  );
}

/** The grant key an app name maps to, before any lookup. */
export const appGrantKey = (name: string) => accessGrantKey("app", name);

const APP_SUBJECT_TTL_MS = 10 * 60 * 1000;
const APP_SUBJECT_CACHE_MAX = 100;
const appSubjectCache = new Map<string, { readonly at: number; readonly subject: AppSubject }>();

type AppSubject = AccessRequestSubject & { readonly kind: "app" };

/** Forgets looked-up apps; for tests. */
export function clearAppSubjectCache(): void {
  appSubjectCache.clear();
}

/**
 * An app as the card shows it. The desktop app reports the name macOS uses
 * (the same name it reports as frontmost) and the app's own icon; without it
 * the name is used as given and the card draws a generic app glyph. Looked-up
 * apps are remembered for ten minutes, so repeated asks skip the lookup.
 */
export const appSubject = (name: string) =>
  Effect.gen(function* () {
    const cacheKey = name.trim().toLowerCase();
    const now = yield* Clock.currentTimeMillis;
    const cached = appSubjectCache.get(cacheKey);
    if (cached !== undefined && now - cached.at < APP_SUBJECT_TTL_MS) return cached.subject;
    const broker = yield* ComputerUseBroker.ComputerUseBroker;
    const info = yield* broker.invoke({ kind: "appInfo", application: name }).pipe(
      Effect.map((result) => ({ found: true as const, application: result.application })),
      Effect.orElseSucceed(() => ({ found: false as const, application: undefined })),
    );
    const label = info.application?.name ?? name.trim();
    const subject: AppSubject = {
      kind: "app",
      key: accessGrantKey("app", label),
      label,
      detail: APP_ACCESS_DETAIL,
      ...(info.application?.icon === undefined ? {} : { icon: info.application.icon }),
    };
    // A failed lookup (no desktop app) is asked again next time.
    if (info.found) {
      appSubjectCache.delete(cacheKey);
      if (appSubjectCache.size >= APP_SUBJECT_CACHE_MAX) {
        const oldest = appSubjectCache.keys().next();
        if (oldest.done !== true) appSubjectCache.delete(oldest.value);
      }
      appSubjectCache.set(cacheKey, { at: now, subject });
    }
    return subject;
  });

/** The grant key of one device on one host. */
export const deviceGrantKey = (hostId: string, deviceId: string) =>
  accessGrantKey("device", `${hostId}/${deviceId}`);

export const deviceSubject = (device: DeviceSummary): AccessRequestSubject => ({
  kind: "device",
  key: deviceGrantKey(device.hostId, device.id),
  label: device.name,
  detail: DEVICE_ACCESS_DETAIL,
  platform: device.platform,
  ...(device.hostId === "local" ? {} : { hostLabel: device.hostId }),
});

const joinNames = (names: ReadonlyArray<string>) =>
  names.length <= 1
    ? (names[0] ?? "")
    : `${names.slice(0, -1).join(", ")} and ${names[names.length - 1]}`;

/** "Use System Settings and Notes", "Control iPhone 17 Pro", or both. */
export function accessTitle(subjects: ReadonlyArray<AccessRequestSubject>): string {
  const apps = subjects.filter((subject) => subject.kind !== "device").map((s) => s.label);
  const devices = subjects.filter((subject) => subject.kind === "device").map((s) => s.label);
  const parts = [
    ...(apps.length > 0 ? [`Use ${joinNames(apps)}`] : []),
    ...(devices.length > 0
      ? [`${apps.length > 0 ? "control" : "Control"} ${joinNames(devices)}`]
      : []),
  ];
  return parts.join(" and ");
}

export type AccessGateResult =
  | { readonly status: "allowed"; readonly asked: boolean; readonly scope?: "thread" | "machine" }
  | { readonly status: "denied" | "cancelled" | "timed_out"; readonly asked: true };

/**
 * Asks the user for the subjects this thread may not use yet, in one card.
 * Nothing to ask means allowed without a card.
 */
export const ensureAccess = (input: {
  readonly scope: McpInvocationScope & { readonly thread: { readonly threadId: string } };
  readonly subjects: ReadonlyArray<AccessRequestSubject>;
  readonly reason: string;
  readonly timeoutMs?: number | undefined;
  readonly clientRequestId?: string | undefined;
}) =>
  Effect.gen(function* () {
    const access = yield* AccessRequests.AccessRequests;
    const threadId = input.scope.thread.threadId as Parameters<typeof access.isAllowed>[0];
    const missing: Array<AccessRequestSubject> = [];
    for (const subject of input.subjects) {
      if (missing.some((other) => other.key === subject.key)) continue;
      if (!(yield* access.isAllowed(threadId, subject.key))) missing.push(subject);
    }
    if (missing.length === 0) return { status: "allowed", asked: false } as AccessGateResult;
    const service = yield* OrchestratorMcpService.OrchestratorMcpService;
    const result = yield* service.requestAccess(input.scope, {
      accessTitle: accessTitle(missing),
      reason: input.reason,
      subjects: missing,
      timeoutMs: input.timeoutMs,
      clientRequestId: input.clientRequestId,
    });
    return result.status === "allowed"
      ? ({
          status: "allowed",
          asked: true,
          ...(result.scope === undefined ? {} : { scope: result.scope }),
        } as AccessGateResult)
      : ({ status: result.status, asked: true } as AccessGateResult);
  });

/** What a tool tells the agent when the card did not end in Allow. */
export function accessRefusal(status: "denied" | "cancelled" | "timed_out", title: string): string {
  switch (status) {
    case "denied":
      return `The user did not allow this (${title}). Do not try again in this turn; tell the user what you needed it for, or carry on without it.`;
    case "timed_out":
      return `The user did not answer the access request (${title}) in time. Tell the user what you need and ask again with request_access when they are back.`;
    case "cancelled":
      return `The access request (${title}) ended before the user answered.`;
  }
}
