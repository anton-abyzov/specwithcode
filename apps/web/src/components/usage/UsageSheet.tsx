import { useLocation } from "@tanstack/react-router";
import { useEffect, useRef } from "react";

import { readSettingsOpener, restoreSettingsFocus } from "../settings/settingsReturnFocus";
import { UsagePage } from "./UsagePage";
import { closeUsageSheet, useUsageSheetRequest } from "./usageSheetStore";
import type { UsageMetric } from "./usageShortcuts";

function UsageSheet({ metric }: { readonly metric: UsageMetric }) {
  // The opener tracker skips popups, so this is the chip that opened the popover.
  const opener = useRef(readSettingsOpener());
  useEffect(() => {
    const returnTo = opener.current;
    return () => restoreSettingsFocus(returnTo);
  }, []);
  return <UsagePage variant="sheet" initialMetric={metric} onClose={closeUsageSheet} />;
}

/** Renders the sheet `openUsageSheet` asks for, over whatever page is open. */
export function UsageSheetHost() {
  const request = useUsageSheetRequest((state) => state.request);
  const pathname = useLocation({ select: (location) => location.pathname });
  // A sheet belongs to the page it opened over; navigating elsewhere closes it.
  const openedOn = useRef(pathname);
  useEffect(() => {
    if (request === null) openedOn.current = pathname;
    else if (openedOn.current !== pathname) closeUsageSheet();
  }, [pathname, request]);
  useEffect(() => () => closeUsageSheet(), []);
  return request ? <UsageSheet key={request.key} metric={request.metric} /> : null;
}
