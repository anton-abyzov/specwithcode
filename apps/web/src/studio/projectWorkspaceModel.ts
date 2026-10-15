import type { EnvironmentThreadShell } from "@specweave-studio/client-runtime/state/shell";
import { threadRuntimeIsActive } from "@specweave-studio/client-runtime/state/shell";
import type { ProjectId, ThreadId } from "@specweave-studio/contracts";
import { resolveSidebarThreadStatus } from "../components/Sidebar.logic";
import { isAgentOwnedProjectThread } from "./projectPaneThreads";
import { isProjectCoordinatorThread } from "./projectCoordinatorThreads";
import {
  formatStudioThreadHref,
  formatStudioThreadLink,
  parseStudioThreadHref,
  resolveStudioThreadLink,
  studioThreadLinkLabel,
} from "./studioThreadLinks";

export const PROJECT_THREAD_GROUPS = ["Waiting on you", "Working", "Idle", "Resolved"] as const;
export type ProjectThreadGroup = (typeof PROJECT_THREAD_GROUPS)[number];

/** Attention and lifecycle remain independent in storage; grouping is only a view. */
/**
 * What a quiet thread's last report says stops the work, while the thread is
 * neither running nor resolved: the question it is blocked on.
 */
export function threadBlocker(thread: EnvironmentThreadShell): string | null {
  if (!thread.reportedBlocker || thread.archivedAt !== null) return null;
  if (thread.settledOverride === "settled" || threadRuntimeIsActive(thread.runtime)) return null;
  return thread.reportedBlocker;
}

export function projectThreadGroup(thread: EnvironmentThreadShell): ProjectThreadGroup {
  if (thread.archivedAt !== null) return "Resolved";
  const status = resolveSidebarThreadStatus(thread);
  if (thread.hasPendingApprovals || thread.hasPendingUserInput || thread.hasActionableProposedPlan)
    return "Waiting on you";
  if (threadRuntimeIsActive(thread.runtime)) return "Working";
  if (thread.settledOverride === "settled") return "Resolved";
  if (threadBlocker(thread) !== null) return "Waiting on you";
  if (status === "limited" || status === "failed") return "Waiting on you";
  return "Idle";
}

/**
 * When a thread last took on work: created, asked something, or started a turn.
 * A running turn bumps updatedAt with every streamed item, so sorting by it
 * reshuffles a list of busy threads several times a second.
 */
export function threadActivityAt(
  thread: Pick<EnvironmentThreadShell, "createdAt" | "latestRun" | "latestUserMessageAt">,
): string {
  let latest = thread.createdAt;
  for (const at of [thread.latestRun?.requestedAt ?? null, thread.latestUserMessageAt])
    if (at !== null && Date.parse(at) > Date.parse(latest)) latest = at;
  return latest;
}

export function projectThreads(
  threads: readonly EnvironmentThreadShell[],
  environmentId: string,
  projectId: ProjectId,
  coordinatorId: ThreadId | null,
) {
  const byId = new Map(
    threads.filter((t) => t.environmentId === environmentId).map((t) => [t.id as string, t]),
  );
  return threads
    .filter(
      (t) =>
        t.environmentId === environmentId &&
        t.projectId === projectId &&
        t.deletedAt === null &&
        isAgentOwnedProjectThread(t, coordinatorId, (id) => byId.get(id)) &&
        // The coordinator is the main conversation, and a previous one is history:
        // neither is one of the project's threads.
        !isProjectCoordinatorThread(t.id, { projectId, coordinatorThreadId: coordinatorId }),
    )
    .sort(
      (a, b) =>
        PROJECT_THREAD_GROUPS.indexOf(projectThreadGroup(a)) -
          PROJECT_THREAD_GROUPS.indexOf(projectThreadGroup(b)) ||
        Date.parse(threadActivityAt(b)) - Date.parse(threadActivityAt(a)) ||
        a.id.localeCompare(b.id),
    );
}

/**
 * Only explicit links to this project's actual threads become navigation controls.
 * Native IDs may contain colons or percent-encoded characters (a delegated task's
 * ID carries `command%3A…`), so the link may name the ID encoded once, as the
 * server builds it, or pasted raw; membership in this project's supplied thread
 * set is the navigation authority.
 */
export function projectThreadReference(
  href: string,
  threads: readonly Pick<EnvironmentThreadShell, "id">[],
): ThreadId | null {
  const candidates = parseStudioThreadHref(href);
  if (candidates === null) return null;
  for (const candidate of candidates) {
    const match = threads.find((t) => t.id === candidate);
    if (match) return match.id;
  }
  return null;
}

/**
 * One Markdown link to a thread, or an internal delegated-task ID in prose. Both
 * alternatives sit in one pattern so an ID inside a link's href is never
 * rewritten a second time.
 */
const PROJECT_THREAD_TOKEN =
  /\[([^\]\n]+)\]\((studio:\/\/thread\/[^)\n]+)\)|`?\b(?:node|thread):delegated-task:([A-Za-z0-9%_~-]+(?:\.[A-Za-z0-9%_~-]+)*)`?/g;

/**
 * Coordinator text as the project page renders it. A link to one of this
 * project's threads is rewritten to the canonical `studio://thread/<encoded id>`
 * whichever form the agent wrote (encoded ID, raw ID, or the thread's title);
 * any other thread link is kept as written, so it still renders as a chip that
 * opens the thread elsewhere or says why it cannot. A delegated task's internal
 * node or thread ID becomes a link to the worker it names.
 */
export function prepareProjectMarkdown(
  text: string,
  threads: readonly Pick<EnvironmentThreadShell, "id" | "title">[],
  /** Every thread a link could name, live or deleted (see resolveStudioThreadLink). */
  known: readonly Pick<EnvironmentThreadShell, "id" | "title" | "deletedAt">[] = [],
): string {
  return text.replace(
    PROJECT_THREAD_TOKEN,
    (original, label: string | undefined, href: string | undefined, commandId?: string) => {
      if (label !== undefined && href !== undefined) {
        const candidates = parseStudioThreadHref(href);
        if (candidates === null) return original;
        const resolved = resolveStudioThreadLink(threads, candidates, label, null, known);
        if (resolved.kind === "thread") return `[${label}](${formatStudioThreadHref(resolved.id)})`;
        // A title written as the target is not a valid Markdown link until encoded.
        return /\s/.test(href) ? `[${label}](${formatStudioThreadHref(candidates[0]!)})` : original;
      }
      const worker = threads.find((t) => t.id === `thread:delegated-task:${commandId}`);
      if (!worker) return original;
      return formatStudioThreadLink(worker.id, studioThreadLinkLabel(worker.title, "worker"));
    },
  );
}

export function projectAdmissionReason(
  settings: { paused: boolean; archived: boolean } | null,
  connected: boolean,
  canOperate: boolean,
): string | null {
  if (!connected) return "Reconnect this host to send a message.";
  if (!canOperate) return "This connection has read-only access.";
  if (!settings) return "Project settings are still loading.";
  if (settings.archived) return "Unarchive the project to start new work.";
  if (settings.paused) return "Resume the project to start new work.";
  return null;
}

type ReceiptStorage = Pick<Storage, "getItem" | "setItem" | "removeItem">;
type ReceiptPersistence = { storage: ReceiptStorage; key: string };

/** A tab retains uncertain sends across reloads, scoped to one host and project. */
export function createScopedProjectSendReceipt(
  environmentId: string,
  projectId: string,
  purpose: "message" | "routine" = "message",
) {
  let storage: Storage | undefined;
  try {
    storage = typeof window === "undefined" ? undefined : window.sessionStorage;
  } catch {
    /* Browser privacy settings may disable storage. */
  }
  return createProjectSendReceipt(
    storage
      ? {
          storage,
          key:
            purpose === "message"
              ? `studio.project-send.v1:${encodeURIComponent(environmentId)}:${encodeURIComponent(projectId)}`
              : `studio.project-routine.v1:${encodeURIComponent(environmentId)}:${encodeURIComponent(projectId)}`,
        }
      : undefined,
  );
}

/** Retry an uncertain response with the same ID; remove only a confirmed receipt. */
const MAX_PROJECT_SEND_RECEIPT_CHARS = 2_000_000;
export function createProjectSendReceipt(persistence?: ReceiptPersistence) {
  const pending = new Map<string, string>();
  let restorationFailed = false;
  try {
    const raw = persistence?.storage.getItem(persistence.key);
    if (raw !== undefined && raw !== null && raw.length > MAX_PROJECT_SEND_RECEIPT_CHARS)
      restorationFailed = true;
    else if (raw !== undefined && raw !== null) {
      const data: unknown = JSON.parse(raw);
      if (
        typeof data === "object" &&
        data !== null &&
        "version" in data &&
        data.version === 1 &&
        "pending" in data &&
        Array.isArray(data.pending)
      ) {
        for (const entry of data.pending) {
          if (
            Array.isArray(entry) &&
            entry.length === 2 &&
            typeof entry[0] === "string" &&
            typeof entry[1] === "string" &&
            /^[A-Za-z0-9_-]{1,128}$/.test(entry[1])
          )
            pending.set(entry[0], entry[1]);
          else restorationFailed = true;
        }
      } else restorationFailed = true;
    }
  } catch {
    restorationFailed = true;
    /* Corrupt or unavailable storage must not break the workspace. */
  }
  function persist(requireDurable = false) {
    // Best-effort sends stay in memory; never destroy an unreadable accepted-command record.
    if (restorationFailed) return;
    const unavailable = () =>
      new Error(
        "Retry needs browser session storage to preserve its command identity. Your original message and files are preserved.",
      );
    if (!persistence) {
      if (requireDurable) throw unavailable();
      return;
    }
    const saved = pending.size ? JSON.stringify({ version: 1, pending: [...pending] }) : null;
    if (saved !== null && saved.length > MAX_PROJECT_SEND_RECEIPT_CHARS) {
      if (requireDurable)
        throw new Error(
          "Retry command history is full. Review coordinator history before retrying. Your original message and files are preserved.",
        );
      return;
    }
    try {
      if (saved !== null) {
        persistence.storage.setItem(persistence.key, saved);
        if (requireDurable && persistence.storage.getItem(persistence.key) !== saved)
          throw unavailable();
      } else persistence.storage.removeItem(persistence.key);
    } catch {
      if (requireDurable) throw unavailable();
      /* Keep the in-memory receipt if the browser rejects storage. */
    }
  }
  return {
    forPrompt(key: string, allocate: () => string, requireDurable = false) {
      if (requireDurable && restorationFailed)
        throw new Error(
          "The saved retry command receipt cannot be restored safely. Review coordinator history before retrying. Your original message and files are preserved.",
        );
      const existing = pending.get(key);
      if (existing) {
        if (requireDurable) persist(true);
        return existing;
      }
      const commandId = allocate();
      pending.set(key, commandId);
      persist(requireDurable);
      return commandId;
    },
    acknowledge(commandId: string) {
      for (const [key, id] of pending) if (id === commandId) pending.delete(key);
      persist();
    },
  };
}
