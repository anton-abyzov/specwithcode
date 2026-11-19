/** Features implemented by this server, including the opt-in non-acknowledging read. */
export const orchestratorFeatures = (limits: {
  readonly maxLiveChildTasks: number;
  readonly maxDepth: number;
}) => ({
  appOwnedSubagents: true,
  asyncPolling: true,
  cancellation: true,
  batchThreadCreation: true,
  threadManagement: true,
  incrementalThreadRead: true,
  readThreadWithoutAcknowledgement: true,
  scheduledTasks: true,
  // studio_project_create takes machine, parentPath and github.
  projectCreateOptions: true,
  // studio_project_create takes specweave and says how SpecWeave setup went (1396).
  projectCreateSpecweave: true,
  maxBatchThreads: 20,
  maxLiveChildTasks: limits.maxLiveChildTasks,
  maxDelegationDepth: limits.maxDepth,
});
