/**
 * Pairing codes SpecWithCode shows in Settings › Chrome:
 * `swc-chrome:1:<base64url JSON {u: relay URL, t: token, m: machine name}>`.
 * The relay URL must be a loopback WebSocket, so a pasted code can never send
 * this browser to another computer.
 */

export const PAIRING_PREFIX = "swc-chrome:1:";
export const PROTOCOL_VERSION = 1;

const LOOPBACK_HOSTS = new Set(["127.0.0.1", "localhost", "[::1]", "::1"]);

function decodeBase64Url(text) {
  const base64 = text.replace(/-/g, "+").replace(/_/g, "/");
  const padded = base64 + "=".repeat((4 - (base64.length % 4)) % 4);
  const binary = atob(padded);
  const bytes = Uint8Array.from(binary, (char) => char.charCodeAt(0));
  return new TextDecoder().decode(bytes);
}

/**
 * @returns {{ relayUrl: string, token: string, machine: string }}
 * @throws Error with a message the popup shows as is
 */
export function parsePairingCode(code) {
  const trimmed = String(code ?? "").trim();
  if (!trimmed.startsWith(PAIRING_PREFIX))
    throw new Error("That is not a SpecWithCode pairing code. Copy it from Settings › Chrome.");
  let data;
  try {
    data = JSON.parse(decodeBase64Url(trimmed.slice(PAIRING_PREFIX.length)));
  } catch {
    throw new Error("The pairing code is incomplete. Copy it again.");
  }
  const relayUrl = typeof data?.u === "string" ? data.u : "";
  const token = typeof data?.t === "string" ? data.t : "";
  let url;
  try {
    url = new URL(relayUrl);
  } catch {
    throw new Error("The pairing code has no valid address.");
  }
  if (url.protocol !== "ws:" || !LOOPBACK_HOSTS.has(url.hostname))
    throw new Error("The pairing code must point at SpecWithCode on this computer.");
  if (token.length < 32) throw new Error("The pairing code has no valid token.");
  return { relayUrl, token, machine: typeof data?.m === "string" ? data.m : "" };
}
