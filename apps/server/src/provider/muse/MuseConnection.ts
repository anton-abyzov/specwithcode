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
    // A spawn failure (ENOENT, EACCES) rethrows from close(). A host that starts and
    // exits only ends the handshake with "connection reached EOF"; its last stderr line
    // (the launcher's sign-in or download error) is the reason the person needs.
    await handshake.close();
    const reason =
      error instanceof Error && /does not support|timed out/i.test(error.message)
        ? undefined
        : handshake.child.stderrTail.findLast((line) => line.trim());
    throw reason ? new Error(reason, { cause: error }) : error;
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

/** One readable line: no ANSI escapes or control characters, at most 240 characters. */
function museReason(text: string): string {
  const flat = text
    // oxlint-disable-next-line no-control-regex -- strips terminal colour codes.
    .replace(/\u001b\[[0-9;?]*[A-Za-z]/g, "")
    // oxlint-disable-next-line no-control-regex -- removing control characters is the point.
    .replace(/[\u0000-\u001f\u007f]+/g, " ")
    .replace(/\s+/g, " ")
    .trim();
  const chars = Array.from(flat);
  return chars.length > 240 ? `${chars.slice(0, 239).join("")}…` : flat;
}

/**
 * A missing or unrunnable binary says so plainly; a protocol or timeout failure is shown
 * as is; any other failure carries its reason, so a working CLI elsewhere never reads
 * as "not checked".
 */
export function museCheckFailure(cause: unknown, binary = "muse"): string {
  const detail = cause instanceof Error ? cause.message : "";
  if (/does not support|timed out/i.test(detail)) return museReason(detail);
  const code = (cause as { readonly code?: unknown } | null)?.code;
  const install = "Install the official muse CLI here, sign in, then refresh Providers.";
  if (code === "ENOENT" || /\bENOENT\b/.test(detail)) {
    return binary.includes("/") || binary.includes("\\")
      ? `${binary} does not exist on this machine. ${install}`
      : `The ${binary} CLI is not installed on this machine, or not on SpecWithCode's PATH. ${install}`;
  }
  if (code === "EACCES" || /\bEACCES\b/.test(detail)) {
    return `${binary} is not executable on this machine. ${install}`;
  }
  const reason = museReason(detail).replace(/[.\s]+$/, "");
  return `Muse Code did not start on this machine.${reason ? ` ${reason}.` : ""} Sign in with muse here, then refresh Providers.`;
}
