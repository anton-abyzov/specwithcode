import type { DesignOwnerInput, DesignSystemId, EnvironmentId } from "@specweave-studio/contracts";
import { BookOpenTextIcon, PencilIcon, RefreshCwIcon } from "lucide-react";
import { useEffect, useId, useMemo, useState } from "react";

import ChatMarkdown from "~/components/ChatMarkdown";

import { Button } from "../../../ui/button";
import { Textarea } from "../../../ui/textarea";
import { browserFile, fileName, formatSize, type BrowserFile } from "./filesModel";
import { MarkdownPreview, useFileContent } from "./FilePreview";
import type { PreviewPlan } from "./previewPlan";
import {
  textToBase64,
  useSystemFilesApi,
  useSystemName,
  type SystemFilesApi,
} from "./systemFilesApi";

export interface OverviewReadmeProps {
  readonly environmentId: EnvironmentId;
  readonly owner: DesignOwnerInput;
  readonly systemId: DesignSystemId;
  readonly canEdit: boolean;
}

export const README_PATH = "README.md";
/** The most the README keeps, as the reference does. */
export const README_MAX_BYTES = 200 * 1024;
export const README_TOO_LONG =
  "That is more text than the README can keep (200 KB), so it was not saved.";
export const README_PLACEHOLDER = "Write the brand book here.";

/** The brand book a person starts from, with the headings a brand book usually has. */
export function starterReadme(systemName: string): string {
  return `# ${systemName.trim() || "Brand book"}

This brand book is yours to edit. Say how the tokens and components should be used, and when not to use them.

## Principles

- What should every screen feel like? Name two or three qualities, such as calm, dense or friendly.
- What do you never do?

## Using tokens

- Which colors carry actions, surfaces and text, and which pairs meet contrast.
- The spacing and corner radius steps to reach for first.

## Using components

- Which component does each job, and the variants to prefer.

## Accessibility

- Minimum contrast, focus styles, reduced motion and touch target sizes.
`;
}

/** The system's README.md, the brand book agents read first. */
export function OverviewReadme(props: OverviewReadmeProps) {
  const api = useSystemFilesApi(props);
  const systemName = useSystemName(props);
  return (
    <OverviewReadmeView
      environmentId={props.environmentId}
      canEdit={props.canEdit}
      systemName={systemName}
      api={api}
    />
  );
}

const MARKDOWN: PreviewPlan = { kind: "markdown" };
const byteLength = (text: string) => new TextEncoder().encode(text).length;

/** The first `# ` heading as a card title, and the text without it. */
export function splitTitle(text: string): { title: string | null; body: string } {
  const match = /^\s*#\s+(.+?)\s*#*\s*(?:\n|$)/.exec(text);
  return match === null
    ? { title: null, body: text }
    : { title: match[1]!, body: text.slice(match[0].length) };
}

function Retry({ message, onRetry }: { message: string; onRetry: () => void }) {
  return (
    <div className="flex flex-col items-start gap-2">
      <p className="text-sm text-muted-foreground" role="alert">
        {message}
      </p>
      <Button variant="outline" size="sm" onClick={onRetry}>
        <RefreshCwIcon aria-hidden />
        Try again
      </Button>
    </div>
  );
}

function GuidanceCard({
  file,
  api,
  environmentId,
}: {
  file: BrowserFile;
  api: SystemFilesApi;
  environmentId: EnvironmentId;
}) {
  const { content, retry } = useFileContent(file, MARKDOWN, api.read);
  const [open, setOpen] = useState(false);
  const parts = content.status === "ready" ? splitTitle(content.text) : null;
  const long = parts !== null && parts.body.length > 900;
  return (
    <article
      className="flex min-w-0 flex-col gap-2 rounded-lg border border-border/70 bg-card px-4 py-3"
      data-testid="guidance-card"
      data-path={file.path}
    >
      <header className="flex min-w-0 flex-col gap-0.5">
        <h3 className="truncate text-sm font-medium text-foreground">
          {parts?.title ?? fileName(file.path)}
        </h3>
        <code className="truncate font-mono text-2xs text-muted-foreground">{file.path}</code>
      </header>
      {content.status === "error" ? (
        <Retry message={content.message} onRetry={retry} />
      ) : parts === null ? (
        <p className="text-xs text-muted-foreground">Loading…</p>
      ) : parts.body.trim() === "" ? (
        <p className="text-xs text-muted-foreground">This guidance is empty.</p>
      ) : (
        <>
          <div
            className={
              long && !open
                ? "report-document max-h-48 overflow-hidden text-sm [mask-image:linear-gradient(to_bottom,black_70%,transparent)]"
                : "report-document text-sm"
            }
          >
            <div className="report-document-prose">
              <ChatMarkdown text={parts.body} cwd={undefined} environmentId={environmentId} />
            </div>
          </div>
          {long ? (
            <Button
              variant="ghost"
              size="xs"
              className="self-start"
              onClick={() => setOpen((value) => !value)}
            >
              {open ? "Show less" : "Show more"}
            </Button>
          ) : null}
        </>
      )}
    </article>
  );
}

function ReadmeEditor({
  initial,
  onSave,
  onCancel,
}: {
  initial: string;
  /** Resolves to an error message, or null once saved. */
  onSave: (text: string) => Promise<string | null>;
  onCancel: () => void;
}) {
  const id = useId();
  const [draft, setDraft] = useState(initial);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const bytes = byteLength(draft);
  const over = bytes > README_MAX_BYTES;
  const save = () => {
    if (over) return setError(README_TOO_LONG);
    setBusy(true);
    setError(null);
    void onSave(draft).then((failure) => {
      setBusy(false);
      setError(failure);
    });
  };
  return (
    <div className="flex flex-col gap-2" data-testid="readme-editor">
      <label htmlFor={id} className="sr-only">
        README.md
      </label>
      <Textarea
        id={id}
        value={draft}
        placeholder={README_PLACEHOLDER}
        className="min-h-80"
        spellCheck
        onChange={(event) => {
          setDraft(event.target.value);
          setError(null);
        }}
        onKeyDown={(event) => {
          if (event.key === "s" && (event.metaKey || event.ctrlKey)) {
            event.preventDefault();
            save();
          }
          if (event.key === "Escape" && draft === initial) {
            event.preventDefault();
            onCancel();
          }
        }}
      />
      <div className="flex flex-wrap items-center gap-2">
        <span
          className={over ? "text-xs text-destructive-foreground" : "text-xs text-muted-foreground"}
        >
          Markdown · {formatSize(bytes)} of 200 KB
        </span>
        <div className="ml-auto flex gap-2">
          <Button variant="outline" size="sm" disabled={busy} onClick={onCancel}>
            Cancel
          </Button>
          <Button size="sm" disabled={busy} onClick={save}>
            {busy ? "Saving…" : "Save"}
          </Button>
        </div>
      </div>
      {error ? (
        <p role="alert" className="text-sm text-destructive-foreground">
          {error}
        </p>
      ) : null}
    </div>
  );
}

export function OverviewReadmeView({
  environmentId,
  canEdit,
  systemName,
  api,
}: {
  environmentId: EnvironmentId;
  canEdit: boolean;
  systemName: string;
  api: SystemFilesApi;
}) {
  const listing = api.listing;
  const files = useMemo(() => (listing.data?.files ?? []).map(browserFile), [listing.data]);
  const readme =
    files.find((file) => file.origin === "stored" && file.path === README_PATH) ?? null;
  const docs = files
    .filter(
      (file) =>
        file.origin === "stored" &&
        file.path.startsWith("docs/") &&
        /\.(md|markdown)$/i.test(file.path) &&
        !file.path.split("/").some((segment) => segment.startsWith(".")),
    )
    .toSorted((left, right) => left.path.localeCompare(right.path));
  const { content, retry } = useFileContent(readme, readme === null ? null : MARKDOWN, api.read);
  // Text saved here shows at once, before the listing and the next read catch up.
  const [saved, setSaved] = useState<string | null>(null);
  const [editing, setEditing] = useState<string | null>(null);
  useEffect(() => {
    // oxlint-disable-next-line react/set-state-in-effect -- a fresh read replaces what was saved here.
    if (content.status === "ready") setSaved(null);
  }, [content]);

  const text: string | null =
    saved ?? (content.status === "ready" ? content.text : readme === null ? "" : null);

  const save = async (draft: string): Promise<string | null> => {
    if (byteLength(draft) > README_MAX_BYTES) return README_TOO_LONG;
    const outcome = await api.put(README_PATH, textToBase64(draft));
    if (!outcome.ok) return outcome.message;
    setSaved(draft);
    setEditing(null);
    listing.refresh();
    return null;
  };

  let body;
  if (editing !== null)
    body = <ReadmeEditor initial={editing} onSave={save} onCancel={() => setEditing(null)} />;
  else if (listing.data === null && listing.error === null)
    body = <p className="text-sm text-muted-foreground">Loading the README…</p>;
  else if (listing.data === null)
    body = <Retry message="Couldn't list the files." onRetry={listing.refresh} />;
  else if (readme !== null && content.status === "error" && saved === null)
    body = <Retry message={content.message} onRetry={retry} />;
  else if (text === null) body = <p className="text-sm text-muted-foreground">Loading…</p>;
  else if (text.trim() === "")
    body = canEdit ? (
      <div
        className="flex flex-col items-start gap-3 rounded-lg border border-dashed border-border px-4 py-5"
        data-testid="readme-empty"
      >
        <button
          type="button"
          className="text-left text-sm text-muted-foreground hover:text-foreground"
          onClick={() => setEditing("")}
        >
          {README_PLACEHOLDER}
        </button>
        <p className="text-xs text-muted-foreground">
          The brand book people read before they design with the system. Start from headings for
          principles, tokens, components and accessibility, or write your own.
        </p>
        <div className="flex flex-wrap gap-2">
          <Button size="sm" onClick={() => setEditing(starterReadme(systemName))}>
            <BookOpenTextIcon aria-hidden />
            Start from a template
          </Button>
          <Button variant="outline" size="sm" onClick={() => setEditing("")}>
            Write it
          </Button>
        </div>
      </div>
    ) : (
      <p className="text-sm text-muted-foreground" data-testid="readme-empty">
        This design system has no README yet.
      </p>
    );
  else
    body = (
      <div className="relative" data-testid="readme">
        {canEdit ? (
          <Button
            variant="ghost"
            size="xs"
            className="absolute top-0 right-0 z-10"
            onClick={() => setEditing(text)}
          >
            <PencilIcon aria-hidden />
            Edit
          </Button>
        ) : null}
        <MarkdownPreview
          text={text}
          environmentId={environmentId}
          className="report-document w-full max-w-[46rem] pr-16"
        />
      </div>
    );

  return (
    <div className="flex min-w-0 flex-col gap-5" data-testid="overview-readme">
      {body}
      {docs.length > 0 ? (
        <section className="flex flex-col gap-2" aria-label="Guidance">
          <h3 className="text-xs font-medium text-muted-foreground">Guidance</h3>
          <div className="grid gap-3 lg:grid-cols-2">
            {docs.map((file) => (
              <GuidanceCard key={file.path} file={file} api={api} environmentId={environmentId} />
            ))}
          </div>
        </section>
      ) : null}
    </div>
  );
}
