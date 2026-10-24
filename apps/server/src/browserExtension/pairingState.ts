/**
 * The SpecWithCode Browser pairing file, `<stateDir>/browser-extension/pairing.json`.
 * It holds the pairing token and, once a Chrome profile has presented that
 * token, when that first happened. Kept free of server imports so provider
 * adapters can ask "is a profile paired here?" without the relay.
 */

export const BROWSER_EXTENSION_DIR = "browser-extension";
export const PAIRING_FILE = "pairing.json";
const MIN_TOKEN_LENGTH = 32;

export interface PairingState {
  readonly token: string | null;
  /** When a Chrome profile first connected with this token; null until one has. */
  readonly connectedAt: string | null;
}

export function parsePairingState(text: string): PairingState {
  try {
    const data: unknown = JSON.parse(text);
    if (data === null || typeof data !== "object") return { token: null, connectedAt: null };
    const { token, connectedAt } = data as Record<string, unknown>;
    const valid = typeof token === "string" && token.length >= MIN_TOKEN_LENGTH;
    return {
      token: valid ? token : null,
      connectedAt: valid && typeof connectedAt === "string" ? connectedAt : null,
    };
  } catch {
    return { token: null, connectedAt: null };
  }
}

/**
 * Paired: a Chrome profile has connected with the current code. A profile
 * that is reconnecting right now still counts, since the extension comes back
 * on its own; resetting the code clears it until a profile pairs again.
 */
export function isPaired(text: string | null): boolean {
  return text !== null && parsePairingState(text).connectedAt !== null;
}
