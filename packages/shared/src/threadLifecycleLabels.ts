/** Presentation only. Persisted settled fields and command IDs remain compatible. */
export const THREAD_LIFECYCLE_LABELS = {
  resolve: "Resolve",
  resolved: "Resolved",
  reopen: "Reopen",
  reopening: "Reopening…",
  resolveThread: "Resolve thread",
  reopenThread: "Reopen thread",
  autoResolve: "Auto-resolve behavior",
  autoResolveMerged: "Auto-resolve verified merged threads",
  failedResolve: "Failed to resolve thread",
  failedReopen: "Failed to reopen thread",
  failedAutoResolve: "Failed to update auto-resolve",
  shortcut: "Thread: Resolve / Reopen",
} as const;
