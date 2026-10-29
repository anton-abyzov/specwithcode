import { describe, expect, it } from "@effect/vitest";
import {
  AuthAccessReadScope,
  AuthAccessWriteScope,
  EnvironmentId,
} from "@specweave-studio/contracts";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";

import type { PauseInput } from "./CoordinatorLease.ts";
import { maySuspend, suspend } from "./CoordinatorSuspendRoute.ts";

const desktop = {
  method: "bearer-access-token" as const,
  scopes: [AuthAccessReadScope, AuthAccessWriteScope],
};

const leaseStub = () => {
  const pauses: Array<PauseInput> = [];
  return {
    pauses,
    lease: {
      pause: (input: PauseInput) =>
        Effect.sync(() => {
          pauses.push(input);
          return 1;
        }),
    },
  };
};

describe("coordinator suspend route", () => {
  it("lets only this machine's own bearer with access:write announce a sleep", () => {
    expect(maySuspend(desktop)).toBe(true);
    expect(maySuspend({ ...desktop, method: "browser-session-cookie" })).toBe(false);
    expect(maySuspend({ ...desktop, scopes: [AuthAccessReadScope] })).toBe(false);
    expect(
      maySuspend({
        ...desktop,
        principal: { kind: "coordinator", environmentId: EnvironmentId.make("env-m1") },
      }),
    ).toBe(false);
  });

  it.effect("sends every standby a sleeping lease and reports how many answered", () =>
    Effect.gen(function* () {
      const { pauses, lease } = leaseStub();
      const outcome = yield* suspend({ session: Option.some(desktop), lease });
      expect(outcome).toEqual({ status: 200, body: { answered: 1 } });
      expect(pauses).toEqual([{ sleeping: true }]);
    }),
  );

  it.effect("refuses without a credential or with the wrong one, and sends nothing", () =>
    Effect.gen(function* () {
      const { pauses, lease } = leaseStub();
      expect((yield* suspend({ session: Option.none(), lease })).status).toBe(401);
      expect(
        (yield* suspend({
          session: Option.some({ ...desktop, method: "browser-session-cookie" }),
          lease,
        })).status,
      ).toBe(403);
      expect(pauses).toEqual([]);
    }),
  );
});
