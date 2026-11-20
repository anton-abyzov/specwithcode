import { expect, it } from "@effect/vitest";
import { AuthAccessWriteScope } from "@specweave-studio/contracts";
import * as Effect from "effect/Effect";

import { deviceApprover } from "./connectDevicesHttp.ts";
import * as EnvironmentAuth from "./EnvironmentAuth.ts";

const approvedKeys = new Set(["jkt:approved-laptop", "link:phone-link:prod:approved"]);
const isApproved = (key: string) => Effect.succeed(approvedKeys.has(key));
const writes = new Set<string>([AuthAccessWriteScope]);

it.effect("only this machine's owner or an approved device may approve (B-02)", () =>
  Effect.gen(function* () {
    // This machine's own app.
    expect(yield* deviceApprover({ subject: "local-desktop", scopes: writes }, isApproved)).toEqual(
      { kind: "owner", name: "this machine", key: null },
    );
    // A local session that can only read may not change the list.
    expect(yield* deviceApprover({ subject: "browser", scopes: new Set() }, isApproved)).toBeNull();

    // A Connect device this machine approved, named by its own label.
    expect(
      yield* deviceApprover(
        {
          subject: "cloud-connect",
          scopes: writes,
          proofKeyThumbprint: "approved-laptop",
          clientLabel: "Anton's MacBook",
        },
        isApproved,
      ),
    ).toEqual({ kind: "device", name: "Anton's MacBook", key: "jkt:approved-laptop" });

    // The device that is asking can not approve anything, its own code included.
    expect(
      yield* deviceApprover(
        {
          subject: "cloud-connect",
          scopes: writes,
          proofKeyThumbprint: "waiting-phone",
          clientLabel: "Anton's iPhone",
        },
        isApproved,
      ),
    ).toBeNull();
    // A Connect session without a proof key can not be told apart from another, so no.
    expect(yield* deviceApprover({ subject: "cloud-connect", scopes: writes }, isApproved)).toBe(
      null,
    );

    // Machines are not people: coordinators, workers and agents never approve devices.
    for (const subject of [
      EnvironmentAuth.MCP_CLIENT_SUBJECT,
      EnvironmentAuth.FLEET_INVITATION_SUBJECT,
    ])
      expect(yield* deviceApprover({ subject, scopes: writes }, isApproved)).toBeNull();
    expect(
      yield* deviceApprover(
        { subject: "local-desktop", scopes: writes, principal: { kind: "coordinator" } },
        isApproved,
      ),
    ).toBeNull();
  }),
);
