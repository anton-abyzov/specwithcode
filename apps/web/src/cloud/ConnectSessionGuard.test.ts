import { ConnectionBlockedError } from "@specweave-studio/client-runtime/connection";
import * as Option from "effect/Option";
import { describe, expect, it } from "vite-plus/test";

import { relaySessionRejected } from "./ConnectSessionGuard";

describe("relaySessionRejected", () => {
  it("is true only for an authentication refusal", () => {
    const refused = new ConnectionBlockedError({
      reason: "authentication",
      detail: "Your sign-in expired.",
    });
    expect(relaySessionRejected(Option.some(refused))).toBe(true);
  });

  it("ignores a proof this device could not make, which never reached the relay (1417)", () => {
    const local = new ConnectionBlockedError({
      reason: "authentication",
      detail: "Could not load the relay key.",
      localProofFailure: true,
    });
    expect(relaySessionRejected(Option.some(local))).toBe(false);
  });

  it("ignores other failures and success", () => {
    const misconfigured = new ConnectionBlockedError({ reason: "configuration", detail: "x" });
    expect(relaySessionRejected(Option.some(misconfigured))).toBe(false);
    expect(relaySessionRejected(Option.none())).toBe(false);
  });
});
