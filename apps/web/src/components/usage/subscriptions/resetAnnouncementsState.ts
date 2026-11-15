import {
  AuthOrchestrationReadScope,
  type EnvironmentId,
  type ResetAnnouncement,
} from "@specweave-studio/contracts";
import { useEffect, useMemo, useState } from "react";

import { serverEnvironment } from "../../../state/server";
import { useEnvironmentsWithScope } from "../../../state/session";
import { useAtomCommand } from "../../../state/use-atom-command";

export interface ResetAnnouncementsView {
  /** Newest first. */
  readonly announcements: readonly ResetAnnouncement[];
  /** When the feed last answered; null before the first read or with the feed off. */
  readonly checkedAt: number | null;
  readonly enabled: boolean;
}

/** The feed's name for a provider, by the driver whose accounts it concerns. */
const DRIVER_OF_PROVIDER: ReadonlyMap<string, string> = new Map([
  ["codex", "codex"],
  ["openai", "codex"],
  ["claude", "claudeAgent"],
  ["anthropic", "claudeAgent"],
  ["grok", "grok"],
  ["cursor", "cursor"],
  ["muse", "muse"],
  ["meta", "muse"],
]);

/** Null for a provider the app has no subscription driver for: it is listed, never matched. */
export const announcementDriver = (provider: string): string | null =>
  DRIVER_OF_PROVIDER.get(provider.toLowerCase()) ?? null;

/**
 * The posts that may warn and notify: the verified feed's, while it is on. A post an
 * agent recorded (the reset watch routine) is only listed, marked unverified.
 */
export const alertingAnnouncements = (
  feed: Pick<ResetAnnouncementsView, "announcements" | "enabled"> | null | undefined,
): readonly ResetAnnouncement[] =>
  feed?.enabled === true
    ? feed.announcements.filter((announcement) => announcement.origin !== "recorded")
    : [];

/**
 * Reset announcements as the main machine last read them. One machine reads
 * the feed, so a list never differs between the machines a person looks from.
 * Null until the first read lands, and for a server too old to have them.
 */
export function useResetAnnouncements(
  environmentId: EnvironmentId | null,
  refreshKey: number,
): ResetAnnouncementsView | null {
  const read = useAtomCommand(serverEnvironment.resetAnnouncements, {
    reportFailure: false,
    reportDefect: false,
  });
  const [view, setView] = useState<ResetAnnouncementsView | null>(null);
  const requested = useMemo(
    () => (environmentId === null ? [] : [{ environmentId }]),
    [environmentId],
  );
  const permitted = useEnvironmentsWithScope(requested, AuthOrchestrationReadScope);
  const allowed = environmentId !== null && permitted.has(environmentId) ? environmentId : null;
  useEffect(() => {
    if (allowed === null) {
      setView(null);
      return;
    }
    let cancelled = false;
    void Promise.resolve(read({ environmentId: allowed, input: {} }))
      .then((result) => {
        if (cancelled || result?._tag !== "Success") return;
        const checked = Date.parse(result.value.checkedAt ?? "");
        setView({
          announcements: result.value.announcements,
          checkedAt: Number.isFinite(checked) ? checked : null,
          enabled: result.value.enabled,
        });
      })
      .catch(() => undefined);
    return () => {
      cancelled = true;
    };
  }, [allowed, read, refreshKey]);
  return view;
}
