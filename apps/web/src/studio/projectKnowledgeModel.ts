import {
  PROJECT_KNOWLEDGE_FILE_BYTES,
  type ProjectKnowledgeIndexState,
  type ProjectKnowledgeSearchResult,
  type ProjectKnowledgeSkipped,
  type ProjectKnowledgeStatus,
} from "@specweave-studio/contracts";
import { formatCount } from "@specweave-studio/shared/usageFormat";

/** How often the card asks again while the index builds. */
export const KNOWLEDGE_POLL_MS = 1_500;
/**
 * Recent Claude tokenizers average about 2.5 bytes per token and older ones
 * about 3.5, so a third of the characters is the estimate shown, as "about".
 */
const CHARACTERS_PER_TOKEN = 3;

function oneDecimal(value: number): string {
  return value >= 9.95 ? formatCount(value) : value.toFixed(1).replace(/\.0$/, "");
}

/** A rounded token estimate, such as `330`, `6.4K`, `40K` or `1.2M`. */
function compactTokens(characters: number): string {
  const tokens = characters / CHARACTERS_PER_TOKEN;
  if (tokens >= 999_500) return `${oneDecimal(tokens / 1e6)}M`;
  if (tokens >= 999.5) return `${oneDecimal(tokens / 1e3)}K`;
  return formatCount(tokens < 100 ? tokens : Math.round(tokens / 10) * 10);
}

export function knowledgeTokens(characters: number): string {
  return `about ${compactTokens(characters)} tokens`;
}

function plural(count: number, one: string, many = `${one}s`): string {
  return `${formatCount(count)} ${count === 1 ? one : many}`;
}

/** The first build failed, so there is no index at all yet. */
function neverBuilt(status: ProjectKnowledgeStatus): boolean {
  return status.state === "failed" && status.indexedAt === null;
}

/** What the mode means for the project's threads, in a sentence or two. */
export function knowledgeModeText(status: ProjectKnowledgeStatus): {
  readonly title: string;
  readonly detail: string;
} {
  if (neverBuilt(status))
    return {
      title: "Index not built",
      detail: status.problem ?? "The knowledge index could not be built. Rebuild it to try again.",
    };
  switch (status.mode) {
    case "empty":
      return {
        title: "Nothing to index yet",
        detail:
          "Memory files, hub artifacts and the Library folders (docs, reports and increments) are indexed as they appear.",
      };
    case "inline":
      return {
        title: "Memory sent in full",
        detail:
          "Memory files and hub artifacts fit, so Claude and Codex worker threads receive them in full. Library folders are searched when a thread needs them. The coordinator receives a short catalog only.",
      };
    case "search":
      return {
        title: "Search mode",
        detail:
          "Worker threads search all project knowledge and read the passages they need. The coordinator receives a short catalog only.",
      };
  }
}

/** How much of a limit is used; a limit the host did not report counts as unused. */
function shareOf(used: number, limit: number): number {
  return limit > 0 ? used / limit : 0;
}

/** The fuller of the two index limits: size on disk or number of documents, as the host reports them. */
export function knowledgeCapacity(status: ProjectKnowledgeStatus): {
  readonly share: number;
  readonly tone: "ok" | "warn" | "full";
  readonly label: string;
} {
  const share = Math.min(
    1,
    Math.max(
      shareOf(status.bytes, status.capacityBytes),
      shareOf(status.documents, status.capacityDocuments),
    ),
  );
  const tone = status.skipped.overCapacity > 0 ? "full" : share >= 0.8 ? "warn" : "ok";
  const percent = share > 0 && share < 0.01 ? "under 1%" : `${Math.round(share * 100)}%`;
  return {
    share,
    tone,
    label: `${plural(status.documents, "document")}, ${knowledgeTokens(status.characters)}. The index is ${percent} full.`,
  };
}

/**
 * Where the inline measure stands against the allowance. Search mode starts past the
 * allowance and ends only below the lower mark, so in between the measure can sit under
 * the allowance while threads still search.
 */
export function knowledgeAllowanceText(status: ProjectKnowledgeStatus): string {
  const used = knowledgeTokens(status.inlineCharacters);
  const limit = compactTokens(status.inlineLimit);
  if (status.mode !== "search")
    return `Memory files and hub artifacts: ${used} of the ${limit} threads receive in full.`;
  const lower = compactTokens(status.inlineReturnLimit);
  if (status.inlineCharacters === 0)
    return "There are no memory files or hub artifacts to send in full, so threads search the Library.";
  if (status.inlineCharacters > status.inlineLimit)
    return `Memory files and hub artifacts come to ${used}, past the ${limit} threads receive in full. Below ${lower} they are sent in full again.`;
  return `Memory files and hub artifacts come to ${used}. Threads keep searching until they fall below ${lower}, so edits near the limit do not switch back and forth.`;
}

export function knowledgeSkippedText(skipped: ProjectKnowledgeSkipped): string | null {
  const parts = [
    skipped.tooLarge > 0
      ? `${formatCount(skipped.tooLarge)} over ${PROJECT_KNOWLEDGE_FILE_BYTES / 1_048_576} MB`
      : null,
    skipped.overCapacity > 0
      ? `${formatCount(skipped.overCapacity)} past the index capacity`
      : null,
    skipped.unreadable > 0 ? `${formatCount(skipped.unreadable)} unreadable or protected` : null,
  ].filter((part) => part !== null);
  if (parts.length === 0) return null;
  const total = skipped.tooLarge + skipped.overCapacity + skipped.unreadable;
  return `${plural(total, "file")} left out: ${parts.join(", ")}.`;
}

/** `Indexed 5m ago.`, `Indexing…`, or `Not indexed yet.`, then the problem the last refresh hit. */
export function knowledgeStateText(
  status: ProjectKnowledgeStatus,
  formatAgo: (at: number) => string,
): string {
  if (status.state === "indexing") return "Indexing…";
  const at = status.indexedAt === null ? Number.NaN : Date.parse(status.indexedAt);
  const indexed =
    status.state === "unindexed" || Number.isNaN(at)
      ? "Not indexed yet."
      : `Indexed ${formatAgo(at)}.`;
  return status.state === "failed" && status.problem ? `${indexed} ${status.problem}` : indexed;
}

/** Why a search may have missed passages: the index it read is not complete yet. */
function searchCaveat(state: ProjectKnowledgeIndexState): string | null {
  switch (state) {
    case "ready":
      return null;
    case "failed":
      return "The index could not be updated, so results may be incomplete.";
    case "indexing":
    case "unindexed":
      return "The index is still being built, so results may be incomplete.";
  }
}

/**
 * What a search found: `note` is the line shown above its passages (null when the
 * passages speak for themselves), `summary` the short line a screen reader hears.
 * A search of an index that is not complete never claims that nothing matches at all.
 */
export function knowledgeSearchText(found: ProjectKnowledgeSearchResult): {
  readonly note: string | null;
  readonly summary: string;
} {
  const caveat = searchCaveat(found.state);
  if (found.results.length > 0) {
    const summary = `${plural(found.results.length, "passage")} found.`;
    return { note: caveat, summary: caveat ? `${summary} ${caveat}` : summary };
  }
  if (caveat === null)
    return { note: "Nothing in this project's knowledge matches.", summary: "Nothing matches." };
  const partial = `Nothing indexed so far matches. ${caveat}`;
  return { note: partial, summary: partial };
}

export function knowledgeShouldPoll(status: ProjectKnowledgeStatus | null): boolean {
  return status !== null && (status.state === "indexing" || status.state === "unindexed");
}

/** Whether this machine can show its project knowledge to this app. */
export type KnowledgeAccess = "ready" | "offline" | "update" | "permission" | "unknown";

export function knowledgeAccess(input: {
  /** The connection phase; a reconnect in progress says nothing yet. */
  readonly phase: string | undefined;
  /** `capabilities.projectKnowledge`; null until the host's config arrives. */
  readonly supported: boolean | null;
  readonly read: "granted" | "denied" | "signed-out" | "unknown";
  readonly files: "granted" | "denied" | "signed-out" | "unknown";
}): KnowledgeAccess {
  if (input.phase === "connecting" || input.phase === "reconnecting") return "unknown";
  if (input.phase !== "connected") return "offline";
  if (input.supported === null) return "unknown";
  if (!input.supported) return "update";
  if (input.read === "denied" || input.files === "denied") return "permission";
  return input.read === "granted" && input.files === "granted" ? "ready" : "unknown";
}

export function knowledgeAccessProblem(access: KnowledgeAccess, machine: string): string | null {
  switch (access) {
    case "ready":
    case "unknown":
      return null;
    case "offline":
      return `Connect ${machine} to see this project's knowledge.`;
    case "update":
      return `Update SpecWithCode on ${machine} to see this project's knowledge.`;
    case "permission":
      return `This app's connection to ${machine} needs permission to read files on that machine.`;
  }
}

/** A search hit's date, such as `Oct 12, 2026`; empty when the host sent none. */
export function knowledgeModifiedDate(modifiedAt: string, locale?: string): string {
  const at = Date.parse(modifiedAt);
  return Number.isNaN(at)
    ? ""
    : new Date(at).toLocaleDateString(locale, { year: "numeric", month: "short", day: "numeric" });
}
