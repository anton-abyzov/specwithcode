import type * as AcpSchema from "@specweave-studio/effect-acp/compat";

interface LegacyTerminalAuthentication {
  readonly command: string;
  readonly args: ReadonlyArray<string>;
}

/** Copilot 1.0.94 advertises terminal login through this pre-standard ACP extension. */
function legacyTerminalAuthentication(
  method: AcpSchema.AuthMethod,
): LegacyTerminalAuthentication | undefined {
  if (method.type !== undefined) return undefined;
  const value = method._meta?.["terminal-auth"];
  if (typeof value !== "object" || value === null || Array.isArray(value)) return undefined;
  const { command, args } = value as Record<string, unknown>;
  if (
    typeof command !== "string" ||
    command.length > 4_096 ||
    !/^(?:\/|[A-Za-z]:[\\/]|\\\\)/u.test(command) ||
    /[\0\r\n]/u.test(command) ||
    !Array.isArray(args) ||
    args.length > 32 ||
    !args.every((arg) => typeof arg === "string" && arg.length <= 2_048 && !arg.includes("\0"))
  )
    return undefined;
  return { command, args };
}

/** Normalization changes the interaction type only; login still requires an explicit user action. */
export function normalizeAcpTerminalAuthMethod(method: AcpSchema.AuthMethod): AcpSchema.AuthMethod {
  return legacyTerminalAuthentication(method) === undefined
    ? method
    : { ...method, type: "terminal", args: [] };
}

export function acpTerminalAuthInvocation(
  method: AcpSchema.AuthMethod,
  spawn: { readonly command: string; readonly args: ReadonlyArray<string> },
): LegacyTerminalAuthentication | undefined {
  const legacy = legacyTerminalAuthentication(method);
  if (legacy !== undefined) {
    // Preserve the prepared CLI version during its separate login invocation.
    return method.id === "copilot-login" && spawn.args.includes("--no-auto-update")
      ? { ...legacy, args: ["--no-auto-update", ...legacy.args] }
      : legacy;
  }
  return method.type === "terminal"
    ? { command: spawn.command, args: [...spawn.args, ...(method.args ?? [])] }
    : undefined;
}
