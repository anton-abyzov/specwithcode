import {
  nativeToolRunsKind,
  type NativeConnectionsSnapshot,
  type NativeTool,
} from "@specweave-studio/contracts";

import type { CatalogEntry } from "./serverCatalog";
import { isPlaceholder, secretArgs, type ServerDraft } from "./serverPaste";

/** What stands in for a secret wherever the summary prints one. */
export const MASK = "••••";

/**
 * A value the summary shows as a masked field: every environment and header
 * value, and the argument after a secret-named flag. A header keeps its scheme
 * ("Bearer ") outside the field, so only the token is typed.
 */
export interface SecretField {
  readonly where: "env" | "header" | "arg";
  /** The variable, header or flag it belongs to. */
  readonly key: string;
  /** For an argument: its position. */
  readonly index: number;
  readonly prefix: string;
  /** Empty when the paste held a placeholder such as `YOUR_API_KEY`. */
  readonly value: string;
}

const real = (value: string) => (isPlaceholder(value) ? "" : value);

export function secretFields(draft: ServerDraft): SecretField[] {
  const { env = {}, headers = {}, args = [] } = draft.server;
  return [
    ...Object.entries(env).map(([key, value]): SecretField => ({
      where: "env",
      key,
      index: -1,
      prefix: "",
      value: real(value),
    })),
    ...Object.entries(headers).map(([key, value]): SecretField => {
      const scheme = /^(Bearer|Basic|Token)\s+/i.exec(value)?.[0] ?? "";
      return {
        where: "header",
        key,
        index: -1,
        prefix: scheme ? `${scheme.trim()} ` : "",
        value: real(value.slice(scheme.length)),
      };
    }),
    ...[...secretArgs(args)].map((index): SecretField => ({
      where: "arg",
      key: args[index - 1]!,
      index,
      prefix: "",
      value: real(args[index]!),
    })),
  ];
}

/** The draft with the fields' values in place, as it is sent to the machine. */
export function withSecrets(draft: ServerDraft, fields: ReadonlyArray<SecretField>): ServerDraft {
  const pick = (where: SecretField["where"]) =>
    Object.fromEntries(
      fields
        .filter((field) => field.where === where)
        .map((field) => [field.key, `${field.prefix}${field.value}`]),
    );
  const { command, url } = draft.server;
  if (url !== undefined) {
    const headers = pick("header");
    return {
      ...draft,
      server: { url, ...(Object.keys(headers).length ? { headers } : {}) },
    };
  }
  const args = [...(draft.server.args ?? [])];
  for (const field of fields) if (field.where === "arg") args[field.index] = field.value;
  const env = pick("env");
  return {
    ...draft,
    server: {
      command: command ?? "",
      ...(args.length ? { args } : {}),
      ...(Object.keys(env).length ? { env } : {}),
    },
  };
}

/** A program and its arguments on one line, with secret arguments masked. */
export function shownCommand(draft: ServerDraft): string {
  const args = draft.server.args ?? [];
  const secret = secretArgs(args);
  const quoted = (word: string) => (/^[A-Za-z0-9_@%+=:,./-]+$/.test(word) ? word : `'${word}'`);
  return [
    quoted(draft.server.command ?? ""),
    ...args.map((arg, index) => (secret.has(index) ? MASK : quoted(arg))),
  ].join(" ");
}

/** Codex and Claude Code, and the other AI tools installed on the machine. */
export function installedTools(snapshot: NativeConnectionsSnapshot): NativeTool[] {
  return [
    "codex",
    "claude",
    ...(snapshot.otherTools ?? [])
      .filter((inventory) => inventory.status !== "missing")
      .map((inventory) => inventory.tool),
  ];
}

/** The tools whose own user file already has a server of this name, on or off. */
export function toolsWithName(snapshot: NativeConnectionsSnapshot, name: string): NativeTool[] {
  const tools = new Set<NativeTool>();
  for (const connection of snapshot.connections)
    if (
      connection.name === name &&
      connection.scope === "user" &&
      connection.plugin === undefined &&
      connection.project === undefined
    )
      tools.add(connection.provider);
  for (const inventory of snapshot.otherTools ?? [])
    if (inventory.connections.some((connection) => connection.name === name))
      tools.add(inventory.tool);
  return [...tools];
}

/** Why a tool on the machine cannot take this server: its kind, or the name is used there. */
export type ToolBlock = "kind" | "taken";
export interface ToolChoice {
  readonly tool: NativeTool;
  readonly blocked: ToolBlock | null;
}

export function toolChoices(snapshot: NativeConnectionsSnapshot, draft: ServerDraft): ToolChoice[] {
  const taken = new Set(toolsWithName(snapshot, draft.name));
  return installedTools(snapshot).map((tool) => ({
    tool,
    blocked: !nativeToolRunsKind(tool, draft.kind) ? "kind" : taken.has(tool) ? "taken" : null,
  }));
}

/** The tools ticked to start: every one that can take it, or the ones the vendor admits. */
export function defaultTools(
  choices: ReadonlyArray<ToolChoice>,
  entry: CatalogEntry | null,
): NativeTool[] {
  return choices
    .filter((choice) => choice.blocked === null)
    .map((choice) => choice.tool)
    .filter((tool) => !entry?.tools || entry.tools.includes(tool));
}

/**
 * What one machine is asked to write. The machine refuses a whole add when one
 * ticked tool is missing there or has the name, so those tools are left out
 * before it is asked and the review says which and why.
 */
export interface MachinePlan {
  readonly tools: ReadonlyArray<NativeTool>;
  readonly dropped: ReadonlyArray<{
    readonly tool: NativeTool;
    readonly why: "missing" | ToolBlock;
  }>;
}

export function machinePlan(
  snapshot: NativeConnectionsSnapshot,
  draft: ServerDraft,
  ticked: ReadonlyArray<NativeTool>,
): MachinePlan {
  const choices = new Map(toolChoices(snapshot, draft).map((choice) => [choice.tool, choice]));
  const tools: NativeTool[] = [];
  const dropped: Array<MachinePlan["dropped"][number]> = [];
  for (const tool of ticked) {
    const choice = choices.get(tool);
    if (!choice) dropped.push({ tool, why: "missing" });
    else if (choice.blocked) dropped.push({ tool, why: choice.blocked });
    else tools.push(tool);
  }
  return { tools, dropped };
}

/** The catalog card's state: on the machine in every tool that could take it, in some, or in none. */
export function catalogPresence(
  snapshot: NativeConnectionsSnapshot,
  entry: CatalogEntry,
): "added" | "partly" | "absent" {
  const choices = toolChoices(snapshot, {
    name: entry.id,
    kind: "http",
    server: { url: entry.url },
  });
  if (!choices.some((choice) => choice.blocked === "taken")) return "absent";
  return choices.some((choice) => choice.blocked === null) ? "partly" : "added";
}

/** The command that signs a tool in to a web-address server, for the tools that have one. */
const SIGN_IN: Partial<Record<NativeTool, (name: string) => string>> = {
  claude: (name) => `claude mcp login ${name}`,
  codex: (name) => `codex mcp login ${name}`,
};

export function signInCommands(
  name: string,
  tools: ReadonlyArray<NativeTool>,
): Array<{ readonly tool: NativeTool; readonly command: string }> {
  return tools.flatMap((tool) => {
    const command = SIGN_IN[tool]?.(name);
    return command ? [{ tool, command }] : [];
  });
}

/**
 * Whether the saved server has a sign-in left to do: "browser" when its vendor
 * says so, "maybe" for a pasted address with no key, null for a program, a
 * server with a key in a header, or one that needs none.
 */
export function signInStep(
  draft: ServerDraft,
  entry: CatalogEntry | null,
): "browser" | "maybe" | null {
  if (draft.kind !== "http" || Object.keys(draft.server.headers ?? {}).length > 0) return null;
  if (entry) return entry.signIn === "browser" ? "browser" : null;
  return "maybe";
}

/** Whether another machine can take the add. Only "ready" is ever sent a preview or a write. */
export type OtherMachineState = "ready" | "offline" | "denied" | "checking" | "failed" | "old";

export function otherMachineState(input: {
  readonly connected: boolean;
  /** This sign-in may read and change files and run commands there. */
  readonly permitted: boolean;
  readonly snapshot: NativeConnectionsSnapshot | null;
  readonly failed: boolean;
}): OtherMachineState {
  if (!input.connected) return "offline";
  if (!input.permitted) return "denied";
  if (input.failed) return "failed";
  if (input.snapshot === null) return "checking";
  // A machine that predates managing servers ignores `preview` and would write at once.
  return input.snapshot.plugins === undefined ? "old" : "ready";
}

export const OTHER_MACHINE_REASON: Record<Exclude<OtherMachineState, "ready">, string> = {
  offline: "{machine} is offline",
  denied: "This sign-in cannot change files on {machine}",
  checking: "Checking {machine}…",
  failed: "{machine} could not be checked",
  old: "Update SpecWithCode on {machine} to add servers from here.",
};
