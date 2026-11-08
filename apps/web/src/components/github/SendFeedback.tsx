import { MessageSquareIcon } from "lucide-react";
import { useCallback } from "react";

import { APP_VERSION } from "../../branding";
import { useTx } from "../../i18n";
import { ensureLocalApi } from "../../localApi";
import { useEnvironments } from "../../state/environments";
import { Button } from "../ui/button";
import { Menu, MenuItem, MenuPopup, MenuSeparator, MenuTrigger } from "../ui/menu";
import { FEEDBACK_DISCUSSIONS_URL, feedbackIssueUrl, type FeedbackKind } from "./feedback";

function openExternal(url: string) {
  void ensureLocalApi().shell.openExternal(url);
}

/** Opens a prefilled GitHub issue form for this client. */
export function useOpenFeedback(): (kind: FeedbackKind) => void {
  const { environments } = useEnvironments();
  const machineCount = Math.max(1, environments.length);
  return useCallback(
    (kind) => {
      const bridge = typeof window === "undefined" ? undefined : window.desktopBridge;
      const platform =
        bridge?.getClientPlatform?.() ??
        (typeof navigator === "undefined" ? "" : navigator.platform);
      openExternal(
        feedbackIssueUrl(kind, {
          version: APP_VERSION,
          platform,
          desktop: Boolean(bridge),
          machineCount,
        }),
      );
    },
    [machineCount],
  );
}

/** Settings > About: Bug, Idea or Question, plus Discussions. */
export function SendFeedbackButton() {
  const tx = useTx();
  const openFeedback = useOpenFeedback();
  return (
    <Menu>
      <MenuTrigger render={<Button size="sm" variant="outline" />}>
        <MessageSquareIcon className="size-3.5" aria-hidden="true" />
        {tx("Send feedback")}
      </MenuTrigger>
      <MenuPopup align="end">
        <MenuItem onClick={() => openFeedback("bug")}>{tx("Report a bug")}</MenuItem>
        <MenuItem onClick={() => openFeedback("idea")}>{tx("Suggest an idea")}</MenuItem>
        <MenuItem onClick={() => openFeedback("question")}>{tx("Ask a question")}</MenuItem>
        <MenuSeparator />
        <MenuItem onClick={() => openExternal(FEEDBACK_DISCUSSIONS_URL)}>
          {tx("Open Discussions")}
        </MenuItem>
      </MenuPopup>
    </Menu>
  );
}
