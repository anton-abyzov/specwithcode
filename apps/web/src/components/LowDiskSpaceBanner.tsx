import { useAtomValue } from "@effect/atom-react";
import { useNavigate } from "@tanstack/react-router";
import { HardDriveIcon, XIcon } from "lucide-react";
import { memo, useCallback, useEffect, useMemo, useState } from "react";

import { APP_BASE_NAME } from "../branding";
import { isElectron } from "../env";
import { useEnvironments, usePrimaryEnvironmentId } from "../state/environments";
import { environmentStorageStatusesAtom } from "../state/server";
import {
  forgetRecoveredDismissals,
  resolveLowDiskSpaceNotices,
  type LowDiskSpaceNotice,
} from "./LowDiskSpaceBanner.logic";
import { Alert, AlertAction, AlertDescription, AlertTitle } from "./ui/alert";
import { Button } from "./ui/button";

const DISMISSED_STORAGE_KEY = "studio:low-disk-space-dismissed:v2";

// Dismissals stick on this device across reloads, launches and windows. Keys
// are per machine and level, so a dismissed low notice comes back if that
// disk turns critical; once the disk has room again its dismissals are
// forgotten, so the next low episode warns again.
function readDismissed(): ReadonlySet<string> {
  try {
    const raw = window.localStorage.getItem(DISMISSED_STORAGE_KEY);
    const parsed: unknown = raw === null ? [] : JSON.parse(raw);
    return new Set(
      Array.isArray(parsed) ? parsed.filter((key) => typeof key === "string") : undefined,
    );
  } catch {
    return new Set();
  }
}

function writeDismissed(dismissed: ReadonlySet<string>) {
  try {
    window.localStorage.setItem(DISMISSED_STORAGE_KEY, JSON.stringify([...dismissed]));
  } catch {
    // Unavailable storage still dismisses for as long as this page lives.
  }
}

export const LowDiskSpaceNoticeCard = memo(function LowDiskSpaceNoticeCard({
  notice,
  onDismiss,
  onReviewStorage,
}: {
  notice: LowDiskSpaceNotice;
  onDismiss: () => void;
  onReviewStorage?: () => void;
}) {
  return (
    <Alert
      variant={notice.level === "critical" ? "error" : "warning"}
      surface="glass"
      role="status"
      controlAlignment="first-line"
      className="pointer-events-auto w-full"
      data-low-disk-space={notice.level}
    >
      <HardDriveIcon />
      <AlertTitle>{notice.title}</AlertTitle>
      <AlertDescription>
        {notice.message}
        {notice.action === "review-storage" && onReviewStorage !== undefined && (
          <Button className="w-fit" onClick={onReviewStorage} size="xs" variant="outline">
            Review storage
          </Button>
        )}
      </AlertDescription>
      <AlertAction>
        <Button
          aria-label="Dismiss low disk space notice"
          onClick={onDismiss}
          size="icon-xs"
          variant="ghost-muted"
        >
          <XIcon />
        </Button>
      </AlertAction>
    </Alert>
  );
});

/**
 * The app shell's one place for a full disk: a single notice per machine
 * that is actually running low (see resolveLowDiskSpaceNotices), instead of
 * every thread and chat reporting its own timeout. Folder size alone shows
 * only in Settings > Storage.
 */
export function LowDiskSpaceBanner() {
  const statuses = useAtomValue(environmentStorageStatusesAtom);
  const primaryEnvironmentId = usePrimaryEnvironmentId();
  const { environments } = useEnvironments();
  const [dismissed, setDismissed] = useState(readDismissed);
  const navigate = useNavigate();
  const reviewStorage = useCallback(() => {
    void navigate({ to: "/settings/storage" });
  }, [navigate]);

  // Another window dismissed a notice, or forgot dismissals.
  useEffect(() => {
    const onStorage = (event: StorageEvent) => {
      if (event.key === DISMISSED_STORAGE_KEY) setDismissed(readDismissed());
    };
    window.addEventListener("storage", onStorage);
    return () => window.removeEventListener("storage", onStorage);
  }, []);

  // A machine whose disk has room again loses its dismissals, adjusted
  // during render when the statuses change.
  const [checkedStatuses, setCheckedStatuses] = useState(statuses);
  if (checkedStatuses !== statuses) {
    setCheckedStatuses(statuses);
    const next = forgetRecoveredDismissals(dismissed, statuses);
    if (next !== dismissed) setDismissed(next);
  }

  // Equal values are not rewritten, so windows do not echo each other.
  useEffect(() => writeDismissed(dismissed), [dismissed]);

  const notices = useMemo(() => {
    const labels = new Map(environments.map(({ environmentId, label }) => [environmentId, label]));
    return resolveLowDiskSpaceNotices({
      statuses,
      primaryEnvironmentId,
      primaryIsThisMachine: isElectron,
      labelFor: (environmentId) => labels.get(environmentId),
      dismissed,
      appName: APP_BASE_NAME,
    });
  }, [dismissed, environments, primaryEnvironmentId, statuses]);

  const dismiss = useCallback((key: string) => {
    setDismissed((current) => new Set(current).add(key));
  }, []);

  if (notices.length === 0) return null;
  return (
    <div
      className="pointer-events-none fixed inset-x-0 top-[calc(var(--workspace-controls-top,0px)+var(--workspace-topbar-height,2.5rem)+0.5rem)] z-40 mx-auto flex w-[min(30rem,calc(100%-2rem))] flex-col gap-2"
      data-low-disk-space-banner=""
    >
      {notices.map((notice) => (
        <LowDiskSpaceNoticeCard
          key={notice.key}
          notice={notice}
          onDismiss={() => dismiss(notice.key)}
          onReviewStorage={reviewStorage}
        />
      ))}
    </div>
  );
}
