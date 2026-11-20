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
        `Muse Code ${host.initializeResult.serverInfo.version} speaks a protocol this SpecWithCode build does not support. Update SpecWithCode.`,
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
 * Why a check of Muse Code failed, which decides what the row offers:
 * `missing` and `broken` lead to the install step, `signedOut` to a sign-in,
 * and `protocol` and `unknown` to nothing the person can run.
 */
export type MuseFailureKind = "missing" | "broken" | "signedOut" | "protocol" | "unknown";

export interface MuseFailure {
  readonly kind: MuseFailureKind;
  /** One cause and at most one next step. */
  readonly message: string;
}

const MUSE_INSTALL_AGAIN = "Run the Muse Code installer again.";

/**
 * Reads a failed check into one cause and at most one next step. The launcher
 * script names its own trouble on its last line ("muse: installed binary is
 * missing; rerun the installer"); that line is the cause, and what it asks for
 * becomes the one step, said once.
 */
export function museFailure(cause: unknown, binary = "muse"): MuseFailure {
  const detail = cause instanceof Error ? cause.message : "";
  if (/does not support/i.test(detail)) return { kind: "protocol", message: museReason(detail) };
  if (/timed out/i.test(detail)) return { kind: "unknown", message: museReason(detail) };
  const code = (cause as { readonly code?: unknown } | null)?.code;
  const named = binary.includes("/") || binary.includes("\\");
  if (code === "ENOENT" || /\bENOENT\b/.test(detail)) {
    return {
      kind: "missing",
      message: named
        ? `${binary} does not exist on this machine. Install Muse Code, or correct the binary path in its settings.`
        : "Muse Code is not installed on this machine. Install it with its installer.",
    };
  }
  if (code === "EACCES" || /\bEACCES\b/.test(detail)) {
    return {
      kind: "broken",
      message: `${binary} is there, but this machine may not run it. ${MUSE_INSTALL_AGAIN}`,
    };
  }
  // The launcher's own line, without its name in front.
  const reason = museReason(detail)
    .replace(/^muse:\s*/i, "")
    .replace(/[.\s]+$/, "");
  if (/\bnot (?:logged|signed) in\b|\bmuse login\b/i.test(reason)) {
    return {
      kind: "signedOut",
      message: "Muse Code is not signed in. Run `muse login` in a terminal on this machine.",
    };
  }
  const reinstall = /^(.*?)[;,.]?\s*(?:please\s+)?re-?run the installer\b.*$/i.exec(reason);
  if (reinstall) {
    const why = (reinstall[1] ?? "").trim();
    const said = /^installed binary is missing$/i.test(why)
      ? "its installed binary is missing"
      : why;
    return {
      kind: "broken",
      message: said
        ? `Muse Code could not start: ${said}. ${MUSE_INSTALL_AGAIN}`
        : `Muse Code could not start. ${MUSE_INSTALL_AGAIN}`,
    };
  }
  return {
    kind: "unknown",
    message: reason
      ? `Muse Code could not start: ${reason}.`
      : "Muse Code could not start and gave no reason. Run `muse` in a terminal on this machine to see why.",
  };
}

/** The message of {@link museFailure}. */
export function museCheckFailure(cause: unknown, binary = "muse"): string {
  return museFailure(cause, binary).message;
}
