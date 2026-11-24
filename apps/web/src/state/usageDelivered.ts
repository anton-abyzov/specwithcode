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
  // One read per machine and range: a new range never joins the previous range's pending read.
  concurrency: {
    mode: "singleFlight",
    key: ({ environmentId, input }) =>
      `${environmentId}|${input.sinceDay}|${input.untilDay}|${input.timeZone}`,
  },
});
