import { describe, expect, it } from "vite-plus/test";

import {
  DESKTOP_BOOTSTRAP_TOKEN_WINDOW_MS,
  currentDesktopBootstrapToken,
  currentScreenShareHostProof,
  isValidScreenShareHostProof,
  SCREEN_SHARE_HOST_PROOF_WINDOW_MS,
  isValidDesktopBootstrapToken,
} from "./desktopBootstrapToken.ts";

const SECRET = "desktop-secret";
const WINDOW = DESKTOP_BOOTSTRAP_TOKEN_WINDOW_MS;

describe("desktop bootstrap token", () => {
  it("rotates every window and stays accepted for one more", () => {
    const issuedAt = 10 * WINDOW + 1;
    const token = currentDesktopBootstrapToken(SECRET, issuedAt);

    expect(currentDesktopBootstrapToken(SECRET, issuedAt + WINDOW)).not.toBe(token);
    expect(isValidDesktopBootstrapToken(SECRET, token, issuedAt)).toBe(true);
    expect(isValidDesktopBootstrapToken(SECRET, token, issuedAt + WINDOW)).toBe(true);
    expect(isValidDesktopBootstrapToken(SECRET, token, issuedAt + 2 * WINDOW)).toBe(false);
  });

  it("accepts a token from a desktop clock slightly ahead of the backend", () => {
    // Windows crossed the boundary, the WSL clock has not yet.
    const desktopNow = 10 * WINDOW + 500;
    const backendNow = 10 * WINDOW - 500;

    expect(
      isValidDesktopBootstrapToken(
        SECRET,
        currentDesktopBootstrapToken(SECRET, desktopNow),
        backendNow,
      ),
    ).toBe(true);
    expect(
      isValidDesktopBootstrapToken(
        SECRET,
        currentDesktopBootstrapToken(SECRET, desktopNow + WINDOW),
        backendNow,
      ),
    ).toBe(false);
  });

  it("rejects tokens derived from another secret", () => {
    const token = currentDesktopBootstrapToken("other-secret", WINDOW);

    expect(isValidDesktopBootstrapToken(SECRET, token, WINDOW)).toBe(false);
    expect(isValidDesktopBootstrapToken(SECRET, "short", WINDOW)).toBe(false);
  });
});

describe("screen sharing host proof", () => {
  const SECRET = "launch-secret";
  const STEP = SCREEN_SHARE_HOST_PROOF_WINDOW_MS;
  const NOW = 1000 * STEP + 5;

  it("holds for its own window and the ones next to it, then runs out", () => {
    const proof = currentScreenShareHostProof(SECRET, NOW);
    expect(isValidScreenShareHostProof(SECRET, proof, NOW)).toBe(true);
    expect(isValidScreenShareHostProof(SECRET, proof, NOW + STEP)).toBe(true);
    expect(isValidScreenShareHostProof(SECRET, proof, NOW - STEP)).toBe(true);
    expect(isValidScreenShareHostProof(SECRET, proof, NOW + 2 * STEP)).toBe(false);
    expect(isValidScreenShareHostProof("another-secret", proof, NOW)).toBe(false);
    expect(isValidScreenShareHostProof(SECRET, "", NOW)).toBe(false);
  });

  it("is nothing the bootstrap token gives away, in either direction", () => {
    // The app's window holds the bootstrap token. It must not pass as the host proof,
    // and the host proof must not pass as a bootstrap token.
    for (const at of [NOW, NOW - STEP, NOW + STEP]) {
      expect(
        isValidScreenShareHostProof(SECRET, currentDesktopBootstrapToken(SECRET, at), NOW),
      ).toBe(false);
      expect(
        isValidDesktopBootstrapToken(SECRET, currentScreenShareHostProof(SECRET, at), NOW),
      ).toBe(false);
    }
    expect(currentScreenShareHostProof(SECRET, NOW)).not.toBe(
      currentDesktopBootstrapToken(SECRET, NOW),
    );
  });
});
