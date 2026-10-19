import { useAtomValue } from "@effect/atom-react";
import { HardDriveIcon, XIcon } from "lucide-react";
import { memo, useCallback, useMemo, useState } from "react";

import { APP_BASE_NAME } from "../branding";
import { isElectron } from "../env";
import { useEnvironments, usePrimaryEnvironmentId } from "../state/environments";
import { environmentStorageStatusesAtom } from "../state/server";
import { resolveLowDiskSpaceNotices, type LowDiskSpaceNotice } from "./LowDiskSpaceBanner.logic";
import { Alert, AlertAction, AlertDescription, AlertTitle } from "./ui/alert";
import { Button } from "./ui/button";

const DISMISSED_STORAGE_KEY = "studio:low-disk-space-dismissed:v1";

// Dismissals last for the window session: a reload keeps the banner closed,
// a new launch shows it again while the disk is still low.
function readDismissed(): ReadonlySet<string> {
  try {
    const raw = window.sessionStorage.getItem(DISMISSED_STORAGE_KEY);
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
    window.sessionStorage.setItem(DISMISSED_STORAGE_KEY, JSON.stringify([...dismissed]));
  } catch {
    // Unavailable storage still dismisses for as long as this page lives.
  }
}

export const LowDiskSpaceNoticeCard = memo(function LowDiskSpaceNoticeCard({
  notice,
  onDismiss,
}: {
  notice: LowDiskSpaceNotice;
  onDismiss: () => void;
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
      <AlertDescription>{notice.message}</AlertDescription>
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
 * The app shell's one place for a full disk: a single notice per machine,
 * instead of every thread and chat reporting its own timeout.
 */
export function LowDiskSpaceBanner() {
  const statuses = useAtomValue(environmentStorageStatusesAtom);
  const primaryEnvironmentId = usePrimaryEnvironmentId();
  const { environments } = useEnvironments();
  const [dismissed, setDismissed] = useState(readDismissed);

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
    setDismissed((current) => {
      const next = new Set(current).add(key);
      writeDismissed(next);
      return next;
    });
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
        />
      ))}
    </div>
  );
}
