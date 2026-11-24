import { useTx } from "../../i18n";
import { memo, useRef } from "react";
import { Check, Copy } from "lucide";
import { Button } from "../ui/button";
import { MorphIcon } from "~/components/MorphIcon";
import { cn } from "~/lib/utils";
import { useCopyToClipboard } from "~/hooks/useCopyToClipboard";
import {
  ANCHORED_COPY_TOAST_TIMEOUT_MS,
  showAnchoredCopyErrorToast,
  showAnchoredCopySuccessToast,
} from "../ui/anchoredCopyToast";
import { Tooltip, TooltipPopup, TooltipTrigger } from "../ui/tooltip";

/** A reply consisting entirely of an explicit quote can be pasted as the quoted text. */
function unwrapQuotedReply(text: string): string {
  const lines = text.replace(/\r\n?/g, "\n").split("\n");
  const quotePrefix = /^ {0,3}>(?:[ \t]|(?=>|$))/;
  if (lines.some((line) => line.trim() !== "" && !quotePrefix.test(line))) return text;

  const unquoted = lines.map((line) => line.replace(quotePrefix, "")).join("\n");
  // GitHub alerts use the same wrapper to carry their alert type.
  if (/^\s*\[!(?:NOTE|TIP|IMPORTANT|WARNING|CAUTION)\]/i.test(unquoted)) return text;
  return unquoted.trim() ? unquoted : text;
}

export const MessageCopyButton = memo(function MessageCopyButton({
  text,
  extraFlavors,
  copyQuotedReply = false,
  size = "xs",
  variant = "outline",
  className,
}: {
  text: string;
  copyQuotedReply?: boolean;
  /** Additional clipboard types written beside `text/plain` when the platform allows it. */
  extraFlavors?: Readonly<Record<string, string>>;
  size?: "xs" | "icon-xs";
  variant?: "outline" | "ghost";
  className?: string;
}) {
  const tx = useTx();
  const ref = useRef<HTMLButtonElement>(null);
  const { copyToClipboard, isCopied } = useCopyToClipboard<void>({
    onCopy: () => showAnchoredCopySuccessToast(ref),
    onError: (error: Error) => showAnchoredCopyErrorToast(ref, error),
    timeout: ANCHORED_COPY_TOAST_TIMEOUT_MS,
    ...(extraFlavors ? { extraFlavors } : {}),
  });

  return (
    <Tooltip>
      <TooltipTrigger
        render={
          <Button
            aria-label={tx("Copy message")}
            disabled={isCopied}
            onClick={() => copyToClipboard(copyQuotedReply ? unwrapQuotedReply(text) : text)}
            ref={ref}
            type="button"
            size={size}
            variant={variant === "ghost" ? "ghost-muted" : variant}
            className={className}
          />
        }
      >
        <MorphIcon
          className={cn("size-3", isCopied && "text-primary")}
          icon={isCopied ? Check : Copy}
        />
      </TooltipTrigger>
      <TooltipPopup>
        <p>{tx("Copy message")}</p>
      </TooltipPopup>
    </Tooltip>
  );
});
