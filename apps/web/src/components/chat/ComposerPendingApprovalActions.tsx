import {
  type ProviderApprovalDecision,
  type ProviderApprovalOption,
  type RuntimeRequestId,
} from "@specweave-studio/contracts";
import { memo, type ReactElement } from "react";
import { TriangleAlertIcon } from "lucide-react";
import { cn } from "~/lib/utils";
import { Button } from "../ui/button";
import { Tooltip, TooltipPopup, TooltipTrigger } from "../ui/tooltip";
import { FullAccessGlyph } from "./AccessGlyph";
import { DEFAULT_APPROVAL_OPTIONS, orderApprovalOptions } from "./approvalOptions";

interface ComposerPendingApprovalActionsProps {
  requestId: RuntimeRequestId;
  isResponding: boolean;
  canRespond: boolean;
  disabled?: boolean;
  options?: ReadonlyArray<ProviderApprovalOption> | undefined;
  onRespondToApproval: (
    requestId: RuntimeRequestId,
    decision: ProviderApprovalDecision,
  ) => Promise<unknown>;
  /** Shown beside Cancel when the chat can switch to Full access from here. */
  onSwitchToFullAccess?: (() => void) | undefined;
}

// "sm" matches the coordinator's question and plan actions and the question
// step footer (h-7 on desktop, h-8 on touch), so every request reads alike.
// Below a 420px container the row becomes a full-width stack, accept on top.
const BUTTON_CLASS = "min-w-20 max-w-full @max-[420px]:w-full";
const GROUP_CLASS =
  "flex min-w-0 flex-wrap items-center gap-2 @max-[420px]:flex-col-reverse @max-[420px]:flex-nowrap @max-[420px]:items-stretch";

export const ComposerPendingApprovalActions = memo(function ComposerPendingApprovalActions({
  requestId,
  isResponding,
  canRespond,
  disabled = false,
  options = DEFAULT_APPROVAL_OPTIONS,
  onRespondToApproval,
  onSwitchToFullAccess,
}: ComposerPendingApprovalActionsProps) {
  const { cancel, decisions } = orderApprovalOptions(options);
  // A request whose provider is gone takes no answer, from any button.
  const locked = disabled || isResponding || !canRespond;

  const renderOption = (option: ProviderApprovalOption): ReactElement => {
    const button = (
      <Button
        key={option.decision}
        size="sm"
        variant={
          option.decision === "accept"
            ? "default"
            : option.decision === "cancel"
              ? "ghost-muted"
              : "outline"
        }
        className={BUTTON_CLASS}
        data-approval-decision={option.decision}
        disabled={locked}
        title={option.warning ? undefined : option.label}
        aria-description={option.warning}
        onClick={() => {
          if (!locked) void onRespondToApproval(requestId, option.decision);
        }}
      >
        {option.warning ? (
          <TriangleAlertIcon className="size-3.5 shrink-0 text-warning-foreground" />
        ) : null}
        <span className="min-w-0 truncate">{option.label}</span>
      </Button>
    );
    return option.warning ? (
      <Tooltip key={option.decision}>
        <TooltipTrigger render={button} />
        <TooltipPopup side="top">
          <span className="block font-medium">{option.label}</span>
          {option.warning}
        </TooltipPopup>
      </Tooltip>
    ) : (
      button
    );
  };

  const hasSecondary = cancel !== undefined || onSwitchToFullAccess !== undefined;

  return (
    // wrap-reverse: when both groups do not fit one line, the decisions stay on the
    // line right under the request and Cancel drops below them.
    <div
      data-approval-actions=""
      className="flex w-full min-w-0 flex-wrap-reverse items-center gap-2 @max-[420px]:flex-col-reverse @max-[420px]:flex-nowrap @max-[420px]:items-stretch"
    >
      {hasSecondary ? (
        <div className={cn(GROUP_CLASS, "me-auto @max-[420px]:me-0")}>
          {cancel ? renderOption(cancel) : null}
          {onSwitchToFullAccess ? (
            <Button
              size="sm"
              variant="ghost-muted"
              className={BUTTON_CLASS}
              data-approval-full-access=""
              disabled={locked}
              title="Approves this and future requests in this chat"
              onClick={() => {
                if (!locked) onSwitchToFullAccess();
              }}
            >
              <FullAccessGlyph className="size-3.5" />
              <span className="min-w-0 truncate">Switch chat to Full access</span>
            </Button>
          ) : null}
        </div>
      ) : null}
      <div className={cn(GROUP_CLASS, "ms-auto justify-end @max-[420px]:ms-0")}>
        {decisions.map(renderOption)}
      </div>
    </div>
  );
});
