import type { PullRequestCheckFailureLogInput } from "@specweave-studio/contracts";
import * as Effect from "effect/Effect";
import * as PullRequestService from "./PullRequestService.ts";

/**
 * `pullRequests.checkFailureLog`, served as its own handler layer rather than inside ws.ts's
 * group-wide `toLayer`: that call's handler typing grows with the square of the group, and at
 * this size one more method there trips TypeScript's instantiation limit.
 */
export const handler = Effect.gen(function* () {
  const pullRequests = yield* PullRequestService.PullRequestService;
  return (input: PullRequestCheckFailureLogInput) =>
    pullRequests.withRoutingCredential(input, pullRequests.checkFailureLog(input));
});
