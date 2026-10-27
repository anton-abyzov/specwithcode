import type { FoldedItem } from "@muse-code/sdk";
import type * as Acp from "@specweave-studio/effect-acp/compat";

/** What one turn already sent to SpecWithCode; folded snapshots repeat, so only new text goes out. */
interface MuseTurnProjection {
  readonly texts: Map<string, string>;
  /** The last update sent per tool call, so a repeated snapshot sends nothing. */
  readonly tools: Map<string, string>;
  /** An assistant message or a tool call reached the thread. */
  replied: boolean;
}

export const museTurnProjection = (): MuseTurnProjection => ({
  texts: new Map(),
  tools: new Map(),
  replied: false,
});

/** The prompt is already on the thread, and reminder children are Muse's own background agents. */
const HIDDEN_KINDS = new Set(["userMessage", "reminderChild"]);

const parseJson = (value: string | undefined): unknown => {
  if (value === undefined) return undefined;
  try {
    return JSON.parse(value);
  } catch {
    return undefined;
  }
};

const record = (value: unknown): Record<string, unknown> | undefined =>
  value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;

function toolKind(name: string, input: Record<string, unknown> | undefined): Acp.ToolKind {
  if (/bash|shell|exec|command/i.test(name) || typeof input?.command === "string") return "execute";
  if (/edit|write|patch|create/i.test(name)) return "edit";
  if (/read|view|cat/i.test(name)) return "read";
  if (/grep|glob|search|find|list/i.test(name)) return "search";
  if (/fetch|web/i.test(name)) return "fetch";
  return "other";
}

function toolStatus(status: string): Acp.ToolCallStatus {
  if (status === "inProgress") return "in_progress";
  if (status === "completed") return "completed";
  if (status === "cancelled") return "cancelled";
  return "failed";
}

/** A Muse tool argument string as the permission card and command item read it. */
export function museToolInput(args: string | undefined): unknown {
  return parseJson(args) ?? args;
}

export function museToolKind(name: string, args: string | undefined): Acp.ToolKind {
  return toolKind(name, record(parseJson(args)));
}

function museToolCall(item: FoldedItem): Acp.ToolCallUpdate & { readonly title: string } {
  const output =
    parseJson(item.visibleOutput) ??
    item.visibleOutput ??
    item.failureReason ??
    (item.status === "inProgress" ? undefined : item.fallbackText);
  const base = {
    toolCallId: item.itemId,
    status: toolStatus(String(item.status)),
    ...(output === undefined ? {} : { rawOutput: output }),
  };
  if (item.kind === "toolCall") {
    const name = item.tool ?? "Tool";
    const input = museToolInput(item.args);
    const command = record(input)?.command;
    const kind = museToolKind(name, item.args);
    return {
      ...base,
      name,
      kind,
      title: kind === "execute" && typeof command === "string" ? command : name,
      ...(input === undefined ? {} : { rawInput: input }),
    };
  }
  if (item.kind === "userShell") {
    return {
      ...base,
      kind: "execute",
      title: item.commandText ?? "Shell command",
      rawInput: { command: item.commandText ?? "" },
      rawOutput: {
        output: item.visibleOutput ?? "",
        ...(item.exitCode === undefined ? {} : { exitCode: item.exitCode }),
      },
    };
  }
  // MSP asks clients to show kinds they do not know by name, status and fallback text.
  return {
    ...base,
    kind: "other",
    title: item.fallbackText ?? String(item.kind),
    rawInput: { kind: item.kind },
  };
}

/** Map one folded Muse item to the ACP session updates SpecWithCode projects into turn items. */
export function museItemUpdates(item: FoldedItem, state: MuseTurnProjection): Acp.SessionUpdate[] {
  if (HIDDEN_KINDS.has(String(item.kind))) return [];
  if (item.kind === "agentMessage" || item.kind === "reasoning") {
    const text =
      item.kind === "reasoning" ? item.summary?.join("\n") || item.text || "" : (item.text ?? "");
    const before = state.texts.get(item.itemId) ?? "";
    if (before.startsWith(text)) return [];
    if (!text.startsWith(before))
      throw new Error("Muse Code revised already-streamed text; refresh the native session.");
    state.texts.set(item.itemId, text);
    const content = { type: "text" as const, text: text.slice(before.length) };
    if (item.kind === "reasoning")
      return [{ sessionUpdate: "agent_thought_chunk", messageId: item.itemId, content }];
    state.replied = true;
    return [{ sessionUpdate: "agent_message_chunk", messageId: item.itemId, content }];
  }
  const call = museToolCall(item);
  const previous = state.tools.get(item.itemId);
  const signature = JSON.stringify(call);
  if (previous === signature) return [];
  const opened = previous !== undefined;
  state.tools.set(item.itemId, signature);
  state.replied = true;
  return [
    opened
      ? { ...call, sessionUpdate: "tool_call_update" }
      : { ...call, sessionUpdate: "tool_call" },
  ];
}
