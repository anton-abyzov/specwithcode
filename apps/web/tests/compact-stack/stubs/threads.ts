// The real module, with the queue's commands named rather than wired to a server.
import { threadEnvironment as realThreadEnvironment } from "../../../src/state/threads";

export * from "../../../src/state/threads";

export const threadEnvironment = {
  ...realThreadEnvironment,
  cancelQueuedRun: "cancel",
  promoteQueuedRun: "promote",
  reorderQueuedRun: "reorder",
} as unknown as typeof realThreadEnvironment;
