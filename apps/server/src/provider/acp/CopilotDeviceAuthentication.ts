import * as NodeUtil from "node:util";
import type { AcpRegistrySettings } from "@specweave-studio/contracts";

/** This compatibility path belongs to GitHub's registry agent, never a lookalike method. */
export const isCopilotDeviceLogin = (settings: AcpRegistrySettings, methodId: string): boolean =>
  settings.source !== "local" &&
  settings.agentId === "github-copilot-cli" &&
  methodId === "copilot-login";

/** The oldest Copilot CLI whose device-flow and browser-override contract was verified. */
export const COPILOT_DEVICE_LOGIN_MIN_VERSION = "1.0.95";

const SIGN_IN_AGAIN = "then sign in again.";

/** Copilot CLI is an npm package: without Node.js it can be neither installed nor run. */
export const copilotNodeMissingMessage = (): string =>
  "Copilot CLI runs on Node.js, which this machine does not have. SpecWithCode can install it: use Install Node.js in Settings > Machines or in first-run setup, " +
  SIGN_IN_AGAIN;

export const copilotCliNotInstalledMessage = (): string =>
  "Copilot CLI is not installed or not prepared on this machine. Use Install / update agent for GitHub Copilot in Settings > Providers, " +
  SIGN_IN_AGAIN;

export const copilotLoginUnrecognizedMessage = (): string =>
  "This Copilot CLI offers a sign-in command SpecWithCode does not recognize. Use Install / update agent for GitHub Copilot in Settings > Providers, " +
  SIGN_IN_AGAIN;

/** The version found (if any) and whether `login --help` lists `--device-code`. */
export function copilotCliTooOldMessage(found: string | undefined, hasDeviceCode: boolean): string {
  const needed = `${COPILOT_DEVICE_LOGIN_MIN_VERSION} or newer`;
  const update = `Use Install / update agent for GitHub Copilot in Settings > Providers to update it, ${SIGN_IN_AGAIN}`;
  if (found === undefined)
    return `Could not read which Copilot CLI version is installed. Sign-in needs Copilot CLI ${needed}. ${update}`;
  const major = Number(/^(\d+)\./u.exec(found)?.[1]);
  if (major > 1)
    return `Copilot CLI ${found} is newer than this SpecWithCode supports for sign-in (1.x, ${needed}). Update SpecWithCode, ${SIGN_IN_AGAIN}`;
  if (supportsCopilotDeviceLogin(found, "--device-code") && !hasDeviceCode)
    return `Copilot CLI ${found} does not offer device-code sign-in, which sign-in needs (Copilot CLI ${needed}). ${update}`;
  return `Copilot CLI ${found} is too old: sign-in needs Copilot CLI ${needed}. ${update}`;
}

export type CopilotNoAnswerReason =
  | { readonly kind: "timeout" }
  | { readonly kind: "exit"; readonly code: number }
  | { readonly kind: "truncated" }
  | { readonly kind: "unreadable" };

/** A check that started but did not give a usable answer; retrying can help. */
export function copilotCliNoAnswerMessage(
  reason: CopilotNoAnswerReason,
  program: "Copilot CLI" | "Node.js" = "Copilot CLI",
): string {
  const what =
    reason.kind === "timeout"
      ? `${program} did not answer within 10 seconds`
      : reason.kind === "exit"
        ? `${program} exited with code ${reason.code}`
        : reason.kind === "truncated"
          ? `${program} printed more output than expected`
          : `${program}'s answer could not be read`;
  return `${what} while SpecWithCode checked it before sign-in. Retry sign-in; if it keeps failing, use Install / update agent for GitHub Copilot in Settings > Providers.`;
}

/** An npm shim that cannot find Node.js (`env: node: No such file…`, `'node' is not recognized…`). */
export function copilotOutputShowsNodeMissing(exitCode: number, output: string): boolean {
  return (
    exitCode === 127 ||
    /(?:env: ['"\u2018]?node['"\u2019]?: No such file|'node' is not recognized|\bnode: (?:command )?not found)/iu.test(
      output,
    )
  );
}

/** Reads `X.Y.Z` from `copilot --version` output. */
export const readCopilotVersion = (output: string): string | undefined =>
  /(?:^|\s)(\d+\.\d+\.\d+)(?:\s|$)/u.exec(output)?.[1];

/**
 * Starts device sign-in against the one enterprise host found among this
 * machine's gh sign-ins, when Copilot's `login --help` lists `--host` and the
 * agent did not choose a host itself.
 */
export function withCopilotLoginHost(
  args: ReadonlyArray<string>,
  help: string,
  host: string | undefined,
): ReadonlyArray<string> {
  if (
    host === undefined ||
    !/(?:^|\s)--host(?:[\s=,]|$)/u.test(help) ||
    args.some((arg) => arg === "--host" || arg.startsWith("--host="))
  )
    return args;
  const at = args.indexOf("--device-code");
  return at < 0
    ? [...args, "--host", host]
    : [...args.slice(0, at), "--host", host, ...args.slice(at)];
}

/** 1.0.95 is the first locally verified device-flow/browser-override contract. */
export function supportsCopilotDeviceLogin(version: string, help: string): boolean {
  const match = /^(\d+)\.(\d+)\.(\d+)$/u.exec(version);
  if (!match) return false;
  const [major, minor, patch] = match.slice(1).map(Number);
  return (
    major === 1 &&
    (minor! > 0 || (minor === 0 && patch! >= 95)) &&
    /(?:^|\s)--device-code(?:\s|$)/u.test(help)
  );
}

export function copilotDeviceLoginArgs(
  args: ReadonlyArray<string>,
): ReadonlyArray<string> | undefined {
  if (args.filter((arg) => arg === "login").length !== 1 || args.includes("--acp"))
    return undefined;
  return [
    ...args.filter((arg) => arg !== "--web-flow" && arg !== "--device-code"),
    "--device-code",
  ];
}

/** Native Copilot appends the URL to this argv. No shell, browser, or network is involved. */
export const copilotBrowserNoopArgs = ["--eval", "process.exit(0)", "--"] as const;
export const copilotBrowserOverride = (nodeExecutable: string): string =>
  JSON.stringify([nodeExecutable, ...copilotBrowserNoopArgs]);

function configuredHost(args: ReadonlyArray<string>): string | undefined {
  const index = args.indexOf("--host");
  const host =
    index >= 0 ? args[index + 1] : args.find((arg) => arg.startsWith("--host="))?.slice(7);
  if (host === undefined) return "github.com";
  try {
    const url = new URL(host.includes("://") ? host : `https://${host}`);
    return url.protocol === "https:" &&
      !url.username &&
      !url.password &&
      !url.port &&
      url.pathname === "/" &&
      !url.search &&
      !url.hash
      ? url.hostname
      : undefined;
  } catch {
    return undefined;
  }
}

/** Parse only the owned CLI's complete device prompt; never infer a code from arbitrary output. */
export function readCopilotDeviceCode(
  transcript: string,
  args: ReadonlyArray<string>,
): { readonly url: string; readonly userCode: string } | undefined {
  const host = configuredHost(args);
  if (!host) return undefined;
  const text = NodeUtil.stripVTControlCharacters(transcript.slice(-16_384));
  const matches = text.matchAll(
    /(?:^|\n)To authenticate, visit (https:\/\/\S{1,2048}) and enter code ([A-Z0-9]{4}-[A-Z0-9]{4})(?:\r?\n|$)/gu,
  );
  let result: { url: string; userCode: string } | undefined;
  for (const match of matches) {
    try {
      const url = new URL(match[1]!);
      if (
        url.protocol !== "https:" ||
        url.hostname !== host ||
        url.port ||
        url.username ||
        url.password ||
        url.pathname !== "/login/device" ||
        url.search ||
        url.hash
      )
        continue;
      result = { url: url.href, userCode: match[2]! };
    } catch {
      /* Unrecognized output stays available in the native terminal. */
    }
  }
  return result;
}
