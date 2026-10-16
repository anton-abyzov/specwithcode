import { stripVTControlCharacters } from "node:util";
import type { AcpRegistrySettings } from "@specweave-studio/contracts";

/** This compatibility path belongs to GitHub's registry agent, never a lookalike method. */
export const isCopilotDeviceLogin = (settings: AcpRegistrySettings, methodId: string): boolean =>
  settings.source !== "local" &&
  settings.agentId === "github-copilot-cli" &&
  methodId === "copilot-login";

export const COPILOT_DEVICE_LOGIN_UPDATE_MESSAGE =
  "Device sign-in requires a compatible Copilot CLI 1.x (1.0.95 or newer), device-code support and a working local Node.js runtime. Update Copilot or SpecWithCode on this environment, then retry device sign-in.";

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
  const text = stripVTControlCharacters(transcript.slice(-16_384));
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
