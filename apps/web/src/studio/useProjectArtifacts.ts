/**
 * The project's artifacts for the shelf above Threads and the Library's
 * Artifacts view: the Library snapshot, designs and what this device's thread
 * artifact lists recorded, with the person's pins. Pins live on this device,
 * per project, as a thread's artifact pins do.
 */
import type {
  DesignSummary,
  EnvironmentId,
  ProjectId,
  ProjectLibrarySnapshot,
} from "@specweave-studio/contracts";
import type { EnvironmentThreadShell } from "@specweave-studio/client-runtime/state/shell";
import * as Schema from "effect/Schema";
import { useCallback, useEffect, useMemo, useState } from "react";

import { readOriginSnapshot } from "../components/chat/useArtifactShelfState";
import { useLocalStorage } from "../hooks/useLocalStorage";
import { useEnvironmentQuery } from "../state/query";
import {
  collectProjectArtifacts,
  type ProjectArtifact,
  type ProjectArtifactThread,
  type ProjectThreadArtifacts,
} from "./projectArtifacts";
import { projectWorkspace } from "./projectWorkspace";

/** Prefix of the per-thread artifact list snapshots `readOriginSnapshot` reads. */
const THREAD_SNAPSHOT_PREFIX = "studio:artifact-shelf:v2:";

/**
 * Bumps when a thread's artifact list snapshot is written, here or in another
 * window, so the shelf picks up files a thread makes while it is open.
 */
function useThreadSnapshotVersion() {
  const [version, setVersion] = useState(0);
  useEffect(() => {
    const bump = (key: string | null | undefined) => {
      if (key == null || key.startsWith(THREAD_SNAPSHOT_PREFIX)) setVersion((n) => n + 1);
    };
    const onLocal = (event: Event) => bump((event as CustomEvent<{ key?: string }>).detail?.key);
    const onStorage = (event: StorageEvent) => bump(event.key);
    window.addEventListener("studio:local_storage_change", onLocal);
    window.addEventListener("storage", onStorage);
    return () => {
      window.removeEventListener("studio:local_storage_change", onLocal);
      window.removeEventListener("storage", onStorage);
    };
  }, []);
  return version;
}

const PinsSchema = Schema.Array(Schema.String);
const NO_PINS: ReadonlyArray<string> = [];
/** Enough for any project; the oldest pin drops first past it. */
const PIN_LIMIT = 200;

export function projectArtifactPinsKey(environmentId: EnvironmentId, projectId: ProjectId) {
  return `studio:project-artifacts:v1:${environmentId}:${projectId}`;
}

export function useProjectArtifactPins(environmentId: EnvironmentId, projectId: ProjectId) {
  const [stored, setStored] = useLocalStorage(
    projectArtifactPinsKey(environmentId, projectId),
    NO_PINS,
    PinsSchema,
  );
  const pinned = useMemo(() => new Set(stored), [stored]);
  const setPinned = useCallback(
    (id: string, on: boolean) =>
      setStored((current) => {
        const rest = current.filter((entry) => entry !== id);
        return on ? [...rest, id].slice(-PIN_LIMIT) : rest;
      }),
    [setStored],
  );
  return { pinned, setPinned };
}

export interface ProjectArtifacts {
  readonly artifacts: ReadonlyArray<ProjectArtifact>;
  readonly library: ProjectLibrarySnapshot | null;
  readonly loaded: boolean;
  readonly setPinned: (id: string, on: boolean) => void;
  readonly refresh: () => void;
}

export function useProjectArtifacts(input: {
  readonly environmentId: EnvironmentId;
  readonly projectId: ProjectId;
  readonly workspaceRoot: string;
  readonly enabled: boolean;
  readonly threads: ReadonlyArray<EnvironmentThreadShell>;
  readonly designs: ReadonlyArray<DesignSummary>;
}): ProjectArtifacts {
  const { environmentId, projectId, workspaceRoot, threads, designs } = input;
  const query = useEnvironmentQuery(
    input.enabled ? projectWorkspace.library({ environmentId, input: { projectId } }) : null,
  );
  const library = query.data ?? null;
  const { pinned, setPinned } = useProjectArtifactPins(environmentId, projectId);

  // Thread shells change on every live update; their snapshots only when the
  // set of threads or their titles do.
  const threadKey = threads
    .filter((thread) => thread.deletedAt === null)
    .map(
      (thread) =>
        `${thread.environmentId}\u0000${thread.id}\u0000${thread.title}\u0000${thread.worktreePath ?? ""}`,
    )
    .join("\u0001");
  const snapshotVersion = useThreadSnapshotVersion();
  const threadArtifacts = useMemo(() => {
    // Read again whenever a snapshot is written.
    void snapshotVersion;
    const result: ProjectThreadArtifacts[] = [];
    for (const line of threadKey === "" ? [] : threadKey.split("\u0001")) {
      const [threadEnvironment, threadId, title, root] = line.split("\u0000") as [
        string,
        string,
        string,
        string,
      ];
      const thread = {
        environmentId: threadEnvironment,
        threadId,
        title: title || "Untitled thread",
        root: root || null,
      } as ProjectArtifactThread;
      const entries = readOriginSnapshot(thread);
      if (entries.length > 0) result.push({ thread, entries });
    }
    return result;
  }, [threadKey, snapshotVersion]);

  const threadsById = useMemo(() => {
    const map = new Map<string, ProjectArtifactThread>();
    for (const thread of threads) {
      map.set(thread.id, {
        environmentId: thread.environmentId,
        threadId: thread.id,
        title: thread.title || "Untitled thread",
        root: thread.worktreePath,
      });
    }
    return map;
  }, [threads]);

  const artifacts = useMemo(
    () =>
      collectProjectArtifacts({
        workspaceRoot: library?.workspaceRoot ?? workspaceRoot,
        library,
        designs,
        threadArtifacts,
        threadOf: (threadId) => threadsById.get(threadId) ?? null,
        pinned,
      }),
    [library, workspaceRoot, designs, threadArtifacts, threadsById, pinned],
  );

  return {
    artifacts,
    library,
    // Disconnected, there is nothing to wait for: show what this device has.
    loaded: !input.enabled || library !== null || query.error !== null || !query.isPending,
    setPinned,
    refresh: query.refresh,
  };
}
