/**
 * This machine's hardware identity for SpecWithCode Connect. A machine that
 * loses its local state (a reinstall, a reset, a wiped home folder) comes back
 * with a new environment id; the relay uses this identity to replace the
 * account's older record for the same machine instead of listing it twice.
 *
 * Only a SHA-256 hash leaves the machine, never the raw hardware id. The hash
 * also covers the resolved home folder, so separate homes on one computer (a
 * managed fleet identity, an explicit STUDIO_HOME, a dev home) stay separate
 * machines. The relay salts it again with the account's user id.
 */
import { HostProcessPlatform } from "@specweave-studio/shared/hostProcess";
import * as Context from "effect/Context";
import * as Crypto from "effect/Crypto";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";

import * as ServerConfig from "../config.ts";
import * as ProcessRunner from "../processRunner.ts";

export class MachineHardwareIdentity extends Context.Service<
  MachineHardwareIdentity,
  {
    /** The hex hash, or null when this machine has no readable hardware id. */
    readonly get: Effect.Effect<string | null>;
  }
>()("specweave-studio/cloud/MachineHardwareIdentity") {}

const LINUX_MACHINE_ID_PATHS = ["/etc/machine-id", "/var/lib/dbus/machine-id"];

/** `ioreg -rd1 -c IOPlatformExpertDevice` prints `"IOPlatformUUID" = "…"`. */
export function parseIoregPlatformUuid(stdout: string): string | null {
  const match = stdout.match(/"IOPlatformUUID"\s*=\s*"([0-9A-Fa-f-]{32,36})"/);
  return match?.[1] ?? null;
}

/** `reg query HKLM\SOFTWARE\Microsoft\Cryptography /v MachineGuid` prints `MachineGuid REG_SZ …`. */
export function parseWindowsMachineGuid(stdout: string): string | null {
  const match = stdout.match(/MachineGuid\s+REG_SZ\s+([0-9A-Fa-f-]{32,36})/);
  return match?.[1] ?? null;
}

/** A systemd machine id: 32 hex characters, not all zero, not "uninitialized". */
export function normalizeLinuxMachineId(text: string): string | null {
  const value = text.trim().toLowerCase();
  return /^[0-9a-f]{32}$/.test(value) && !/^0+$/.test(value) ? value : null;
}

export const hashMachineHardwareIdentity = Effect.fn("cloud.machineHardwareIdentity.hash")(
  function* (input: {
    readonly platform: string;
    readonly hardwareId: string;
    readonly home: string;
  }) {
    const crypto = yield* Crypto.Crypto;
    const digest = yield* crypto.digest(
      "SHA-256",
      new TextEncoder().encode(
        `specwithcode-connect-machine-v1\n${input.platform}\n${input.hardwareId.toLowerCase()}\n${input.home}`,
      ),
    );
    return Array.from(digest, (byte) => byte.toString(16).padStart(2, "0")).join("");
  },
);

const runProbe = Effect.fn("cloud.machineHardwareIdentity.probe")(function* (
  command: string,
  args: ReadonlyArray<string>,
) {
  const processRunner = yield* ProcessRunner.ProcessRunner;
  return yield* processRunner
    .run({ command, args, timeout: "5 seconds", timeoutBehavior: "timedOutResult" })
    .pipe(
      Effect.map((result) => (result.code === 0 ? result.stdout : null)),
      Effect.orElseSucceed(() => null),
    );
});

const readRawHardwareId = Effect.fn("cloud.machineHardwareIdentity.readRaw")(function* (
  platform: NodeJS.Platform,
) {
  const fileSystem = yield* FileSystem.FileSystem;
  switch (platform) {
    case "darwin": {
      const stdout = yield* runProbe("ioreg", ["-rd1", "-c", "IOPlatformExpertDevice"]);
      return stdout === null ? null : parseIoregPlatformUuid(stdout);
    }
    case "win32": {
      const stdout = yield* runProbe("reg", [
        "query",
        "HKLM\\SOFTWARE\\Microsoft\\Cryptography",
        "/v",
        "MachineGuid",
        "/reg:64",
      ]);
      return stdout === null ? null : parseWindowsMachineGuid(stdout);
    }
    case "linux": {
      for (const path of LINUX_MACHINE_ID_PATHS) {
        const text = yield* fileSystem.readFileString(path).pipe(Effect.orElseSucceed(() => null));
        const value = text === null ? null : normalizeLinuxMachineId(text);
        if (value !== null) return value;
      }
      return null;
    }
    default:
      return null;
  }
});

export const make = Effect.gen(function* () {
  const platform = yield* HostProcessPlatform;
  const serverConfig = yield* ServerConfig.ServerConfig;
  const fileSystem = yield* FileSystem.FileSystem;
  const processRunner = yield* ProcessRunner.ProcessRunner;
  const crypto = yield* Crypto.Crypto;

  const compute = Effect.gen(function* () {
    const hardwareId = yield* readRawHardwareId(platform);
    if (hardwareId === null) return null;
    const home = yield* fileSystem
      .realPath(serverConfig.baseDir)
      .pipe(Effect.orElseSucceed(() => serverConfig.baseDir));
    return yield* hashMachineHardwareIdentity({ platform, hardwareId, home });
  }).pipe(
    Effect.provideService(FileSystem.FileSystem, fileSystem),
    Effect.provideService(ProcessRunner.ProcessRunner, processRunner),
    Effect.provideService(Crypto.Crypto, crypto),
    Effect.catchCause((cause) =>
      Effect.logDebug("Could not read this machine's hardware identity", { cause }).pipe(
        Effect.as(null),
      ),
    ),
  );

  return MachineHardwareIdentity.of({ get: yield* Effect.cached(compute) });
});

export const layer = Layer.effect(MachineHardwareIdentity, make).pipe(
  Layer.provide(ProcessRunner.layer),
);

/** A fixed identity for tests; null means the machine has none. */
export const layerTest = (value: string | null) =>
  Layer.succeed(
    MachineHardwareIdentity,
    MachineHardwareIdentity.of({ get: Effect.succeed(value) }),
  );
