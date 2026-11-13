/**
 * Pages that live on a provider's site rather than in the project: a claude.ai
 * artifact, a ChatGPT share or Codex task, a Gemini share, a Cursor agent, a
 * Devin session. A reply links SpecWithCode reports instead; a link to one of
 * these that still reaches a reply shows as an outside document, never as a
 * branded link, because it opens only for the account that made it.
 */

export type ProviderHostedDocumentProvider =
  | "Claude"
  | "ChatGPT"
  | "Codex"
  | "Gemini"
  | "Cursor"
  | "Devin";

export type ProviderHostedDocumentKind =
  | "artifact"
  | "chat"
  | "share"
  | "canvas"
  | "task"
  | "project"
  | "session"
  | "agent";

export interface ProviderHostedDocument {
  readonly provider: ProviderHostedDocumentProvider;
  readonly kind: ProviderHostedDocumentKind;
  /** The link as written, for Open and Copy. */
  readonly url: string;
}

interface Rule {
  readonly hosts: ReadonlyArray<string>;
  readonly provider: ProviderHostedDocumentProvider;
  readonly paths: ReadonlyArray<readonly [RegExp, ProviderHostedDocumentKind]>;
}

const SEGMENT = "[A-Za-z0-9_-]{4,}";
/** Chats, shares and projects on claude.ai and ChatGPT are named by UUID. */
const UUID = "[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}";
/** A Gemini chat id: hex, unlike its product pages (`/app/download`). */
const HEX_ID = "[0-9a-f]{12,}";

const RULES: ReadonlyArray<Rule> = [
  {
    hosts: ["claude.ai"],
    provider: "Claude",
    paths: [
      [new RegExp(`^/(?:code/)?artifact/[^/]*${SEGMENT}$`), "artifact"],
      [new RegExp(`^/public/artifacts/${SEGMENT}$`), "artifact"],
      [new RegExp(`^/chat/${UUID}$`), "chat"],
      [new RegExp(`^/share/${UUID}$`), "share"],
      [new RegExp(`^/project/${UUID}$`), "project"],
      [new RegExp(`^/code/session_${SEGMENT}$`), "session"],
    ],
  },
  {
    hosts: ["chatgpt.com", "chat.openai.com"],
    provider: "ChatGPT",
    paths: [
      [new RegExp(`^/c/${UUID}$`), "chat"],
      [new RegExp(`^/share/${UUID}$`), "share"],
      [new RegExp(`^/canvas/shared/${SEGMENT}$`), "canvas"],
      [new RegExp(`^/g/${SEGMENT}/c/${UUID}$`), "chat"],
    ],
  },
  {
    hosts: ["chatgpt.com"],
    provider: "Codex",
    paths: [[new RegExp(`^/codex/tasks/${SEGMENT}$`), "task"]],
  },
  {
    hosts: ["gemini.google.com", "g.co"],
    provider: "Gemini",
    paths: [
      [new RegExp(`^/share/${SEGMENT}$`), "share"],
      [new RegExp(`^/app/${HEX_ID}$`), "chat"],
      [new RegExp(`^/gemini/share/${SEGMENT}$`), "share"],
    ],
  },
  {
    hosts: ["cursor.com", "www.cursor.com"],
    provider: "Cursor",
    paths: [[new RegExp(`^/agents/${SEGMENT}$`), "agent"]],
  },
  {
    hosts: ["app.devin.ai"],
    provider: "Devin",
    paths: [[new RegExp(`^/sessions/${SEGMENT}$`), "session"]],
  },
];

/** `[label](url)` with the brackets a label may hold escaped. */
export function providerHostedDocumentMarkdown(
  document: ProviderHostedDocument,
  label: string,
): string {
  return `[${label.replace(/[[\]\\]/g, (char) => `\\${char}`)}](${document.url})`;
}

/** The provider page a link names, or null for any other link. */
export function providerHostedDocument(
  href: string | null | undefined,
): ProviderHostedDocument | null {
  if (!href || href.length > 2048) return null;
  let url: URL;
  try {
    url = new URL(href);
  } catch {
    return null;
  }
  if (url.protocol !== "https:" && url.protocol !== "http:") return null;
  const host = url.hostname.toLowerCase();
  const path = url.pathname.replace(/\/+$/, "");
  for (const rule of RULES) {
    if (!rule.hosts.includes(host)) continue;
    for (const [pattern, kind] of rule.paths) {
      if (pattern.test(path)) return { provider: rule.provider, kind, url: href };
    }
  }
  return null;
}

const KIND_NOUN: Record<ProviderHostedDocumentKind, string> = {
  artifact: "artifact",
  chat: "chat",
  share: "shared page",
  canvas: "canvas",
  task: "task",
  project: "project",
  session: "session",
  agent: "agent run",
};

/** "a Claude artifact", "a Codex task". */
export function providerHostedDocumentNoun(document: ProviderHostedDocument): string {
  return `a ${document.provider} ${KIND_NOUN[document.kind]}`;
}

/** What the chip's tip says: where the page lives and who can open it. */
export function providerHostedDocumentExplanation(document: ProviderHostedDocument): string {
  return `Made in ${document.provider}, outside SpecWithCode. It lives on ${document.provider}'s site and opens only for the account that made it. Save it to this project to keep it with the work.`;
}

/**
 * The request "Save to this project" drafts into the thread's composer: the
 * agent reads the page with its own access and files it as a report.
 */
export function providerHostedDocumentImportRequest(
  document: ProviderHostedDocument,
  label: string,
): string {
  const title = label.trim() || providerHostedDocumentNoun(document);
  return `Save ${providerHostedDocumentMarkdown(document, title)} into this project's reports with studio_report_save: read it with your access to ${document.provider}, keep its source and original link, and link the saved file here instead of the ${document.provider} page.`;
}
