import {
  MCP_ELICITATION_URL_DONE_ANSWER,
  type OrchestrationV2McpElicitation,
  type ProviderApprovalDecision,
  type ProviderUserInputAnswers,
  type RuntimeRequestId,
} from "@specweave-studio/contracts";
import {
  checkMcpElicitationUrl,
  type McpElicitationUrlWarning,
} from "@specweave-studio/shared/mcpElicitationUrl";
import { memo, useMemo, useState } from "react";

import { useTx } from "../../i18n";
import { renderRich } from "../../i18n/rich";
import { cn } from "~/lib/utils";
import { ensureLocalApi } from "../../localApi";
import { OnActionMachine, type ActionMachine } from "../../studio/actionMachine";
import { Button } from "../ui/button";

export interface McpElicitationUrlCardProps {
  requestId: RuntimeRequestId;
  elicitation: OrchestrationV2McpElicitation;
  pendingCount: number;
  disabled: boolean;
  isResponding: boolean;
  machine?: ActionMachine | null | undefined;
  onRespond: (
    requestId: RuntimeRequestId,
    decision: ProviderApprovalDecision,
    content?: ProviderUserInputAnswers,
  ) => Promise<unknown>;
  /** Opens a link in the system browser; tests pass their own. */
  openLink?: (url: string) => Promise<void>;
}

const WARNING_TEXT: Record<McpElicitationUrlWarning, string> = {
  punycode:
    "This address is written with international characters. Check that it is the site you expect.",
  "mixed-script":
    "This address mixes letters from different alphabets, a common trick to imitate another site.",
  "not-https":
    "This link isn't secure (http). Others on your network could see or change the page.",
};

// "sm" buttons match the approval and question actions; below 420px they stack.
const BUTTON_CLASS = "min-w-20 max-w-full @max-[420px]:w-full";

const openInBrowser = (url: string) => ensureLocalApi().shell.openExternal(url);

/**
 * An MCP server asks the person to open a link (URL mode, 1498). The link
 * opens only when the person presses Open link, in the system browser, exactly
 * as the server sent it; "I'm done, continue" tells the server to go on.
 */
export const McpElicitationUrlCard = memo(function McpElicitationUrlCard({
  requestId,
  elicitation,
  pendingCount,
  disabled,
  isResponding,
  machine,
  onRespond,
  openLink = openInBrowser,
}: McpElicitationUrlCardProps) {
  const tx = useTx();
  const checked = useMemo(() => checkMcpElicitationUrl(elicitation.url), [elicitation.url]);
  const [opened, setOpened] = useState(false);
  const [openFailed, setOpenFailed] = useState(false);
  const locked = disabled || isResponding;
  const link = checked.ok ? checked.link : null;
  const host = link?.displayHost.replace(/\.$/, "") ?? "";
  const hostPrefix =
    link !== null && host.endsWith(link.registrableDomain)
      ? host.slice(0, host.length - link.registrableDomain.length)
      : host;

  const open = () => {
    if (locked || link === null) return;
    setOpenFailed(false);
    // The string exactly as the server sent it: nothing added, nothing changed.
    openLink(link.url).then(
      () => setOpened(true),
      () => setOpenFailed(true),
    );
  };

  return (
    <div
      role="group"
      aria-label={tx("{server} asks you to open a link", { server: elicitation.serverName })}
      className="flex min-w-0 flex-1 flex-col items-stretch gap-2.5"
      data-mcp-elicitation-url=""
    >
      <span className="flex w-full min-w-0 items-center gap-2 text-2xs text-muted-foreground">
        <span className="min-w-0 truncate font-medium text-warning-foreground">
          {tx("{server} asks you to open a link", { server: elicitation.serverName })}
        </span>
        <OnActionMachine machine={machine} />
        {pendingCount > 1 ? (
          <span className="ml-auto shrink-0 tabular-nums">
            {renderRich(tx("1 of {pendingCount}"), { pendingCount })}
          </span>
        ) : null}
      </span>
      <span className="text-sm text-foreground whitespace-pre-wrap wrap-break-word">
        {elicitation.message}
      </span>
      {link === null ? (
        <span className="text-xs text-muted-foreground" role="status">
          {tx("This link can't be shown. Decline or cancel it.")}
        </span>
      ) : (
        <div className="flex min-w-0 flex-col gap-1 rounded-md bg-foreground/[0.04] px-2.5 py-1.5 dark:bg-foreground/[0.06]">
          <span className="text-xs text-foreground wrap-anywhere" data-url-host="">
            <span className="text-muted-foreground">{hostPrefix}</span>
            <mark
              className="rounded-sm bg-warning/15 px-0.5 font-semibold text-foreground"
              data-url-registrable-domain=""
            >
              {link.registrableDomain}
            </mark>
          </span>
          <code
            aria-label={tx("Link")}
            className="block max-h-24 overflow-y-auto font-mono text-2xs/4 text-muted-foreground whitespace-pre-wrap wrap-anywhere [scrollbar-width:thin]"
            data-url-full=""
          >
            {link.url}
          </code>
        </div>
      )}
      {link?.warnings.map((warning) => (
        <span
          key={warning}
          role="alert"
          data-url-warning={warning}
          className="rounded-md border-l-2 border-warning bg-warning/10 px-2 py-1.5 text-xs/5 text-foreground"
        >
          {tx(WARNING_TEXT[warning])}
        </span>
      ))}
      {openFailed ? (
        <span role="alert" className="text-2xs text-destructive-foreground">
          {tx("The link didn't open. Copy it from above, or decline.")}
        </span>
      ) : null}
      <span className="text-2xs text-muted-foreground">
        {tx(
          "Open it only if you trust {server}. SpecWithCode sends nothing with the link. Come back when you're done.",
          { server: elicitation.serverName },
        )}
      </span>
      <div
        data-approval-actions=""
        className="flex w-full min-w-0 flex-wrap-reverse items-center gap-2 @max-[420px]:flex-col-reverse @max-[420px]:flex-nowrap @max-[420px]:items-stretch"
      >
        <Button
          type="button"
          size="sm"
          variant="outline"
          className={cn(BUTTON_CLASS, "me-auto @max-[420px]:me-0")}
          data-approval-decision="cancel"
          disabled={locked}
          onClick={() => {
            if (!locked) void onRespond(requestId, "cancel");
          }}
        >
          {tx("Cancel")}
        </Button>
        <Button
          type="button"
          size="sm"
          variant="outline"
          className={BUTTON_CLASS}
          data-approval-decision="decline"
          disabled={locked}
          onClick={() => {
            if (!locked) void onRespond(requestId, "decline");
          }}
        >
          {tx("Decline")}
        </Button>
        <Button
          type="button"
          size="sm"
          variant={opened ? "outline" : "default"}
          className={BUTTON_CLASS}
          data-url-open=""
          disabled={locked || link === null}
          onClick={open}
        >
          {tx("Open link")}
        </Button>
        <Button
          type="button"
          size="sm"
          variant={opened ? "default" : "outline"}
          className={BUTTON_CLASS}
          data-approval-decision="accept"
          disabled={locked || link === null}
          onClick={() => {
            if (!locked && link !== null)
              void onRespond(requestId, "accept", { ...MCP_ELICITATION_URL_DONE_ANSWER });
          }}
        >
          {tx("I'm done, continue")}
        </Button>
      </div>
    </div>
  );
});
