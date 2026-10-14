import type { FoldedItem } from "@muse-code/sdk";
import type { AcpParsedSessionEvent } from "../acp/AcpRuntimeModel.ts";
/** Folded snapshots may repeat; emit only each item's new text suffix. */
export function museItemEvents(
  item: FoldedItem,
  texts: Map<string, string>,
  completed: Set<string>,
): AcpParsedSessionEvent[] {
  const events: AcpParsedSessionEvent[] = [];
  if (item.kind === "agentMessage" || item.kind === "reasoning") {
    const text =
      item.kind === "reasoning" ? item.summary?.join("\n") || item.text || "" : (item.text ?? "");
    const before = texts.get(item.itemId) ?? "";
    if (!texts.has(item.itemId) && item.kind === "agentMessage")
      events.push({ _tag: "AssistantItemStarted", itemId: item.itemId });
    if (before.startsWith(text) && before !== text) return events;
    if (!text.startsWith(before))
      throw new Error("Muse Code revised already-streamed text; refresh the native session.");
    const delta = text.slice(before.length);
    if (delta)
      events.push(
        item.kind === "reasoning"
          ? { _tag: "ThoughtDelta", text: delta, rawPayload: item }
          : { _tag: "ContentDelta", itemId: item.itemId, text: delta, rawPayload: item },
      );
    texts.set(item.itemId, text);
    if (
      item.status === "completed" &&
      item.kind === "agentMessage" &&
      !completed.has(item.itemId)
    ) {
      completed.add(item.itemId);
      events.push({ _tag: "AssistantItemCompleted", itemId: item.itemId });
    }
  } else if (item.kind !== "userMessage") {
    events.push({
      _tag: "ToolCallUpdated",
      toolCall: {
        toolCallId: item.itemId,
        title: item.tool ?? String(item.kind),
        status:
          item.status === "inProgress"
            ? "inProgress"
            : item.status === "completed"
              ? "completed"
              : "failed",
        detail: item.visibleOutput ?? item.fallbackText ?? item.failureReason ?? item.text ?? "",
        data: { ...item },
      },
      rawPayload: item,
    });
  }
  return events;
}
