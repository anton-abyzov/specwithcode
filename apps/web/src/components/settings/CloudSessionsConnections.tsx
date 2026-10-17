import { useState } from "react";
import { CheckIcon, CloudIcon, CopyIcon, ExternalLinkIcon, RefreshCwIcon } from "lucide-react";
import {
  AuthOrchestrationReadScope,
  type CloudSessionRecord,
  type CloudSessionsSnapshot,
  cloudSessionTeleportCommand,
  type EnvironmentId,
} from "@specweave-studio/contracts";
import { useCloudSessions } from "../../studio/cloudSessions";
import { relativeTime } from "../../studio/overviewModel";
import { useEnvironmentScope } from "../../state/session";
import { Button } from "../ui/button";
import { SettingsSection, useRelativeTimeTick } from "./settingsLayout";
import { searchableSetting } from "./settingsSearch";

/** The last folder of the checkout, with its branch when known. */
export function cloudSessionPlace(session: Pick<CloudSessionRecord, "repositoryPath" | "branch">) {
  const folder =
    session.repositoryPath.split(/[\\/]/).findLast((part) => part.length > 0) ??
    session.repositoryPath;
  return session.branch ? `${folder} · ${session.branch}` : folder;
}

export function CloudSessionsConnections({ environmentId }: { environmentId: EnvironmentId }) {
  const { snapshot, loading, failed, refresh } = useCloudSessions(environmentId);
  const canRead = useEnvironmentScope(environmentId, AuthOrchestrationReadScope);
  const [refreshing, setRefreshing] = useState(false);
  const [copied, setCopied] = useState<string | null>(null);
  const now = useRelativeTimeTick(60_000);
  if (!canRead) return null;
  async function copy(sessionId: string) {
    try {
      await navigator.clipboard.writeText(cloudSessionTeleportCommand(sessionId));
      setCopied(sessionId);
      setTimeout(() => setCopied((current) => (current === sessionId ? null : current)), 2_000);
    } catch {
      setCopied(null);
    }
  }
  return (
    <CloudSessionsCard
      snapshot={snapshot}
      loading={loading || refreshing}
      failed={failed}
      copied={copied}
      now={now}
      onCopy={(sessionId) => void copy(sessionId)}
      onRefresh={() => {
        if (refreshing) return;
        setRefreshing(true);
        void refresh().finally(() => setRefreshing(false));
      }}
    />
  );
}

export function CloudSessionsCard({
  snapshot,
  loading,
  failed,
  copied = null,
  onCopy,
  onRefresh,
  now,
}: {
  snapshot: CloudSessionsSnapshot | null;
  loading: boolean;
  failed: boolean;
  copied?: string | null;
  onCopy: (sessionId: string) => void;
  onRefresh: () => void;
  now: number;
}) {
  const availability = snapshot?.availability ?? null;
  const ready = availability?.status === "ready";
  return (
    <SettingsSection
      {...searchableSetting("cloud-sessions")}
      title="Anthropic cloud sessions"
      headerAction={
        <Button size="xs" variant="ghost-muted" onClick={onRefresh} disabled={loading}>
          <RefreshCwIcon className="size-3" />
          {loading ? "Checking…" : "Refresh"}
        </Button>
      }
    >
      <div className="px-4 pb-3 text-xs leading-relaxed text-muted-foreground">
        <CloudIcon className="mr-1.5 inline size-3" />
        Claude Code sessions on Anthropic's VMs, started from this server with your own claude.ai
        plan. A coordinator starts one when you ask for work to run in the cloud; nothing leaves
        this machine except the pushed branch, or the committed files when you choose upload.
      </div>
      {failed ? (
        <p role="status" className="px-4 pb-4 text-sm text-muted-foreground">
          Cloud sessions could not be checked. Refresh to retry.
        </p>
      ) : availability === null ? (
        <p className="px-4 pb-4 text-sm text-muted-foreground">
          {loading ? "Checking Claude Code on this server…" : "Not available on this connection."}
        </p>
      ) : (
        <div className="space-y-3 px-4 pb-4">
          <div className="min-w-0 space-y-1" aria-label="Cloud session availability">
            <p className="flex items-center gap-1.5 text-xs">
              <span
                className={`size-1.5 shrink-0 rounded-full ${ready ? "bg-diff-addition" : "bg-warning-foreground"}`}
              />
              {ready ? "Ready" : "Not available"}
              {availability.cliVersion ? (
                <span className="text-muted-foreground">
                  · Claude Code {availability.cliVersion}
                </span>
              ) : null}
            </p>
            <p className="text-xs text-muted-foreground">{availability.reason}</p>
            {availability.fix ? (
              <p className="text-xs text-warning-foreground">{availability.fix}</p>
            ) : null}
          </div>
          {snapshot && snapshot.sessions.length > 0 ? (
            <ul className="divide-y divide-border/60 rounded-xl border border-border/70 bg-card">
              {snapshot.sessions.map((session) => (
                <li
                  key={session.sessionId}
                  className="flex min-w-0 flex-col gap-2 p-3 sm:flex-row sm:items-center sm:justify-between"
                  aria-label={session.title}
                >
                  <div className="min-w-0">
                    <a
                      className="block truncate text-sm font-medium hover:underline"
                      href={session.url}
                      target="_blank"
                      rel="noreferrer"
                    >
                      {session.title}
                      <ExternalLinkIcon className="ml-1 inline size-3 text-muted-foreground" />
                    </a>
                    <p className="truncate text-xs text-muted-foreground">
                      {cloudSessionPlace(session)}
                      {session.uploaded ? " · uploaded" : ""}
                    </p>
                    <code className="block truncate font-mono text-2xs text-muted-foreground">
                      {cloudSessionTeleportCommand(session.sessionId)}
                    </code>
                    <p className="text-2xs text-muted-foreground">
                      Started {relativeTime(session.createdAt, now)}
                      {session.lastSentAt
                        ? ` · last message ${relativeTime(session.lastSentAt, now)}`
                        : ""}
                    </p>
                  </div>
                  <Button
                    size="xs"
                    variant="outline"
                    className="shrink-0"
                    onClick={() => onCopy(session.sessionId)}
                    aria-label={`Copy the teleport command for ${session.title}`}
                  >
                    {copied === session.sessionId ? (
                      <CheckIcon className="size-3" />
                    ) : (
                      <CopyIcon className="size-3" />
                    )}
                    {copied === session.sessionId ? "Copied" : "Copy teleport command"}
                  </Button>
                </li>
              ))}
            </ul>
          ) : (
            <p className="text-xs text-muted-foreground">
              No cloud sessions started from this server yet. Continue one on this machine with the
              command next to it, run in a checkout of the same repository.
            </p>
          )}
        </div>
      )}
    </SettingsSection>
  );
}
