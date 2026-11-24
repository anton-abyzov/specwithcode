import { WS_METHODS } from "@specweave-studio/contracts";
import { createEnvironmentRpcCommand } from "@specweave-studio/client-runtime/state/runtime";

import { connectionAtomRuntime } from "../connection/runtime";

/**
 * What one machine's measured usage delivered, per increment (1456). Its own
 * module: the shared server atoms file is at its size limit.
 */
export const usageDeliveredReport = createEnvironmentRpcCommand(connectionAtomRuntime, {
  label: "environment-data:usage:delivered-report",
  tag: WS_METHODS.usageDeliveredReport,
  concurrency: { mode: "singleFlight", key: ({ environmentId }) => environmentId },
});
