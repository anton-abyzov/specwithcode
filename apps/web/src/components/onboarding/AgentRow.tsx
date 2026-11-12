import { CheckIcon, CopyIcon } from "lucide-react";
import { useState, type ReactNode } from "react";

import { writeTextToClipboard } from "../../hooks/useCopyToClipboard";
import { useTx } from "../../i18n";
import { Button } from "../ui/button";

export type AgentRowTone = "ready" | "checking" | "quiet" | "attention";

/**
 * One agent in the first-run Agents step: its name, one line on what it uses,
 * its state, and at most one button. A sign-in in progress shows under the row.
 */
export function AgentRow({
  agent,
  state,
  icon,
  name,
  uses,
  detail,
  status,
  action,
  children,
}: {
  /** A driver kind or a registry agent's id, for checks that look for a row. */
  readonly agent: string;
  readonly state: string;
  readonly icon: ReactNode;
  readonly name: string;
  readonly uses: string;
  /** The account, or the reason the agent is not ready. */
  readonly detail?: ReactNode;
  readonly status?: ReactNode;
  readonly action?: ReactNode;
  readonly children?: ReactNode;
}) {
  return (
    <div
      className="rounded-lg border border-border bg-background px-4 py-3.5"
      data-agent-row={agent}
      data-agent-state={state}
    >
      <div className="flex flex-wrap items-center gap-3">
        {icon}
        <div className="min-w-0 flex-1">
          <h3 className="text-sm font-medium text-foreground">{name}</h3>
          <p className="mt-0.5 text-xs leading-relaxed text-muted-foreground">{uses}</p>
          {detail ? (
            <div className="mt-0.5 text-xs leading-relaxed break-words text-muted-foreground">
              {detail}
            </div>
          ) : null}
        </div>
        {status || action ? (
          <div className="flex shrink-0 items-center gap-2">
            {status}
            {action}
          </div>
        ) : null}
      </div>
      {children ? <div className="mt-2 border-t border-border/60 pt-1">{children}</div> : null}
    </div>
  );
}

const TONE_CLASS: Readonly<Record<AgentRowTone, string>> = {
  ready: "font-medium text-success-foreground",
  checking: "text-muted-foreground",
  quiet: "text-muted-foreground",
  attention: "text-warning-foreground",
};

/** The row's state in a word or two. */
export function AgentRowStatus({
  tone,
  children,
}: {
  readonly tone: AgentRowTone;
  readonly children: ReactNode;
}) {
  return (
    <span
      role="status"
      data-agent-status={tone}
      className={`inline-flex items-center gap-1.5 text-xs ${TONE_CLASS[tone]}`}
    >
      {tone === "ready" ? <CheckIcon aria-hidden className="size-3.5" /> : null}
      {children}
    </span>
  );
}

/** The same sign-in as typed in a terminal, for those who want it. */
export function AgentCommand({
  command,
  note,
  flush = false,
}: {
  readonly command: string;
  readonly note?: ReactNode;
  /** Inside a row that already has its own padding. */
  readonly flush?: boolean;
}) {
  const tx = useTx();
  const [copied, setCopied] = useState(false);
  return (
    <details className={flush ? "w-full text-xs" : "px-3 py-2 text-xs sm:px-4"} data-agent-command>
      <summary className="cursor-default text-muted-foreground">{tx("Show command")}</summary>
      <div className="mt-2 flex items-center gap-2 rounded-md border bg-muted/40 px-3 py-2">
        <code className="min-w-0 flex-1 overflow-x-auto font-mono text-xs whitespace-nowrap">
          {command}
        </code>
        <Button
          size="icon-xs"
          variant="ghost"
          aria-label={copied ? tx("Copied") : tx("Copy command")}
          onClick={() =>
            void writeTextToClipboard(command).then(
              () => setCopied(true),
              () => {},
            )
          }
        >
          {copied ? <CheckIcon aria-hidden /> : <CopyIcon aria-hidden />}
        </Button>
      </div>
      {note ? <p className="mt-2 text-muted-foreground">{note}</p> : null}
    </details>
  );
}
