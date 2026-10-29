import { CheckIcon, CopyIcon, ExternalLinkIcon } from "lucide-react";
import { type KeyboardEvent, type MouseEvent, useEffect, useMemo, useState } from "react";

import { writeTextToClipboard } from "../../hooks/useCopyToClipboard";
import { readLocalApi } from "../../localApi";
import { cn } from "../../lib/utils";
import { safeTerminalUrl, terminalActions, terminalTextSegments } from "../../lib/terminalActions";

/** Opens a terminal link in the system browser, only on a click and only for http(s). */
export function openTerminalUrl(url: string) {
  const safe = safeTerminalUrl(url);
  if (!safe) return;
  const api = readLocalApi();
  if (api) void api.shell.openExternal(safe).catch(() => undefined);
  else window.open(safe, "_blank", "noopener,noreferrer");
}

function openOnClick(url: string) {
  return (event: MouseEvent<HTMLAnchorElement | HTMLButtonElement>) => {
    event.preventDefault();
    event.stopPropagation();
    openTerminalUrl(url);
  };
}

function useCopied(value: string) {
  const [copied, setCopied] = useState<string | null>(null);
  useEffect(() => {
    if (copied === null) return;
    const timer = window.setTimeout(() => setCopied(null), 1500);
    return () => window.clearTimeout(timer);
  }, [copied]);
  const copy = (event: MouseEvent | KeyboardEvent) => {
    event.preventDefault();
    event.stopPropagation();
    void writeTextToClipboard(value, "code").then(
      () => setCopied(value),
      () => setCopied(null),
    );
  };
  return { copied: copied === value, copy };
}

function InlineCode({ code }: { readonly code: string }) {
  const { copied, copy } = useCopied(code);
  // The code itself is the control, so the line keeps its columns: nothing is
  // inserted beside it, and its text stays selectable and in the copied output.
  return (
    <span
      role="button"
      tabIndex={0}
      className="relative cursor-copy rounded bg-primary/10 font-semibold text-foreground underline decoration-dotted decoration-primary/50 underline-offset-2 hover:bg-primary/20 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
      aria-label={copied ? `Copied code ${code}` : `Copy code ${code}`}
      onClick={copy}
      onKeyDown={(event) => {
        if (event.key === "Enter" || event.key === " ") copy(event);
      }}
    >
      {code}
      {copied ? (
        <span
          className="pointer-events-none absolute start-full top-0 ms-0.5 inline-flex rounded bg-background p-0.5 text-success-foreground shadow-sm select-none"
          aria-hidden
        >
          <CheckIcon className="size-3" />
        </span>
      ) : null}
    </span>
  );
}

/** Terminal text with its http(s) URLs as links and its one-time codes copyable. */
export function TerminalLinkedText({ text }: { readonly text: string }) {
  const segments = useMemo(() => terminalTextSegments(text), [text]);
  if (segments.every((segment) => segment.kind === "text")) return text;
  return segments.map((segment, index) =>
    segment.kind === "url" ? (
      <a
        // oxlint-disable-next-line react/no-array-index-key -- segments are positional for one text
        key={index}
        href={segment.url}
        target="_blank"
        rel="noopener noreferrer"
        className="text-primary underline decoration-primary/40 underline-offset-2 hover:decoration-primary"
        onClick={openOnClick(segment.url)}
      >
        {segment.text}
      </a>
    ) : segment.kind === "code" ? (
      // oxlint-disable-next-line react/no-array-index-key -- segments are positional for one text
      <InlineCode key={index} code={segment.text} />
    ) : (
      segment.text
    ),
  );
}

function CodeButton({ code, className }: { readonly code: string; readonly className: string }) {
  const { copied, copy } = useCopied(code);
  return (
    <button
      type="button"
      className={className}
      aria-label={copied ? `Copied code ${code}` : `Copy code ${code}`}
      onClick={copy}
    >
      {copied ? (
        <CheckIcon className="size-3" aria-hidden />
      ) : (
        <CopyIcon className="size-3" aria-hidden />
      )}
      <span className="font-mono font-semibold">{code}</span>
      <span className="text-muted-foreground">{copied ? "Copied" : "Copy"}</span>
    </button>
  );
}

function linkLabel(url: string): string {
  const parsed = new URL(url);
  const path = parsed.pathname === "/" ? "" : parsed.pathname;
  return `${parsed.host}${path}`;
}

/**
 * Sign-in links and one-time codes from the output, as buttons above it, so they
 * stay in reach while the output scrolls, streams or is colored by a grammar.
 */
export function TerminalActionBar({
  text,
  className,
}: {
  readonly text: string;
  readonly className?: string | undefined;
}) {
  const { links, codes } = useMemo(() => terminalActions(text), [text]);
  if (links.length === 0 && codes.length === 0) return null;
  const buttonClass =
    "inline-flex min-h-7 max-w-full items-center gap-1.5 rounded-md border border-border/60 bg-background px-2 text-xs text-foreground hover:bg-muted/60 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring";
  return (
    <div
      className={cn(
        "flex flex-wrap items-center gap-1.5 border-b border-border/45 px-3 py-1.5",
        className,
      )}
      data-terminal-actions
      onClick={(event) => event.stopPropagation()}
    >
      {codes.map((code) => (
        <CodeButton key={`code:${code}`} code={code} className={buttonClass} />
      ))}
      {links.map((url) => (
        <a
          key={`url:${url}`}
          href={url}
          target="_blank"
          rel="noopener noreferrer"
          className={buttonClass}
          aria-label={`Open ${url}`}
          onClick={openOnClick(url)}
        >
          <ExternalLinkIcon className="size-3 shrink-0" aria-hidden />
          <span className="truncate">Open {linkLabel(url)}</span>
        </a>
      ))}
    </div>
  );
}
