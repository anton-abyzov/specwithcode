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

import { accountJoinFailureMessage, fleetAddFailureMessage } from "./fleet";

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

describe("accountJoinFailureMessage", () => {
  it("keeps the other machine's refusal", async () => {
    const message = "A phone cannot add a machine.";
    const cause = await failureOf(new EnvironmentHttpForbiddenError({ message }));
    expect(accountJoinFailureMessage(cause, "M4")).toBe(message);
  });

  it("says a retry is safe and where to tidy up when the machine never answered", async () => {
    const said = accountJoinFailureMessage(await failureOf(new TypeError("timed out")), "M4");
    expect(said).toContain("M4 did not answer in time.");
    expect(said).toContain("a retry is safe if it added this machine anyway");
    expect(said).toContain("Settings > Machines > Authorized clients on this machine");
  });
});
