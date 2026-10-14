import { sha256 } from "../../nodeCrypto.ts";
import { ProjectConnectionConfig, type ProjectConnectionTool } from "@specweave-studio/contracts";
import * as Schema from "effect/Schema";

export const connectionFingerprint = (value: unknown) => sha256([JSON.stringify(value)], "hex");
const secretShape =
  /(?:sk-[a-zA-Z0-9_-]{16,}|gh[pousr]_[a-zA-Z0-9]{20,}|github_pat_[a-zA-Z0-9_]{20,}|Bearer\s+\S+|-----BEGIN [A-Z ]*PRIVATE KEY-----)/gi;
const secretFlag =
  /^--?(?:api[-_]?key|access[-_]?token|token|secret|password|authorization)(?:=|$)/i;
/** A path with a separator that is neither absolute nor a bare program name found on PATH. */
function isRelativePath(command: string): boolean {
  if (command.startsWith("/") || /^[A-Z]:[\\/]/i.test(command)) return false;
  return /[\\/]/.test(command);
}
export function validConnectionConfig(value: unknown): value is ProjectConnectionConfig {
  if (!Schema.is(ProjectConnectionConfig)(value)) return false;
  if (
    /\s/.test(value.command) &&
    !value.command.startsWith("/") &&
    !/^[A-Z]:[\\/]/i.test(value.command)
  )
    return false;
  if (/[\0\r\n]/.test(value.command) || value.command.startsWith("-")) return false;
  // The server runs unsandboxed in the project folder, which agents can write. A relative command
  // or script path would let an agent replace what runs on the next check or call.
  if (isRelativePath(value.command) || value.args.some((arg) => /^\.\.?[\\/]/.test(arg)))
    return false;
  if (value.envKeys.some((key) => !/^[A-Z_][A-Z0-9_]*$/.test(key))) return false;
  return ![value.name, value.command, ...value.args].some((part) => {
    secretShape.lastIndex = 0;
    if (/[\0\r\n]/.test(part) || secretShape.test(part) || secretFlag.test(part)) return true;
    const urlValue = part.replace(/^--?[a-zA-Z0-9_-]+=/, "");
    if (/^https?:\/\//i.test(urlValue)) {
      try {
        const url = new URL(urlValue);
        return !!(url.username || url.password || url.search || url.hash);
      } catch {
        return true;
      }
    }
    return false;
  });
}
/** Environment values never appear in config, tool descriptions, receipts or client errors. */
export function redactConnectionText(text: string, envKeys: readonly string[]): string {
  let result = text;
  for (const key of envKeys) {
    const value = process.env[key];
    if (value) result = result.split(value).join("[redacted]");
  }
  return result.replace(secretShape, "[redacted]");
}
export function toolFingerprint(tool: ProjectConnectionTool): string {
  return connectionFingerprint(tool);
}

/** Redact decoded leaves before JSON serialization, including escaped credential characters. */
export function redactConnectionValue(value: unknown, envKeys: readonly string[]): unknown {
  if (typeof value === "string") return redactConnectionText(value, envKeys);
  if (Array.isArray(value)) return value.map((item) => redactConnectionValue(item, envKeys));
  if (value && typeof value === "object")
    return Object.fromEntries(
      Object.entries(value).map(([key, item]) => [
        redactConnectionText(key, envKeys),
        redactConnectionValue(item, envKeys),
      ]),
    );
  return value;
}
