import { parseComposerContextHref } from "@specweave-studio/shared/composerContextReferences";
import { filePreviewKind } from "@specweave-studio/shared/filePreview";
import { renderCodexFileCitationsAsMarkdown } from "@specweave-studio/client-runtime/codex-markdown-directives";

import {
  extractMarkdownLinkHrefs,
  fileReferenceSpans,
  mayBeDirectory,
  type MarkdownFileLinkMeta,
  resolveInlineCodeFileLinks,
  resolveMarkdownFileLinkMeta,
  threadFileFolders,
} from "./markdown-links";

export type ThreadArtifactKind =
  | "image"
  | "video"
  | "audio"
  | "html"
  | "markdown"
  | "pdf"
  | "code"
  | "file"
  | "link";

interface ThreadArtifactBase {
  /** Stable across renders: the file's authored path or the link's URL. */
  readonly key: string;
  readonly kind: ThreadArtifactKind;
  readonly name: string;
  /** The message that names it last. */
  readonly messageId: string;
}

export interface ThreadFileArtifact extends ThreadArtifactBase {
  readonly kind: Exclude<ThreadArtifactKind, "link">;
  /** How the message named it; the host settles where it is. */
  readonly meta: MarkdownFileLinkMeta;
}

export interface ThreadLinkArtifact extends ThreadArtifactBase {
  readonly kind: "link";
  readonly url: string;
  readonly host: string;
}

/** A page the thread published with `html_render`, kept as an attachment. */
export interface ThreadRenderArtifact extends ThreadArtifactBase {
  readonly kind: "html";
  readonly attachmentId: string;
}

export type ThreadArtifact = ThreadFileArtifact | ThreadLinkArtifact | ThreadRenderArtifact;

/** A file a thread's tool calls wrote, as the tool named it. */
export interface ThreadCreatedFile {
  readonly path: string;
  readonly itemId: string;
}

const WORKSPACE_DELIVERABLE_KINDS = new Set<ThreadArtifactKind>([
  "image",
  "video",
  "audio",
  "pdf",
  "html",
]);

/** A file outside the workspace, or a picture, recording, PDF or page inside it. */
function isDeliverableFile(meta: MarkdownFileLinkMeta): boolean {
  if (meta.workspaceRelativePath === null) return true;
  return WORKSPACE_DELIVERABLE_KINDS.has(fileKind(meta.basename));
}

export interface ThreadArtifactMessage {
  readonly id: string;
  readonly text: string;
}

const FENCED_CODE_SEGMENT_PATTERN = /(```[\s\S]*?(?:```|$))/;
const INLINE_CODE_SPAN_PATTERN = /`([^`\n]+)`/g;
const TITLED_LINK_PATTERN = /\[([^\]\n]+)\]\((https?:\/\/[^\s)]+)\)/g;
const BARE_URL_PATTERN = /(?<![(<\w])https?:\/\/[^\s<>()`"']+[^\s<>()`"'.,;:!?]/g;

/** Text outside fenced code blocks: a path in an example is not an artifact. */
function proseSegments(text: string): string[] {
  return text.split(FENCED_CODE_SEGMENT_PATTERN).filter((_, index) => index % 2 === 0);
}

function fileKind(name: string): ThreadFileArtifact["kind"] {
  const kind = filePreviewKind({ name });
  if (kind === "text") return "code";
  if (kind === "unsupported") return "file";
  return kind;
}

function linkArtifact(url: string, messageId: string, title?: string): ThreadLinkArtifact | null {
  try {
    const parsed = new URL(url);
    if (parsed.protocol !== "https:" && parsed.protocol !== "http:") return null;
    const path = parsed.pathname.replace(/\/+$/, "");
    const tail = path.split("/").filter(Boolean).slice(-2).join("/");
    return {
      key: url,
      kind: "link",
      url,
      host: parsed.hostname.replace(/^www\./, ""),
      name: title?.trim() || (tail.length > 0 ? tail : parsed.hostname),
      messageId,
    };
  } catch {
    return null;
  }
}

/**
 * Every file, page, document and link a thread's messages name, newest first,
 * each once. Folders are left out: they are places, not things the thread made.
 * Paths are as the messages wrote them; `useExistingFileLinks` settles them.
 */
export function collectThreadArtifacts(
  messages: ReadonlyArray<ThreadArtifactMessage>,
  cwd: string | undefined,
  createdFiles: ReadonlyArray<ThreadCreatedFile> = [],
): ThreadArtifact[] {
  const byKey = new Map<string, ThreadArtifact>();
  const add = (artifact: ThreadArtifact) => {
    byKey.delete(artifact.key);
    byKey.set(artifact.key, artifact);
  };
  const contextFolders = threadFileFolders(
    messages.map((message) => message.text),
    cwd,
  );
  // Files the thread wrote outside its workspace (a store listing in
  // ~/Downloads) are deliverables even when no reply names them; edits inside
  // the workspace are the diff's business.
  for (const file of createdFiles) {
    const meta = resolveMarkdownFileLinkMeta(file.path, cwd, cwd);
    if (meta && !mayBeDirectory(meta) && isDeliverableFile(meta)) {
      add(fileArtifact(meta, file.itemId));
    }
  }
  for (const message of messages) {
    // In the order the message names them, so the newest mention lists first.
    const found: Array<readonly [number, ThreadArtifact]> = [];
    const text = renderCodexFileCitationsAsMarkdown(message.text);
    const at = (needle: string) => Math.max(0, text.indexOf(needle));
    for (const href of extractMarkdownLinkHrefs(text)) {
      if (parseComposerContextHref(href) || /^https?:\/\//i.test(href)) continue;
      const meta = resolveMarkdownFileLinkMeta(href, cwd, cwd);
      if (meta && !mayBeDirectory(meta))
        found.push([at(`(${href}`), fileArtifact(meta, message.id)]);
    }
    for (const [span, meta] of resolveInlineCodeFileLinks(
      fileReferenceSpans(message.text),
      cwd,
      cwd,
      contextFolders,
    )) {
      // Shorthand (`shot-{dark,light}.png`, `shot-*.png`) stays one entry with
      // the files it names: the host settles which exist, or that a file
      // really has the written name (`useSettledArtifacts`), as chat chips do.
      const files = meta.expansions?.filter((file) => !mayBeDirectory(file));
      if (files ? files.length > 0 : !mayBeDirectory(meta)) {
        found.push([
          at(`\`${span}`),
          fileArtifact(files ? { ...meta, expansions: files } : meta, message.id),
        ]);
      }
    }
    for (const match of text.matchAll(TITLED_LINK_PATTERN)) {
      const link = linkArtifact(match[2]!, message.id, match[1]);
      if (link) found.push([match.index, link]);
    }
    const prose = proseSegments(text).join("\n").replace(INLINE_CODE_SPAN_PATTERN, "");
    for (const match of prose.matchAll(BARE_URL_PATTERN)) {
      const link = linkArtifact(match[0], message.id);
      if (link) found.push([at(match[0]), link]);
    }
    for (const [, artifact] of found.toSorted((left, right) => left[0] - right[0])) add(artifact);
  }
  return [...byKey.values()].reverse();
}

/**
 * The artifacts as the host settled them (newest first): shorthand becomes the
 * files the host has, a file it lacks drops out, and a file named both on its
 * own and in shorthand lists once, where it is newest.
 */
export function settleThreadArtifacts(
  authored: ReadonlyArray<ThreadArtifact>,
  settled: ReadonlyMap<string, MarkdownFileLinkMeta>,
): ThreadArtifact[] {
  const seen = new Set<string>();
  return authored
    .flatMap((artifact): ThreadArtifact[] => {
      if (!("meta" in artifact)) return [artifact];
      const meta = settled.get(artifact.key) ?? artifact.meta;
      if (meta.glob || meta.expansions) {
        // Newest first, like the rest, so stepping through reads in written order.
        return (meta.expansions ?? [])
          .filter((file) => !file.unresolved)
          .map((file) => fileArtifact(file, artifact.messageId))
          .toReversed();
      }
      // A file the host does not have is not something to open.
      if (meta.unresolved) return [];
      return [{ ...artifact, meta }];
    })
    .filter((artifact) => !seen.has(artifact.key) && !!seen.add(artifact.key));
}

export function fileArtifact(meta: MarkdownFileLinkMeta, messageId: string): ThreadFileArtifact {
  const { line: _line, column: _column, endLine: _endLine, label: _label, ...file } = meta;
  return {
    // One entry per file: `app.ts:12` and `app.ts:40` are the same artifact.
    key: `file:${meta.filePath.replace(/(?::\d+){1,2}$/, "")}`,
    kind: fileKind(meta.basename),
    name: meta.basename,
    meta: file,
    messageId,
  };
}

/** Artifacts the viewer shows: everything but links, which open in the browser. */
export function isViewableArtifact(
  artifact: ThreadArtifact,
): artifact is ThreadFileArtifact | ThreadRenderArtifact {
  return artifact.kind !== "link";
}
