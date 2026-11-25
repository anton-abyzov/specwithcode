// @effect-diagnostics-next-line nodeBuiltinImport:off -- Effect's Crypto has no createHmac or timingSafeEqual.
import * as NodeCrypto from "node:crypto";

/**
 * The desktop app and the backends it launches share one secret, delivered
 * over the backend's bootstrap channel and never sent to the renderer. Both
 * sides derive the bootstrap token for a time window from it, so the token the
 * renderer holds rotates every window without the desktop having to reach a
 * running backend. A backend accepts the previous, current and next window's
 * token: the previous one so a token works for between one and two windows,
 * and the next one because a WSL backend's clock can trail the Windows clock
 * that derived the token, which would otherwise reject every fresh token for
 * a moment after each boundary. A token is still dead two windows after it
 * was issued.
 */
export const DESKTOP_BOOTSTRAP_TOKEN_WINDOW_MS = 12 * 60 * 60 * 1000;

function windowIndex(nowMs: number): number {
  return Math.floor(nowMs / DESKTOP_BOOTSTRAP_TOKEN_WINDOW_MS);
}

function deriveToken(secret: string, window: number): string {
  return NodeCrypto.createHmac("sha256", secret)
    .update(`studio-desktop-bootstrap:${window}`)
    .digest("hex");
}

/** The token the desktop hands out at `nowMs`. */
export function currentDesktopBootstrapToken(secret: string, nowMs: number): string {
  return deriveToken(secret, windowIndex(nowMs));
}

/** Whether `token` is the previous, current or next window's token at `nowMs`. */
export function isValidDesktopBootstrapToken(
  secret: string,
  token: string,
  nowMs: number,
): boolean {
  const presented = Buffer.from(token);
  const current = windowIndex(nowMs);
  return [current - 1, current, current + 1].some((window) => {
    const expected = Buffer.from(deriveToken(secret, window));
    return expected.length === presented.length && NodeCrypto.timingSafeEqual(expected, presented);
  });
}

/**
 * How long one screen sharing host proof lasts. Short, because the app sends a
 * new one over its open link well inside this time.
 */
export const SCREEN_SHARE_HOST_PROOF_WINDOW_MS = 10 * 60 * 1000;

function deriveScreenShareHostProof(secret: string, window: number): string {
  return NodeCrypto.createHmac("sha256", secret)
    .update(`studio-screen-share-host:${window}`)
    .digest("hex");
}

/**
 * What the desktop app's main process proves itself with to a backend it
 * launched, on the screen sharing host socket. It comes from the same secret
 * as the bootstrap token and from a different label, so the bootstrap token
 * the renderer holds says nothing about it: only a holder of the secret can
 * make one, and the secret never leaves the main process and its backends.
 */
export function currentScreenShareHostProof(secret: string, nowMs: number): string {
  return deriveScreenShareHostProof(secret, Math.floor(nowMs / SCREEN_SHARE_HOST_PROOF_WINDOW_MS));
}

/** Whether `proof` is the previous, current or next window's host proof at `nowMs`. */
export function isValidScreenShareHostProof(secret: string, proof: string, nowMs: number): boolean {
  const presented = Buffer.from(proof);
  const current = Math.floor(nowMs / SCREEN_SHARE_HOST_PROOF_WINDOW_MS);
  return [current - 1, current, current + 1].some((window) => {
    const expected = Buffer.from(deriveScreenShareHostProof(secret, window));
    return expected.length === presented.length && NodeCrypto.timingSafeEqual(expected, presented);
  });
}
