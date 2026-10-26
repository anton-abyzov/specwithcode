/**
 * A device host is a machine with simulators or emulators on it. The service
 * layer only ever talks to this interface, so a future SSH or cloud host slots
 * in beside `LocalDeviceHost` without touching discovery, the proxy, or the
 * MCP tools.
 *
 * Every ready host presents a loopback origin where expo-device-hub answers.
 * Hosts add an agent-device daemon endpoint only after agent access is granted.
 * For the local host both run on this machine; a remote host would forward
 * them here.
 */
import type {
  DeviceBootError,
  DeviceHostId,
  DeviceHostSummary,
  DeviceOperationError,
  DevicePlatform,
  DevicePlatformAvailability,
  DeviceSummary,
} from "@specweave-studio/contracts";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";
import type { NodeRuntimeUnavailableError } from "@specweave-studio/shared/nodeRuntime";

export class DeviceHostError extends Schema.TaggedError<DeviceHostError>()("DeviceHostError", {
  hostId: Schema.String,
  step: Schema.String,
  cause: Schema.Defect(),
}) {
  override get message(): string {
    return `Device host ${this.hostId} failed while ${this.step}.`;
  }
}

export class DeviceHostTimeoutError extends Schema.TaggedError<DeviceHostTimeoutError>()(
  "DeviceHostTimeoutError",
  { hostId: Schema.String, timeoutMs: Schema.Number },
) {
  override get message(): string {
    return `Device host ${this.hostId} did not start agent tools within ${this.timeoutMs} ms.`;
  }
}

export class AgentDeviceStartError extends Schema.TaggedError<AgentDeviceStartError>()(
  "AgentDeviceStartError",
  {
    hostId: Schema.String,
    stateDir: Schema.String,
    exitCode: Schema.NullOr(Schema.Int),
    reason: Schema.Literals([
      "daemon_lock_not_directory",
      "daemon_registration_unproven",
      "daemon_retirement_unconfirmed",
      "command_failed",
    ]),
    cause: Schema.Defect(),
  },
) {
  override get message(): string {
    const exit = this.exitCode === null ? "" : ` (exit code ${this.exitCode})`;
    const detail =
      this.reason === "daemon_lock_not_directory"
        ? "Daemon registration ownership could not be verified: daemon.lock is not a directory."
        : this.reason === "daemon_registration_unproven"
          ? "Daemon registration ownership could not be verified."
          : this.reason === "daemon_retirement_unconfirmed"
            ? "Daemon replacement could not be confirmed."
            : "The AgentDevice startup command failed.";
    const recovery =
      this.reason === "command_failed"
        ? `Inspect daemon diagnostics in ${this.stateDir}.`
        : `Inspect daemon.lock and daemon diagnostics in ${this.stateDir}. Stop older clients and daemons with their original CLI before manually repairing retained state.`;
    return `Agent tools failed to start${exit}. ${detail} ${recovery}`;
  }
}

export interface DeviceHubEndpoint {
  /** Loopback origin of expo-device-hub, e.g. `http://127.0.0.1:3400`. */
  readonly origin: string;
}

export interface AgentDeviceEndpoint {
  readonly baseUrl: string;
  readonly token: string;
  /** Host-local path of the agent-device entry script. The provider uses a separate local CLI install. */
  readonly entryPath: string;
}

export type HostDevice = Omit<DeviceSummary, "hostId">;

/** Discovery and lifecycle for the devices a ready host can run. */
export interface DeviceOperations {
  readonly list: Effect.Effect<
    {
      readonly devices: ReadonlyArray<HostDevice>;
      readonly detail: string | undefined;
      /** Some Android virtual devices could not be listed; the rest are. */
      readonly androidDiscoveryIncomplete?: boolean;
    },
    DeviceOperationError
  >;
  /**
   * Boots the device and prepares its stream. Android AVDs change id when they
   * boot (AVD name to emulator serial), so the returned id is authoritative.
   */
  readonly boot: (
    device: HostDevice,
  ) => Effect.Effect<string, DeviceOperationError | DeviceBootError>;
  /** Prepares the stream of a device that is already booted. */
  readonly attach: (device: HostDevice) => Effect.Effect<void, DeviceOperationError>;
  readonly shutdown: (device: {
    readonly id: string;
    readonly platform: DevicePlatform;
  }) => Effect.Effect<void, DeviceOperationError>;
  readonly screenshot: (device: HostDevice) => Effect.Effect<Uint8Array, DeviceOperationError>;
}

export interface DeviceHostReady {
  readonly nodePath: string;
  readonly hub: DeviceHubEndpoint;
  readonly devices: DeviceOperations;
  /**
   * Runs a host command (`xcrun`, `adb`, or a helper bundled with the hub)
   * where the devices live. On the local host this is a plain spawn; a
   * remote host would run it over its transport.
   */
  readonly run: (
    command: string,
    args: ReadonlyArray<string>,
    options?: { readonly timeoutMs?: number; readonly stdin?: string },
  ) => Effect.Effect<{ readonly stdout: string; readonly stderr: string; readonly code: number }>;
  /** Absolute paths of helper binaries vendored with the hub, when present. */
  readonly helpers: {
    readonly serveSimAxSettings: string | null;
    readonly serveSimCli: string | null;
  };
}

export interface DeviceHostAgentReady extends DeviceHostReady {
  readonly agentDevice: AgentDeviceEndpoint;
}

export class DeviceHost extends Context.Service<
  DeviceHost,
  {
    readonly id: DeviceHostId;
    readonly summary: Effect.Effect<DeviceHostSummary>;
    readonly inspect?: Effect.Effect<DeviceHostSummary, DeviceHostError>;
    readonly platformAvailability: (
      platform: DevicePlatform,
    ) => Effect.Effect<DevicePlatformAvailability>;
    /**
     * Installs tools on first use and starts the helper processes. Idempotent:
     * concurrent callers share one start, and a ready host returns immediately.
     */
    readonly ensureReady: (
      onPhase: (phase: "installing" | "starting", detail?: string) => Effect.Effect<void>,
    ) => Effect.Effect<DeviceHostReady, DeviceHostError | NodeRuntimeUnavailableError>;
    /** Installs and starts agent-device after the user grants agent access. */
    readonly ensureAgentReady: (
      onPhase: (phase: "installing" | "starting", detail?: string) => Effect.Effect<void>,
    ) => Effect.Effect<
      DeviceHostAgentReady,
      DeviceHostError | DeviceHostTimeoutError | AgentDeviceStartError | NodeRuntimeUnavailableError
    >;
    /** Current endpoints when already running, without starting anything. */
    readonly current: Effect.Effect<DeviceHostReady | null>;
    /** Stops only agent-device. Manual viewing through the hub stays available. */
    readonly stopAgent: Effect.Effect<void>;
    /** Stops helpers. Devices themselves keep running; the user owns those. */
    readonly stop: Effect.Effect<void>;
  }
>()("specweave-studio/device/DeviceHost") {}
