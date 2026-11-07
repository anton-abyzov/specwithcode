/** Structured event provenance. Titles are labels, never navigation targets. */
export type CoordinatorReplySource =
  | {
      readonly kind: "thread";
      readonly threadId: string;
      readonly environmentId: string;
      readonly title?: string | undefined;
    }
  | { readonly kind: "pull_request"; readonly url: string; readonly title: string }
  | { readonly kind: "event"; readonly title: string };

type StoredSource =
  | Exclude<CoordinatorReplySource, { kind: "thread" }>
  | {
      readonly kind: "thread";
      readonly threadId: string;
      readonly environmentId?: string | undefined;
      readonly title?: string | undefined;
    };

export type CoordinatorSourceMessage = {
  readonly id: string;
  readonly role: string;
  readonly runId: string | null;
  readonly senderThreadId?: string | undefined;
  readonly notification?:
    | {
        readonly source: { readonly kind: string; readonly childThreadId?: string | undefined };
        readonly replySources?: readonly StoredSource[] | undefined;
      }
    | undefined;
};

/** Compact labels for persisted or foreign event metadata. */
export function coordinatorSourceTitle(title: string | undefined): string | undefined {
  const first = title?.trim().split(/\r?\n/)[0]?.trim();
  if (!first) return undefined;
  return first.length > 80 ? `${first.slice(0, 79)}…` : first;
}

/** Only HTTP(S) PR URLs may leave the app; credentials and executable schemes are refused. */
function safePullRequestUrl(raw: string): string | null {
  try {
    const url = new URL(raw);
    return (url.protocol === "https:" || url.protocol === "http:") && !url.username && !url.password
      ? url.href
      : null;
  } catch {
    return null;
  }
}

/** Join retained triggers to replies by their persisted run, never by transcript adjacency. */
export function coordinatorReplySources(
  messages: readonly CoordinatorSourceMessage[],
  environmentId: string,
  viewingThreadId?: string,
): ReadonlyMap<string, readonly CoordinatorReplySource[]> {
  const byRun = new Map<string, Map<string, CoordinatorReplySource>>();
  for (const message of messages) {
    if (!message.runId || message.role === "assistant") continue;
    const candidates: StoredSource[] = [...(message.notification?.replySources ?? [])];
    const threadId = message.senderThreadId ?? message.notification?.source.childThreadId;
    if (
      threadId &&
      !candidates.some((source) => source.kind === "thread" && source.threadId === threadId)
    )
      candidates.push({ kind: "thread", threadId });
    // Old monitor events have no trusted URL or thread. Keep a truthful non-link label.
    if (candidates.length === 0 && message.notification?.source.kind === "monitor")
      candidates.push({ kind: "event", title: "Monitor update" });
    const sources = byRun.get(message.runId) ?? new Map<string, CoordinatorReplySource>();
    for (const candidate of candidates) {
      let source: CoordinatorReplySource;
      let key: string;
      if (candidate.kind === "thread") {
        if (!candidate.threadId.trim()) continue;
        // The event recipient is not its source; preserve same-ID remote threads.
        if (
          candidate.threadId === viewingThreadId &&
          (candidate.environmentId ?? environmentId) === environmentId
        )
          continue;
        const title = coordinatorSourceTitle(candidate.title);
        source = {
          kind: "thread",
          threadId: candidate.threadId,
          environmentId: candidate.environmentId ?? environmentId,
          ...(title === undefined ? {} : { title }),
        };
        key = JSON.stringify(["thread", source.environmentId, source.threadId]);
      } else if (candidate.kind === "pull_request") {
        const url = safePullRequestUrl(candidate.url);
        const title = coordinatorSourceTitle(candidate.title) ?? "Pull request";
        source = url === null ? { kind: "event", title } : { ...candidate, url, title };
        key = JSON.stringify([source.kind, url ?? candidate.title]);
      } else {
        source = { ...candidate, title: coordinatorSourceTitle(candidate.title) ?? "Event update" };
        key = JSON.stringify(["event", source.title]);
      }
      // A title-bearing producer wins over the legacy bare sender reference.
      if (!sources.has(key) || (source.kind === "thread" && source.title)) sources.set(key, source);
    }
    if (sources.size) byRun.set(message.runId, sources);
  }
  const result = new Map<string, readonly CoordinatorReplySource[]>();
  for (const message of messages) {
    if (message.role !== "assistant" || !message.runId) continue;
    const sources = byRun.get(message.runId);
    if (sources?.size) result.set(message.id, [...sources.values()]);
  }
  return result;
}
