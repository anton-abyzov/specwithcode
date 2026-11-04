import {
  type AccessRequestSubject,
  type DeviceSummary,
  LOCAL_DEVICE_HOST_ID,
  OrchestratorMcpFailure,
  type OrchestratorMcpRequestAccessInput,
  type OrchestratorMcpRequestAccessResult,
} from "@specweave-studio/contracts";
import * as Effect from "effect/Effect";

import * as AccessGate from "../../../access/accessGate.ts";
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
    if (apps.length === 0 && wantedDevices.length === 0) {
      return yield* invalid("Name at least one app or device to ask for.");
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
