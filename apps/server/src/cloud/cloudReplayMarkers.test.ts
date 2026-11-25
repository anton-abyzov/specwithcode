import { describe, expect, it } from "vite-plus/test";

import { isValidSecretName } from "../auth/ServerSecretStore.ts";
import { legacyReplayMarkerName, replayMarkerName } from "./cloudReplayMarkers.ts";

describe("replayMarkerName", () => {
  it("keeps a hostile proof value inside the secrets folder", () => {
    for (const value of ["../../x", "a/b", "a\\b", "..", "nul\u0000"]) {
      const name = replayMarkerName("cloud-health-jti-", value);
      expect(isValidSecretName(name)).toBe(true);
      expect(name).toMatch(/^cloud-health-jti-[0-9a-f]{64}$/u);
    }
  });

  it("maps one value to one name, so a replayed proof meets its own marker", () => {
    expect(replayMarkerName("cloud-mint-nonce-", "n-1")).toBe(
      replayMarkerName("cloud-mint-nonce-", "n-1"),
    );
    expect(replayMarkerName("cloud-mint-nonce-", "n-1")).not.toBe(
      replayMarkerName("cloud-mint-nonce-", "n-2"),
    );
  });
});

describe("legacyReplayMarkerName", () => {
  it("names the plain marker an earlier build wrote, only when that was a valid name", () => {
    expect(legacyReplayMarkerName("cloud-mint-jti-", "a1b2-c3")).toBe("cloud-mint-jti-a1b2-c3");
    for (const value of ["../x", "a/b", "a\\b", "nul\u0000"]) {
      expect(legacyReplayMarkerName("cloud-mint-jti-", value)).toBeUndefined();
    }
  });
});
