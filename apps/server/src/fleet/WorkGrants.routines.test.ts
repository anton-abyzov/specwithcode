import { describe, expect, it } from "@effect/vitest";
import { AuthSessionId, EnvironmentId } from "@specweave-studio/contracts";
import * as NodeServices from "@effect/platform-node/NodeServices";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";

import * as EnvironmentAuth from "../auth/EnvironmentAuth.ts";
import * as ServerConfig from "../config.ts";
import { workerClientName } from "./workerGrantMint.ts";
import * as WorkGrants from "./WorkGrants.ts";

/** M4 was allowed before grants (legacy); M1 is a coordinator granted since. */
const M4 = EnvironmentId.make("env-m4");
const M1 = EnvironmentId.make("env-m1");

const layer = WorkGrants.layer.pipe(
  Layer.provideMerge(
    Layer.mergeAll(
      Layer.mock(EnvironmentAuth.EnvironmentAuth)({
        setPrincipalRevoked: () => Effect.void,
        listSessions: () =>
          Effect.succeed([
            {
              sessionId: AuthSessionId.make(`session-${M4}`),
              principal: { kind: "coordinator", environmentId: M4 },
              subject: EnvironmentAuth.MCP_CLIENT_SUBJECT,
              client: { label: workerClientName(M4), deviceType: "bot" },
            },
          ] as never),
      }),
      ServerConfig.layerTest(process.cwd(), { prefix: "studio-work-grant-routines-" }).pipe(
        Layer.provide(NodeServices.layer),
      ),
      NodeServices.layer,
    ),
  ),
);

describe("the routines capability of a work grant", () => {
  it("decodes a policy written before it existed as off", () => {
    const record = Schema.decodeUnknownSync(WorkGrants.WorkGrantPolicyRecord)({
      coordinatorEnvironmentId: M1,
      projects: { kind: "linked" },
      accounts: { kind: "all" },
      owner: "self",
      legacy: false,
      runtimeCap: null,
      createdAt: "2026-11-01T00:00:00.000Z",
      updatedAt: "2026-11-01T00:00:00.000Z",
      revokedAt: null,
      interruptAt: null,
      interruptedAt: null,
    });
    expect(record.routines).toBeUndefined();
    expect(WorkGrants.effectiveGrant(record, new Set()).routines).toBe(false);
    // A legacy grant allows routines, as it managed them before grants had scopes.
    expect(WorkGrants.effectiveGrant({ ...record, legacy: true }, new Set()).routines).toBe(true);
  });

  it.effect("starts off for a new grant and follows the owner's edits", () =>
    Effect.gen(function* () {
      const grants = yield* WorkGrants.WorkGrants;
      expect((yield* grants.forCoordinator(M1)).routines).toBe(false);
      const on = yield* grants.update({ coordinatorEnvironmentId: M1, routines: true });
      expect(on.routines).toBe(true);
      expect((yield* grants.forCoordinator(M1)).routines).toBe(true);
      // Another edit leaves it as it is.
      yield* grants.update({ coordinatorEnvironmentId: M1, projects: { kind: "all" } });
      expect((yield* grants.forCoordinator(M1)).routines).toBe(true);
      yield* grants.update({ coordinatorEnvironmentId: M1, routines: false });
      expect((yield* grants.forCoordinator(M1)).routines).toBe(false);
    }).pipe(Effect.provide(layer)),
  );

  it.effect("keeps routines on when a legacy grant is first edited, until turned off", () =>
    Effect.gen(function* () {
      const grants = yield* WorkGrants.WorkGrants;
      const legacy = yield* grants.forCoordinator(M4);
      expect(legacy.legacy).toBe(true);
      expect(legacy.routines).toBe(true);
      const edited = yield* grants.update({
        coordinatorEnvironmentId: M4,
        projects: { kind: "linked" },
      });
      expect(edited.legacy).toBe(false);
      expect(WorkGrants.effectiveGrant(edited, new Set()).routines).toBe(true);
      yield* grants.update({ coordinatorEnvironmentId: M4, routines: false });
      expect((yield* grants.forCoordinator(M4)).routines).toBe(false);
    }).pipe(Effect.provide(layer)),
  );
});
