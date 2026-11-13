/**
 * This machine's hardware identity for SpecWithCode Connect. A machine that
 * loses its local state (a reinstall, a reset, a wiped home folder) comes back
 * with a new environment id; the relay uses this identity to replace the
 * account's older record for the same machine instead of listing it twice.
 *
 * Only a SHA-256 hash leaves the machine, never the raw hardware id. The hash
 * also covers the resolved home folder, so separate homes on one computer (a
 * managed fleet identity, an explicit STUDIO_HOME, a dev home) stay separate
 * machines. Linux and Windows ids are copied with a cloned disk or image, so
 * there it also covers the host name, and a container sends none at all.
 * What is sent is salted with the account's user id
 * ({@link accountHardwareIdentity}), so it never matches across accounts.
 */
import { HostProcessHostname, HostProcessPlatform } from "@specweave-studio/shared/hostProcess";
import * as Context from "effect/Context";
import * as Crypto from "effect/Crypto";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Ref from "effect/Ref";

import * as ServerConfig from "../config.ts";
import * as ProcessRunner from "../processRunner.ts";

export class MachineHardwareIdentity extends Context.Service<
  MachineHardwareIdentity,
  {
    /** The hex hash, or null when this machine has no readable hardware id. */
    readonly get: Effect.Effect<string | null>;
    /** What a link sends: the hash salted with the account's user id, or null. */
    readonly forAccount: (userId: string) => Effect.Effect<string | null>;
  }
>()("specweave-studio/cloud/MachineHardwareIdentity") {}

const LINUX_MACHINE_ID_PATHS = ["/etc/machine-id", "/var/lib/dbus/machine-id"];
/** Containers usually share their image's machine id, so they get no identity. */
const LINUX_CONTAINER_MARKERS = ["/.dockerenv", "/run/.containerenv"];

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
    /** Only where the hardware id survives a cloned disk (Linux, Windows). */
    readonly hostname?: string | undefined;
  }) {
    return yield* sha256Hex(
      [
        "specwithcode-connect-machine-v1",
        input.platform,
        input.hardwareId.toLowerCase(),
        input.home,
        ...(input.hostname === undefined ? [] : [input.hostname.toLowerCase()]),
      ].join("\n"),
    );
  },
);

/** The form a link or the link watch sends: salted with the account's user id. */
export const accountHardwareIdentity = Effect.fn("cloud.machineHardwareIdentity.forAccount")(
  function* (machineHash: string, userId: string) {
    return yield* sha256Hex(`specwithcode-connect-account-v1\n${userId}\n${machineHash}`);
  },
);

const sha256Hex = Effect.fn("cloud.machineHardwareIdentity.sha256")(function* (text: string) {
  const crypto = yield* Crypto.Crypto;
  const digest = yield* crypto.digest("SHA-256", new TextEncoder().encode(text));
  return Array.from(digest, (byte) => byte.toString(16).padStart(2, "0")).join("");
});

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
      for (const marker of LINUX_CONTAINER_MARKERS) {
        if (yield* fileSystem.exists(marker).pipe(Effect.orElseSucceed(() => false))) return null;
      }
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
  const hostname = yield* HostProcessHostname;
  const serverConfig = yield* ServerConfig.ServerConfig;
  const fileSystem = yield* FileSystem.FileSystem;
  const processRunner = yield* ProcessRunner.ProcessRunner;
  const crypto = yield* Crypto.Crypto;

  const compute = Effect.gen(function* () {
    const hardwareId = yield* readRawHardwareId(platform);
    if (hardwareId === null) return null;
    // Only the resolved folder is stable across runs (symlinks, /var vs
    // /private/var); without it there is no identity this time.
    const home = yield* fileSystem.realPath(serverConfig.baseDir);
    const clonable = platform === "linux" || platform === "win32";
    const host = hostname.trim();
    if (clonable && host.length === 0) return null;
    return yield* hashMachineHardwareIdentity({
      platform,
      hardwareId,
      home,
      ...(clonable ? { hostname: host } : {}),
    });
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

  // Keep only a found identity: a miss (folder not there yet) is tried again.
  const found = yield* Ref.make<string | null>(null);
  const get = Effect.gen(function* () {
    const known = yield* Ref.get(found);
    if (known !== null) return known;
    const value = yield* compute;
    if (value !== null) yield* Ref.set(found, value);
    return value;
  });
  const forAccount = (userId: string) =>
    Effect.gen(function* () {
      const machineHash = yield* get;
      return machineHash === null ? null : yield* accountHardwareIdentity(machineHash, userId);
    }).pipe(
      Effect.provideService(Crypto.Crypto, crypto),
      Effect.orElseSucceed(() => null),
    );
  return MachineHardwareIdentity.of({ get, forAccount });
});

export const layer = Layer.effect(MachineHardwareIdentity, make).pipe(
  Layer.provide(ProcessRunner.layer),
);

/** A fixed identity for tests, used as is for every account; null means none. */
export const layerTest = (value: string | null) =>
  Layer.succeed(
    MachineHardwareIdentity,
    MachineHardwareIdentity.of({
      get: Effect.succeed(value),
      forAccount: () => Effect.succeed(value),
    }),
  );
