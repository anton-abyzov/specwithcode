/**
 * Workers this project's coordinator started on other machines. They are not
 * threads on this host, so each card names its machine and opens the thread
 * there when this browser is connected to that machine.
 */
import type { EnvironmentId, ProjectId } from "@specweave-studio/contracts";
import type { StudioFleetRemoteWorker } from "@specweave-studio/contracts/studioFleet";
import { ExternalLinkIcon, LaptopIcon } from "lucide-react";

import { useLiveRefresh } from "../../hooks/useLiveRefresh";
import { useOpenThread } from "../../hooks/useOpenThread";
import { useThreadShells } from "../../state/entities";
import { REMOTE_WORKERS_REFRESH_MS, useProjectRemoteWorkers } from "../../studio/fleet";
import { remoteWorkerCardStatus, visibleRemoteWorkers } from "../../studio/remoteWorkerCards";
import { Tip } from "./shell/Tip";

export function RemoteWorkerCards({
  environmentId,
  projectId,
  representedThreads = [],
}: {
  environmentId: EnvironmentId;
  projectId: ProjectId;
  representedThreads?: readonly { environmentId: string; id: string }[];
}) {
  const { workers, available, refresh } = useProjectRemoteWorkers(environmentId, projectId);
  useLiveRefresh(refresh, {
    enabled: available,
    key: `remote-workers:${environmentId}:${projectId}`,
    intervalMs: REMOTE_WORKERS_REFRESH_MS,
  });
  const threads = useThreadShells();
  const { openThread } = useOpenThread();
  const visible = visibleRemoteWorkers(workers, representedThreads);
  if (visible.length === 0) return null;
  return (
    <ul className="sws-thread-cards" aria-label="Workers on other machines">
      {visible.map((worker) => {
        const reachableHere =
          worker.remoteThreadId !== null &&
          threads.some(
            (thread) =>
              thread.environmentId === worker.environmentId && thread.id === worker.remoteThreadId,
          );
        return (
          <li key={worker.id}>
            <RemoteWorkerCard
              worker={worker}
              onOpen={
                reachableHere
                  ? () =>
                      void openThread({
                        environmentId: worker.environmentId,
                        threadId: worker.remoteThreadId!,
                      })
                  : null
              }
            />
          </li>
        );
      })}
    </ul>
  );
}

export function RemoteWorkerCard({
  worker,
  onOpen,
}: {
  worker: StudioFleetRemoteWorker;
  /** Null when this browser has no connection to that machine's thread. */
  onOpen: (() => void) | null;
}) {
  const status = remoteWorkerCardStatus(worker);
  const title = worker.title.trim() || "Untitled thread";
  return (
    <div
      className="sws-thread-card"
      role="group"
      aria-label={`Thread ${title} on ${worker.machineLabel}, ${status.label}`}
      data-remote-worker={worker.id}
    >
      <span className="sws-thread-card-head">
        <span className="sws-dot" data-tone={status.tone} aria-hidden />
        <Tip label={title} side="top">
          <span className="sws-thread-card-title">{title}</span>
        </Tip>
        <span
          className="sws-machine-chip"
          data-machine={worker.machineId}
          title={worker.machineLabel}
        >
          <LaptopIcon aria-hidden />
          <span className="min-w-0 truncate">{worker.machineLabel}</span>
        </span>
        <span className="sws-thread-card-status">{status.label}</span>
      </span>
      <span className="sws-thread-card-actions">
        {onOpen ? (
          <Tip label={`Open this thread on ${worker.machineLabel}`}>
            <button
              type="button"
              className="sws-thread-card-action"
              aria-label={`Open ${title} on ${worker.machineLabel}`}
              onClick={onOpen}
            >
              <ExternalLinkIcon aria-hidden />
              <span className="min-w-0 truncate">Open on {worker.machineLabel}</span>
            </button>
          </Tip>
        ) : (
          <span className="sws-thread-card-status">
            Connect {worker.machineLabel} in Settings &gt; Connections to open it here.
          </span>
        )}
      </span>
    </div>
  );
}
