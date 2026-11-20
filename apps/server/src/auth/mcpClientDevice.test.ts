import { describe, expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";

import type * as ConnectDeviceTrust from "../fleet/ConnectDeviceTrust.ts";
import { mcpClientDeviceOf, mcpClientDeviceStands } from "./mcpClientDevice.ts";

const trustAnswering = (
  answer: (session: ConnectDeviceTrust.DeviceSessionFacts) => Effect.Effect<{ readonly _tag: string }>,
  seen: Array<unknown>,
) =>
  ({
    check: (session: ConnectDeviceTrust.DeviceSessionFacts) => {
      seen.push(session);
      return answer(session);
    },
  }) as unknown as ConnectDeviceTrust.ConnectDeviceTrustShape;

const bound = { boundDevice: { key: "device-release-notes", approval: "approval-1" } };

describe("mcpClientDevice", () => {
  it("keeps only the proof key and the signed binding", () => {
    expect(
      mcpClientDeviceOf({ proofKeyThumbprint: "thumb", boundDevice: bound.boundDevice }),
    ).toEqual({ proofKeyThumbprint: "thumb", ...bound });
    expect(mcpClientDeviceOf({ proofKeyThumbprint: "" })).toEqual({});
  });

  it.effect("asks the device list about the MCP client's binding", () =>
    Effect.gen(function* () {
      const seen: Array<unknown> = [];
      const trust = trustAnswering(() => Effect.succeed({ _tag: "allowed" }), seen);
      expect(yield* mcpClientDeviceStands(trust, "mcp-client", bound)).toBe(true);
      expect(seen).toEqual([{ subject: "mcp-client", ...bound }]);
    }),
  );

  it.effect("is false when the device was removed or the list cannot answer", () =>
    Effect.gen(function* () {
      const refused = trustAnswering(() => Effect.succeed({ _tag: "refused" }), []);
      expect(yield* mcpClientDeviceStands(refused, "mcp-client", bound)).toBe(false);
      const broken = trustAnswering(() => Effect.die("The device list is damaged."), []);
      expect(yield* mcpClientDeviceStands(broken, "mcp-client", bound)).toBe(false);
    }),
  );
});
