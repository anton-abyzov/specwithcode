// `?remote`: workers the coordinator started on the Ministorm Linux machine, in the
// shape of the October 31, 2026 screenshot: two finished in yesterday's turn and one
// still working from the latest turn. Stands in for studio/fleet in the timeline.
import { minutesAgo } from "./mockData";

export const REMOTE_WORKERS_REFRESH_MS = 10_000;

const remote = new URLSearchParams(window.location.search).has("remote");
const worker = (
  id: string,
  title: string,
  launchedAt: string,
  state: string,
  lastStatus: string,
) => ({
  id,
  machineId: "ministorm",
  machineLabel: "Ministorm",
  environmentId: "ministorm-env",
  callerThreadId: "coordinator",
  remoteThreadId: `${id}-thread`,
  threadRef: null,
  title,
  state,
  lastStatus,
  reachable: true,
  launchedAt,
  updatedAt: minutesAgo(0, -5),
});
const workers = remote
  ? [
      worker("rwt:os", "Ministorm root and OS check", minutesAgo(26 * 60, 5), "idle", "completed"),
      worker("rwt:proof", "Ministorm proof run", minutesAgo(26 * 60, 20), "idle", "completed"),
      worker("rwt:live", "Ministorm build check", minutesAgo(1, 5), "following", "running"),
    ]
  : [];

export function useProjectRemoteWorkers() {
  return { workers, loaded: true, available: false, refresh: () => {} };
}
