import * as Data from "effect/Data";
import * as Effect from "effect/Effect";
import { spawnMspConnection, MuseClient, readSessionDurability } from "@muse-code/sdk";
import type { MuseSettings } from "@specweave-studio/contracts";
/** Own only the host this call spawns; never attach to or terminate an external session host. */
export async function connectMuse(settings: MuseSettings, env: NodeJS.ProcessEnv, cwd: string) {
  const handshake = spawnMspConnection({
    command: settings.binaryPath || "muse",
    args: ["serve"],
    cwd,
    env,
    shutdownTimeoutMs: 2_000,
  });
  const timeout = new AbortController();
  try {
    const host = await Promise.race([
      handshake.initialize({
        clientInfo: { name: "specwithcode", version: "1.0.0" },
        // sessionMcp: this client may attach native MCP servers to a
        // session at start/resume. Hosts that cannot grant it simply do
        // not echo it in grantedCapabilities, and sessions fall back to
        // the terminal environment, as before.
        capabilities: { userInputDialogs: false, requestedCapabilities: ["sessionMcp"] },
      }),
      Effect.runPromise(Effect.sleep(10_000), { signal: timeout.signal }).then(() => {
        throw new Error("Muse Code handshake timed out");
      }),
    ]);
    if (!museProtocolSupported(host)) {
      await host.close();
      throw new Error(
        `Muse Code ${host.initializeResult.serverInfo.version} speaks a protocol this SpecWithCode build does not support. Update SpecWithCode, then refresh Providers.`,
      );
    }
    const client = new MuseClient(host.connection, {
      durability: readSessionDurability(host.initializeResult),
      host,
    });
    return { host, client };
  } catch (error) {
    await handshake.close();
    throw error;
  } finally {
    timeout.abort();
  }
}

/** The MSP envelope schema version this integration speaks (SDK `SchemaInfo.version`). */
const MUSE_ENVELOPE_SCHEMA_VERSION = 1;

/**
 * A schema fingerprint that differs from the SDK pin is a warning, not a refusal:
 * the SDK documents it as additive-optional evolution, and the muse launcher
 * updates itself hourly, so every Muse release moves the fingerprint. Only a
 * different envelope schema version is a protocol this build cannot speak.
 */
export function museProtocolSupported(host: {
  readonly fingerprintWarning?: unknown;
  readonly initializeResult: { readonly schema?: { readonly version?: unknown } };
}): boolean {
  if (!host.fingerprintWarning) return true;
  return Number(host.initializeResult.schema?.version) === MUSE_ENVELOPE_SCHEMA_VERSION;
}

/** Whether this host granted native per-session MCP servers at handshake. */
export function museSessionMcpGranted(host: {
  readonly initializeResult: { readonly grantedCapabilities?: ReadonlyArray<unknown> };
}): boolean {
  return host.initializeResult.grantedCapabilities?.includes("sessionMcp") === true;
}

/** Discovery/control RPCs must not leave Refresh Providers or model selection hanging. */
export async function museControl<T>(
  operation: Promise<T>,
  close: () => Promise<void>,
  timeoutMs = 10_000,
): Promise<T> {
  const timeout = new AbortController();
  try {
    return await Promise.race([
      operation,
      Effect.runPromise(Effect.sleep(timeoutMs), { signal: timeout.signal }).then(() => {
        void close();
        throw new Error("Muse Code control request timed out");
      }),
    ]);
  } finally {
    timeout.abort();
  }
}

/** A failed Muse availability probe, carrying the person-facing check message. */
export class MuseCheckError extends Data.TaggedError("MuseCheckError")<{
  readonly detail: string;
  readonly cause?: unknown;
}> {}

/** A missing binary keeps the install hint; a protocol or timeout failure must not read as one. */
export function museCheckFailure(cause: unknown): string {
  const detail = cause instanceof Error ? cause.message : "";
  if (/does not support|timed out/i.test(detail)) return detail;
  return "Muse Code could not be checked. Install the official muse CLI, sign in, then refresh Providers.";
}
