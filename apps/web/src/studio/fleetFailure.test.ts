import {
  EnvironmentHttpBadRequestError,
  EnvironmentHttpForbiddenError,
} from "@specweave-studio/contracts";
import { executeEnvironmentHttpRequest } from "@specweave-studio/client-runtime/rpc";
import * as Cause from "effect/Cause";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import { describe, expect, it, vi } from "vite-plus/test";

vi.mock("@effect/atom-react", () => ({ useAtomValue: () => null }));

import { fleetAddFailureMessage } from "./fleet";

const failureOf = async (error: Error): Promise<Cause.Cause<unknown>> => {
  const exit = await Effect.runPromiseExit(
    executeEnvironmentHttpRequest(
      "http://server/api/studio/fleet/machines",
      1000,
      Effect.fail(error),
    ),
  );
  if (!Exit.isFailure(exit)) throw new Error("expected a failure");
  return exit.cause;
};

describe("fleetAddFailureMessage", () => {
  it("keeps the server's words through the request layer", async () => {
    const message = "This line was made for a different main machine, so it no longer works.";
    const cause = await failureOf(new EnvironmentHttpBadRequestError({ message }));
    expect(fleetAddFailureMessage(cause)).toBe(message);
  });

  it("keeps a team rule's refusal", async () => {
    const message = "Team rules do not allow linking machines here.";
    const cause = await failureOf(new EnvironmentHttpForbiddenError({ message }));
    expect(fleetAddFailureMessage(cause)).toBe(message);
  });

  it("falls back only when the server said nothing", async () => {
    const cause = await failureOf(new TypeError("network down"));
    expect(fleetAddFailureMessage(cause)).toBe("Could not add this machine. Refresh, then retry.");
  });
});
