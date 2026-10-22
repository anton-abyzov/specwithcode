/**
 * Message id prefixes of context overflow recovery's own runs (see
 * ContextOverflowRecoveryWorker), kept apart so the orchestrator and the
 * provider retry can read them without importing the worker.
 */
export const CONTEXT_COMPACT_MESSAGE_PREFIX = "context-compact:";
export const CONTEXT_RETRY_MESSAGE_PREFIX = "context-retry:";
