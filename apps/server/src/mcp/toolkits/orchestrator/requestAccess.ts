import {
  type AccessRequestSubject,
  type DeviceSummary,
  FULL_DISK_ACCESS_SUBJECT_KEY,
  FULL_DISK_ACCESS_UNLOCKS,
  type PrivacyAccess,
  LOCAL_DEVICE_HOST_ID,
  OrchestratorMcpFailure,
  type OrchestratorMcpRequestAccessInput,
  type OrchestratorMcpRequestAccessResult,
} from "@specweave-studio/contracts";
import * as Effect from "effect/Effect";

import * as AccessGate from "../../../access/accessGate.ts";
import { checkPrivacyAccess } from "../../../access/privacyAccess.ts";
import * as OrchestratorMcpService from "../../OrchestratorMcpService.ts";
import * as DeviceService from "../../../device/DeviceService.ts";
import type { McpInvocationScope } from "../../McpInvocationContext.ts";
import { requireThreadScope } from "../../McpInvocationContext.ts";

const invalid = (message: string) =>
  new OrchestratorMcpFailure({ code: "invalid_request", message });

/** A device by id or by name (case-insensitive), on the host the agent named. */
export function findDevice(
  devices: ReadonlyArray<DeviceSummary>,
  wanted: { readonly deviceId: string; readonly hostId?: string | undefined },
): DeviceSummary | undefined {
  const hostId = wanted.hostId ?? LOCAL_DEVICE_HOST_ID;
  const onHost = devices.filter((device) => device.hostId === hostId);
  const needle = wanted.deviceId.trim().toLowerCase();
  return (
    onHost.find((device) => device.id === wanted.deviceId) ??
    onHost.find((device) => device.name.trim().toLowerCase() === needle)
  );
}

/** The Full Disk Access subject: what it unlocks, and which item System Settings must list. */
export function fullDiskAccessSubject(access: PrivacyAccess): AccessRequestSubject {
  const host = access.agentHost;
  return {
    kind: "permission",
    key: FULL_DISK_ACCESS_SUBJECT_KEY,
    label: "Full Disk Access",
    detail:
      host === null || host.kind === "app"
        ? `Read ${FULL_DISK_ACCESS_UNLOCKS.join(", ")}. Turn on ${host?.name ?? "SpecWithCode"} in System Settings.`
        : `Read ${FULL_DISK_ACCESS_UNLOCKS.join(", ")}. Add ${host.path} in System Settings.`,
  };
}

/**
 * A Full Disk Access ask. Already granted answers at once and off macOS there
 * is nothing to grant; otherwise the card waits until System Settings grants
 * it (allowed) or the user declines it.
 */
export const requestFullDiskAccess = (
  scope: McpInvocationScope,
  input: OrchestratorMcpRequestAccessInput,
  probe: () => Promise<PrivacyAccess> = () => checkPrivacyAccess(),
) =>
  Effect.gen(function* () {
    yield* requireThreadScope(scope, "request_access");
    const access = yield* Effect.promise(probe);
    if (access.fullDiskAccess === "not-applicable") {
      return {
        status: "not_applicable",
        allowed: [],
        note: "This machine is not a Mac: processes running as this user can already read other apps' files, so the refusal has another cause (file ownership, or a sandboxed app).",
      } satisfies OrchestratorMcpRequestAccessResult;
    }
    if (access.fullDiskAccess === "allowed") {
      return {
        status: "allowed",
        scope: "machine",
        allowed: ["Full Disk Access"],
        note: access.runningAgentsNeedRestart
          ? "Full Disk Access is on. If a read still fails in this turn, the grant came after this run started: say so, and it works in the next turn."
          : "Full Disk Access was already on.",
      } satisfies OrchestratorMcpRequestAccessResult;
    }
    const service = yield* OrchestratorMcpService.OrchestratorMcpService;
    const result = yield* service.requestAccess(scope, {
      accessTitle: "Use Full Disk Access",
      reason: input.reason,
      subjects: [fullDiskAccessSubject(access)],
      timeoutMs: input.timeoutMs,
      clientRequestId: input.clientRequestId,
      resolvedBySystem: Effect.promise(probe).pipe(
        Effect.map((next) => next.fullDiskAccess === "allowed"),
        Effect.orElseSucceed(() => false),
      ),
    });
    return {
      status: result.status,
      ...(result.status === "allowed" ? { scope: "machine" as const } : {}),
      allowed: result.status === "allowed" ? ["Full Disk Access"] : [],
      ...(result.status === "allowed"
        ? {
            note: "Full Disk Access is on for this machine. New commands you run can read the protected files; if one still fails, the user may need to restart this thread.",
          }
        : {}),
    } satisfies OrchestratorMcpRequestAccessResult;
  });

/**
 * `request_access`: resolves each app and device to what the card shows,
 * then asks once for whatever the thread may not use yet.
 */
export const requestAccess = (
  scope: McpInvocationScope,
  input: OrchestratorMcpRequestAccessInput,
) =>
  Effect.gen(function* () {
    const threadScope = yield* requireThreadScope(scope, "request_access");
    const apps = input.apps ?? [];
    const wantedDevices = input.devices ?? [];
    if (input.permission !== undefined) {
      if (apps.length > 0 || wantedDevices.length > 0) {
        return yield* invalid("Ask for a permission on its own, without apps or devices.");
      }
      return yield* requestFullDiskAccess(scope, input);
    }
    if (apps.length === 0 && wantedDevices.length === 0) {
      return yield* invalid("Name at least one app, device or permission to ask for.");
    }
    const selfApp = (name: string) =>
      invalid(
        `${name} cannot be granted: ${AccessGate.SELF_CONTROL_REFUSAL} Leave it out of apps; computer_open and computer_screenshot work on it without access.`,
      );
    const named = apps.find(AccessGate.isSpecWithCodeApp);
    if (named !== undefined) return yield* selfApp(named);
    const subjects: Array<AccessRequestSubject> = [];
    for (const app of apps) {
      const subject = yield* AccessGate.appSubject(app);
      if (AccessGate.isSpecWithCodeApp(subject.label)) return yield* selfApp(subject.label);
      subjects.push(subject);
    }
    if (wantedDevices.length > 0) {
      const devices = yield* DeviceService.DeviceService;
      const state = yield* devices.state;
      for (const wanted of wantedDevices) {
        const device = findDevice(state.devices, wanted);
        if (device === undefined) {
          return yield* invalid(
            `No device ${wanted.deviceId}${wanted.hostId === undefined ? "" : ` on host ${wanted.hostId}`}. Call device_list for current ids and names.`,
          );
        }
        subjects.push(AccessGate.deviceSubject(device));
      }
    }
    const result = yield* AccessGate.ensureAccess({
      scope: threadScope,
      subjects,
      reason: input.reason,
      timeoutMs: input.timeoutMs,
      clientRequestId: input.clientRequestId,
    });
    const labels = subjects.map((subject) => subject.label);
    return {
      status: result.status,
      ...(result.status === "allowed" && result.scope !== undefined ? { scope: result.scope } : {}),
      allowed: result.status === "allowed" ? labels : [],
      ...(result.status === "allowed" && !result.asked
        ? { note: "Everything you asked for was already allowed." }
        : {}),
    } satisfies OrchestratorMcpRequestAccessResult;
  });
