import { ConnectionBlockedError } from "@specweave-studio/client-runtime/connection";
import * as Option from "effect/Option";
import { describe, expect, it } from "vite-plus/test";

import { relaySessionRejected } from "./ConnectSessionGuard";

describe("relaySessionRejected", () => {
  it("is true only for a refusal of the sign-in itself (1417)", () => {
    const refused = new ConnectionBlockedError({
      reason: "authentication",
      detail: "Relay rejected the cloud session token.",
      connectSessionRefused: true,
    });
    expect(relaySessionRejected(Option.some(refused))).toBe(true);
  });

  it("ignores other authentication failures a new sign-in would not fix", () => {
    const proof = new ConnectionBlockedError({
      reason: "authentication",
      detail: "Relay rejected the DPoP proof.",
    });
    expect(relaySessionRejected(Option.some(proof))).toBe(false);
  });

  it("ignores other failures and success", () => {
    const misconfigured = new ConnectionBlockedError({ reason: "configuration", detail: "x" });
    expect(relaySessionRejected(Option.some(misconfigured))).toBe(false);
    expect(relaySessionRejected(Option.none())).toBe(false);
  });
});
