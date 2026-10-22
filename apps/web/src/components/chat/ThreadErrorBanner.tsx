import type { OrchestrationV2ProviderFailureClass } from "@specweave-studio/contracts";
import {
  isContextLimitError,
  providerFailureDisplayMessage,
  providerFailureDisplayTitle,
} from "@specweave-studio/shared/orchestrationV2ThreadError";
import { memo } from "react";
import { useClientSettings } from "../../hooks/useSettings";
import { formatDisplayDates } from "../../lib/displayDates";
import { Alert, AlertAction, AlertDescription, AlertTitle } from "../ui/alert";
import { Button } from "../ui/button";
import { CircleAlertIcon, XIcon } from "lucide-react";
import { Tooltip, TooltipPopup, TooltipTrigger } from "../ui/tooltip";
import { OpenAI } from "../Icons";
import { ChatGptUsageButton } from "../settings/ChatGptUsageButton";
import { ContextLimitRecovery, type ContextLimitRecoveryActions } from "./ContextLimitRecovery";

export function getThreadErrorBannerKey(threadKey: string, error: string | null): string | null {
  return error === null ? null : `${threadKey}\u0000${error}`;
}

export function shouldShowThreadErrorBanner(
  threadKey: string,
  error: string | null,
  isDismissed: boolean,
): boolean {
  return getThreadErrorBannerKey(threadKey, error) !== null && !isDismissed;
}

// Session-scoped (module-level so it survives ChatView remounts, e.g. route
// changes between threads). Mirrors the branch-mismatch banner: a dismissal
// is remembered per thread key plus message, so navigating away to a thread
// with no error cannot resurrect the banner, while a different error message
// on the same thread still appears.
const sessionDismissedThreadErrorBannerKeys = new Set<string>();

export function dismissThreadErrorBannerForSession(bannerKey: string | null): void {
  if (bannerKey !== null) {
    sessionDismissedThreadErrorBannerKeys.add(bannerKey);
  }
}

export function isThreadErrorBannerDismissedForSession(bannerKey: string | null): boolean {
  return bannerKey !== null && sessionDismissedThreadErrorBannerKeys.has(bannerKey);
}

export const ThreadErrorBanner = memo(function ThreadErrorBanner({
  error,
  onDismiss,
  errorClass,
  chatGptUsageLimit = false,
  contextLimitRecovery,
}: {
  error: string | null;
  errorClass?: OrchestrationV2ProviderFailureClass | null;
  onDismiss?: () => void;
  chatGptUsageLimit?: boolean;
  contextLimitRecovery?: ContextLimitRecoveryActions | undefined;
}) {
  const timestampFormat = useClientSettings((settings) => settings.timestampFormat);
  if (!error) return null;
  const failure = { class: errorClass ?? "unknown", message: error } as const;
  const cleanError = providerFailureDisplayMessage(failure);
  const displayError = formatDisplayDates(cleanError, timestampFormat);
  const contextLimit = errorClass !== "usage_limit" && isContextLimitError(error);
  const variant = errorClass === "usage_limit" || contextLimit ? "warning" : "error";
  return (
    <div className="pointer-events-auto mx-auto w-fit max-w-[min(48rem,calc(100%-2rem))] pt-3">
      <Alert variant={variant} surface="lane" controlAlignment="first-line" data-variant={variant}>
        {chatGptUsageLimit ? (
          <OpenAI className="size-4 text-foreground!" aria-hidden="true" />
        ) : (
          <CircleAlertIcon />
        )}
        {!chatGptUsageLimit ? (
          <AlertTitle>{providerFailureDisplayTitle(failure)}</AlertTitle>
        ) : null}
        <AlertDescription>
          {chatGptUsageLimit ? (
            <div className="space-y-1">
              <p className="font-medium">ChatGPT usage limit reached</p>
              <p>Review your usage settings in ChatGPT to continue.</p>
            </div>
          ) : (
            <Tooltip>
              <TooltipTrigger
                render={
                  <div
                    className={
                      displayError === cleanError && !contextLimit
                        ? "line-clamp-3"
                        : "whitespace-pre-wrap break-words"
                    }
                  />
                }
              >
                {displayError}
              </TooltipTrigger>
              <TooltipPopup side="top" className="whitespace-pre-wrap">
                {displayError}
              </TooltipPopup>
            </Tooltip>
          )}
          {contextLimit ? <ContextLimitRecovery recovery={contextLimitRecovery} /> : null}
        </AlertDescription>
        {(chatGptUsageLimit || onDismiss) && (
          <AlertAction>
            {chatGptUsageLimit ? <ChatGptUsageButton variant="default" size="sm" /> : null}
            {onDismiss ? (
              <Button variant="ghost" size="icon-xs" aria-label="Dismiss error" onClick={onDismiss}>
                <XIcon />
              </Button>
            ) : null}
          </AlertAction>
        )}
      </Alert>
    </div>
  );
});
