export const REMOTE_WORKERS_REFRESH_MS = 60_000;
export const useProjectRemoteWorkers = () => ({
  workers: [],
  available: false,
  refresh: () => undefined,
});
