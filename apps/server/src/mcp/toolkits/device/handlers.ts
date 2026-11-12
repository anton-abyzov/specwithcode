import {
  type DeviceError,
  type DeviceHostId,
  type DeviceHostSummary,
  type DeviceId,
  type DevicePlatform,
  type DeviceSummary,
  DeviceToolUnavailableError,
  LOCAL_DEVICE_HOST_ID,
} from "@specweave-studio/contracts";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as Path from "effect/Path";
import { HostProcessPlatform } from "@specweave-studio/shared/hostProcess";
import * as ServerConfig from "../../../config.ts";
import { ensureAgentDeviceShim } from "../../../device/AgentDeviceShim.ts";
import { nodeRuntimeUnavailableMessage } from "@specweave-studio/shared/nodeRuntime";

import * as AccessGate from "../../../access/accessGate.ts";
import * as AccessRequests from "../../../access/AccessRequests.ts";
import * as DeviceService from "../../../device/DeviceService.ts";
import { iosSimulatorElsewhereHint, type NeedFit, needsFit } from "../../../fleet/launchNeeds.ts";
import { thisMachinePlatform } from "../../../fleet/thisMachinePlatform.ts";
import * as RemoteWorkers from "../../../fleet/RemoteWorkers.ts";
import * as McpInvocationContext from "../../McpInvocationContext.ts";
import * as McpToolAccess from "../../McpToolAccess.ts";
import { DeviceScreenshotToolkit, DeviceStandardToolkit, DeviceToolkit } from "./tools.ts";

/** The flags that pin every agent-device command to one device. */
export function agentDeviceTargetArgs(device: DeviceSummary): ReadonlyArray<string> {
  return device.platform === "ios"
    ? ["--platform", "ios", "--udid", device.id]
    : ["--platform", "android", "--serial", device.id];
}

/**
 * Just-in-time guidance returned from `device_open`. This is the one place
 * the agent learns how to drive the device, so it lives with the tool result
 * rather than in the always-on prompt block; threads that never open a device
 * never pay for it.
 */
export function agentDeviceQuickStart(
  device: DeviceSummary,
  targetArgs = agentDeviceTargetArgs(device),
  command = "agent-device",
): string {
  const executable = /^[a-zA-Z0-9_./:-]+$/.test(command)
    ? command
    : "'" + command.replaceAll("'", "'\"'\"'") + "'";
  const target = targetArgs
    .map((arg) =>
      /^[a-zA-Z0-9_./:-]+$/.test(arg) ? arg : "'" + arg.replaceAll("'", "'\"'\"'") + "'",
    )
    .join(" ");
  const platformNotes =
    device.platform === "ios"
      ? "First use builds an XCTest runner and can take a couple of minutes; later commands are fast."
      : "The Android snapshot helper installs itself on first use.";
  return [
    `The user is watching ${device.name} (${device.version}) in the Device panel.`,
    `Drive it with ${executable}. Use this exact executable path; login shells may reset PATH. Always pass ${target}.`,
    "Typical loop:",
    `  ${executable} open <bundle-or-package-id> ${target}     # or: open <app> <deep-link-url>`,
    `  ${executable} snapshot -i ${target}                     # accessibility tree with @eN refs`,
    `  ${executable} click @e3 ${target}`,
    `  ${executable} fill @e5 "text" ${target}`,
    `  ${executable} screenshot /tmp/shot.png ${target}        # or call device_screenshot`,
    `  ${executable} install <app> <path-to-.app-or-.apk> ${target}`,
    `Prefer snapshot refs over coordinates. Run ${executable} help for workflow guides and ${executable} <command> --help for flags.`,
    "Prefer agent-device for driving this device. simctl, adb, and xcrun remain available for anything it does not cover.",
    "For remote hosts, arrange builds, app installation, and any Metro reverse forwarding yourself. SpecWithCode provides discovery, streaming, and control only.",
    "Keep the returned --config and --session flags on every command. Other hosts can be used concurrently; opening one does not switch these commands.",
    platformNotes,
  ].join("\n");
}

const DEVICE_ACCESS_OFF =
  "Agent device access is turned off for this environment. Call device_open for the device you need, or request_access with it, and the user can allow it on a card.";

/**
 * Device tools need Agent device access, or a device the user allowed this
 * thread (or this machine) on an access request card. Listing devices needs
 * any such device; tools that act on one need that device itself.
 */
const requireDeviceAccess = Effect.gen(function* () {
  const invocation = yield* McpInvocationContext.McpInvocationContext;
  if (invocation.thread === undefined) {
    return yield* new DeviceToolUnavailableError({ reason: DEVICE_ACCESS_OFF });
  }
  const scope = invocation as McpInvocationContext.McpThreadInvocationScope;
  if (invocation.capabilities.has("device")) return scope;
  const access = yield* AccessRequests.AccessRequests;
  if (yield* access.hasAnyGrant(scope.thread.threadId, "device")) return scope;
  return yield* new DeviceToolUnavailableError({ reason: DEVICE_ACCESS_OFF });
});

/** Without Agent device access, each device a tool reaches must be allowed itself. */
const requireDeviceGrants = (
  scope: McpInvocationContext.McpThreadInvocationScope,
  targets: ReadonlyArray<{ readonly hostId: string; readonly deviceId: string }>,
) =>
  Effect.gen(function* () {
    if (scope.capabilities.has("device")) return;
    const access = yield* AccessRequests.AccessRequests;
    for (const target of targets) {
      const key = AccessGate.deviceGrantKey(target.hostId, target.deviceId);
      if (yield* access.isAllowed(scope.thread.threadId, key)) continue;
      return yield* new DeviceToolUnavailableError({
        reason: `This thread may not use device ${target.deviceId}${target.hostId === LOCAL_DEVICE_HOST_ID ? "" : ` on host ${target.hostId}`}. Call device_open for it, or request_access with it, and the user can allow it on a card.`,
      });
    }
  });

/**
 * Opening a device without Agent device access asks the user first, on an
 * access request card; an Allow lets agent tools start for that device.
 */
const requireDeviceConsent = (target: DeviceSummary) =>
  Effect.gen(function* () {
    const invocation = yield* McpInvocationContext.McpInvocationContext;
    if (invocation.thread === undefined) {
      return yield* new DeviceToolUnavailableError({ reason: DEVICE_ACCESS_OFF });
    }
    const scope = invocation as McpInvocationContext.McpThreadInvocationScope;
    if (invocation.capabilities.has("device")) return { scope, consented: false };
    const subject = AccessGate.deviceSubject(target);
    const result = yield* AccessGate.ensureAccess({
      scope,
      subjects: [subject],
      reason: `The agent wants to control ${target.name} to test the app on it.`,
      timeoutMs: AccessGate.IMPLICIT_ACCESS_TIMEOUT_MS,
    }).pipe(
      Effect.mapError(
        (error) =>
          new DeviceToolUnavailableError({
            reason: `Could not ask the user for access to ${target.name}: ${error.message}`,
          }),
      ),
    );
    if (result.status !== "allowed") {
      return yield* new DeviceToolUnavailableError({
        reason: AccessGate.accessRefusal(result.status, `Control ${target.name}`),
      });
    }
    return { scope, consented: true };
  });

const pickDevice = (
  devices: ReadonlyArray<DeviceSummary>,
  input: {
    readonly deviceId?: DeviceId | undefined;
    readonly platform?: DevicePlatform | undefined;
    readonly hostId?: DeviceHostId | undefined;
  },
): Effect.Effect<DeviceSummary, DeviceToolUnavailableError> =>
  Effect.gen(function* () {
    const hostId = input.hostId ?? LOCAL_DEVICE_HOST_ID;
    if (input.deviceId !== undefined) {
      const match = devices.find(
        (device) => device.hostId === hostId && device.id === input.deviceId,
      );
      if (match) return match;
      return yield* new DeviceToolUnavailableError({
        reason: `No device ${input.deviceId} on host ${hostId}. Call device_list for current ids.`,
      });
    }
    const candidates = devices.filter(
      (device) =>
        device.hostId === hostId &&
        (input.platform === undefined || device.platform === input.platform),
    );
    if (candidates.length === 0) {
      return yield* new DeviceToolUnavailableError({
        reason:
          input.platform === undefined
            ? "No simulators or emulators were found. Call device_list to see why."
            : `No ${input.platform} devices were found on host ${hostId}. Call device_list to see why.`,
      });
    }
    const platforms = new Set(candidates.map((device) => device.platform));
    if (input.platform === undefined && platforms.size > 1) {
      return yield* new DeviceToolUnavailableError({
        reason: "Both iOS and Android devices are available; pass platform or deviceId.",
      });
    }
    return candidates.find((device) => device.booted) ?? candidates[0]!;
  });

const toolError = (error: DeviceError | DeviceToolUnavailableError) => error;

/**
 * Whether a device tool should point to a Mac: this machine cannot run iOS
 * Simulators (the same check that places simulator work, `simulatorsHere`),
 * no device host is set up, no iOS device is listed here, and the call did not
 * ask for Android, another host or one device id (a mistyped id gets the
 * plain error).
 */
export function iosOnlyElsewhere(
  state: {
    readonly hosts: ReadonlyArray<DeviceHostSummary>;
    readonly devices: ReadonlyArray<DeviceSummary>;
  },
  input: {
    readonly deviceId?: DeviceId | undefined;
    readonly platform?: DevicePlatform | undefined;
    readonly hostId?: DeviceHostId | undefined;
  },
  simulatorsHere: NeedFit,
): boolean {
  if (simulatorsHere !== "no") return false;
  if (input.deviceId !== undefined || input.platform === "android") return false;
  if (input.hostId !== undefined && input.hostId !== LOCAL_DEVICE_HOST_ID) return false;
  if (state.hosts.some((host) => host.kind !== "local")) return false;
  return !state.devices.some(
    (device) => device.hostId === LOCAL_DEVICE_HOST_ID && device.platform === "ios",
  );
}

/** The hint for that case, naming the connected Macs that can; undefined otherwise. */
const iosElsewhere = (
  state: {
    readonly hosts: ReadonlyArray<DeviceHostSummary>;
    readonly devices: ReadonlyArray<DeviceSummary>;
  },
  input: {
    readonly deviceId?: DeviceId | undefined;
    readonly platform?: DevicePlatform | undefined;
    readonly hostId?: DeviceHostId | undefined;
  },
) =>
  Effect.gen(function* () {
    const here = needsFit(["ios_simulator"], yield* thisMachinePlatform);
    if (!iosOnlyElsewhere(state, input, here)) return undefined;
    const remote = yield* Effect.serviceOption(RemoteWorkers.RemoteWorkers);
    if (Option.isNone(remote) || !remote.value.enabled) return iosSimulatorElsewhereHint([]);
    const listed = yield* remote.value.listMachines({ projectId: undefined, probe: true }).pipe(
      Effect.timeoutOption("5 seconds"),
      Effect.map((result) => (Option.isSome(result) ? result.value.machines : [])),
      Effect.orElseSucceed(() => []),
    );
    return iosSimulatorElsewhereHint(
      listed
        .filter(
          (machine) =>
            (machine.status === "ready" || machine.status === "grant_expiring") &&
            needsFit(["ios_simulator"], machine.platform) === "yes",
        )
        .map((machine) => machine.label),
    );
  });

const handlers = {
  device_list: McpToolAccess.readsAsCaller((input) =>
    Effect.gen(function* () {
      const scope = yield* requireDeviceAccess;
      const devices = yield* DeviceService.DeviceService;
      const state = yield* devices.list;
      if (state.hostStatus === "disabled") {
        return yield* new DeviceToolUnavailableError({
          reason:
            "Device support is off. Ask the user to enable it in the Device panel before installing or starting device tools.",
        });
      }
      const hostId = input?.hostId;
      const hint = yield* iosElsewhere(state, { hostId: hostId as DeviceHostId | undefined });
      const open = state.sessions
        .filter((session) => session.threadId === scope.thread.threadId)
        .map((session) => ({ hostId: session.hostId, deviceId: session.deviceId }));
      return {
        hostStatuses: Object.fromEntries(
          Object.entries(state.hostStatuses).filter(([id]) => !hostId || id === hostId),
        ),
        hosts: hostId ? state.hosts.filter((host) => host.id === hostId) : state.hosts,
        devices: hostId
          ? state.devices.filter((device) => device.hostId === hostId)
          : state.devices,
        open,
        // Older clients ignore it; a thread here learns at list time which Macs can.
        ...(hint === undefined ? {} : { hint }),
      };
    }).pipe(Effect.mapError(toolError)),
  ),
  device_open: McpToolAccess.actsAsCaller((input) =>
    Effect.gen(function* () {
      const devices = yield* DeviceService.DeviceService;
      const state = yield* devices.list;
      if (state.hostStatus === "disabled") {
        return yield* new DeviceToolUnavailableError({
          reason:
            "Device support is off. Ask the user to enable it in the Device panel before installing or starting device tools.",
        });
      }
      const target = yield* pickDevice(state.devices, input).pipe(
        Effect.catch((error) =>
          iosElsewhere(state, input).pipe(
            Effect.flatMap((hint) =>
              Effect.fail(
                hint === undefined
                  ? error
                  : new DeviceToolUnavailableError({ reason: `${error.reason} ${hint}` }),
              ),
            ),
          ),
        ),
      );
      const { scope, consented } = yield* requireDeviceConsent(target);
      // Resolve consent and agent connectivity before booting or registering a session.
      const agentArgs = yield* devices.agentTarget({
        threadId: scope.thread.threadId,
        hostId: target.hostId,
        deviceId: target.id,
        ...(consented ? { consented: true } : {}),
      });
      const session = yield* devices.open({
        threadId: scope.thread.threadId,
        hostId: target.hostId,
        deviceId: target.id,
        platform: target.platform,
      });
      const after = yield* devices.state;
      const device =
        after.devices.find(
          (candidate) => candidate.hostId === session.hostId && candidate.id === session.deviceId,
        ) ?? target;
      const targetArgs = [...agentDeviceTargetArgs(device), ...agentArgs];
      const config = yield* ServerConfig.ServerConfig;
      const path = yield* Path.Path;
      const platform = yield* HostProcessPlatform;
      const shimDir = yield* ensureAgentDeviceShim({
        entryPath: yield* devices.agentCli,
        stateDir: config.stateDir,
      }).pipe(
        Effect.mapError(
          (error) =>
            new DeviceToolUnavailableError({
              reason:
                error._tag === "NodeRuntimeUnavailableError"
                  ? nodeRuntimeUnavailableMessage("Device automation")
                  : "Could not prepare the agent-device launcher.",
              cause: error,
            }),
        ),
      );
      const command = path.join(
        shimDir,
        platform === "win32" ? "agent-device.cmd" : "agent-device",
      );
      return {
        device,
        agentDevice: { command, targetArgs },
        quickStart: agentDeviceQuickStart(device, targetArgs, command),
      };
    }).pipe(Effect.mapError(toolError)),
  ),
  device_screenshot: McpToolAccess.readsAsCaller((input) =>
    Effect.gen(function* () {
      const scope = yield* requireDeviceAccess;
      const devices = yield* DeviceService.DeviceService;
      const sessions = yield* devices.sessionsForThread(scope.thread.threadId);
      const target =
        input.deviceId !== undefined
          ? { hostId: input.hostId ?? LOCAL_DEVICE_HOST_ID, deviceId: input.deviceId }
          : sessions
              .filter((session) => input.hostId === undefined || session.hostId === input.hostId)
              .at(-1);
      if (!target) {
        return yield* new DeviceToolUnavailableError({
          reason: "No device is open in this thread. Call device_open first.",
        });
      }
      yield* requireDeviceGrants(scope, [target]);
      const shot = yield* devices.screenshot(target);
      return {
        device: shot.device,
        screenshot: {
          mimeType: "image/png" as const,
          data: Buffer.from(shot.png).toString("base64"),
          ...pngDimensions(shot.png),
        },
      };
    }).pipe(Effect.mapError(toolError)),
  ),
  device_close: McpToolAccess.actsAsCaller((input) =>
    Effect.gen(function* () {
      const scope = yield* requireDeviceAccess;
      const devices = yield* DeviceService.DeviceService;
      const closing = (yield* devices.sessionsForThread(scope.thread.threadId)).filter(
        (session) =>
          (input.hostId === undefined || session.hostId === input.hostId) &&
          (input.deviceId === undefined || session.deviceId === input.deviceId),
      );
      yield* requireDeviceGrants(scope, closing);
      yield* devices.close({
        threadId: scope.thread.threadId,
        ...(input.hostId === undefined ? {} : { hostId: input.hostId }),
        ...(input.deviceId === undefined ? {} : { deviceId: input.deviceId }),
        ...(input.shutdown === undefined ? {} : { shutdown: input.shutdown }),
      });
      return {};
    }).pipe(Effect.mapError(toolError)),
  ),
} satisfies McpToolAccess.Handlers<typeof DeviceToolkit.tools>;

/** Width and height from the IHDR chunk; a PNG that lacks one reports 0×0. */
export function pngDimensions(png: Uint8Array): { width: number; height: number } {
  if (png.length < 24) return { width: 0, height: 0 };
  const view = new DataView(png.buffer, png.byteOffset, png.byteLength);
  const isPng =
    view.getUint32(0) === 0x89504e47 &&
    view.getUint32(4) === 0x0d0a1a0a &&
    view.getUint32(12) === 0x49484452;
  return isPng
    ? { width: view.getUint32(16), height: view.getUint32(20) }
    : { width: 0, height: 0 };
}

const { device_screenshot, ...standardHandlers } = handlers;

export const layerStandard = McpToolAccess.toWorkerLayer(DeviceStandardToolkit, standardHandlers);

export const layerScreenshot = McpToolAccess.toWorkerLayer(DeviceScreenshotToolkit, {
  device_screenshot,
});
