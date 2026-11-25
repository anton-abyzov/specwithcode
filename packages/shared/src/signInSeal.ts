/**
 * The viewer's half of the sign-in view's sealing (1488), in WebCrypto so a
 * browser, the phone's web view and Node share it.
 *
 * The format is the server's `seal.ts`: base64 parts joined by "." (the
 * sender's ephemeral X25519 key as SPKI DER, a 12-byte IV, the GCM tag, the
 * ciphertext). The AES-256-GCM key is HKDF-SHA256 over the shared secret,
 * salted with the IV, with the sign-in view's own info string, so a sealed
 * file transfer never opens as a sign-in frame or the other way round.
 */

export const SIGN_IN_SEAL_INFO_TEXT = "specwithcode sign-in view v1";

const info = () => new TextEncoder().encode(SIGN_IN_SEAL_INFO_TEXT);

function toBase64(bytes: Uint8Array): string {
  let text = "";
  for (let at = 0; at < bytes.length; at += 0x8000) {
    text += String.fromCharCode(...bytes.subarray(at, at + 0x8000));
  }
  return btoa(text);
}

function fromBase64(text: string): Uint8Array<ArrayBuffer> {
  const raw = atob(text);
  const bytes = new Uint8Array(raw.length);
  for (let at = 0; at < raw.length; at += 1) bytes[at] = raw.charCodeAt(at);
  return bytes;
}

/** WebCrypto's key type, named so it reads the same under the DOM and Node libs. */
type Key = Parameters<typeof crypto.subtle.exportKey>[1];
interface KeyPair {
  readonly publicKey: Key;
  readonly privateKey: Key;
}

export interface SignInViewerKey {
  /** Base64 SPKI DER of the public half; the server seals frames to it. */
  readonly publicKey: string;
  readonly privateKey: Key;
}

/** Whether this browser can make an X25519 key (Chrome 133+, Safari 17+, Firefox 130+). */
export async function canSealSignIn(): Promise<boolean> {
  try {
    await newSignInViewerKey();
    return true;
  } catch {
    return false;
  }
}

/** A key for one view: made when the view opens, never stored, gone when it closes. */
export async function newSignInViewerKey(): Promise<SignInViewerKey> {
  const pair = (await crypto.subtle.generateKey({ name: "X25519" }, false, [
    "deriveBits",
  ])) as unknown as KeyPair; // X25519 always makes a pair; some lib typings miss that overload.
  const spki = new Uint8Array(await crypto.subtle.exportKey("spki", pair.publicKey));
  return { publicKey: toBase64(spki), privateKey: pair.privateKey };
}

async function contentKey(
  privateKey: Key,
  publicKey: Key,
  salt: Uint8Array<ArrayBuffer>,
  usage: "encrypt" | "decrypt",
) {
  const shared = await crypto.subtle.deriveBits(
    { name: "X25519", public: publicKey },
    privateKey,
    256,
  );
  const base = await crypto.subtle.importKey("raw", shared, "HKDF", false, ["deriveKey"]);
  return crypto.subtle.deriveKey(
    { name: "HKDF", hash: "SHA-256", salt, info: info() },
    base,
    { name: "AES-GCM", length: 256 },
    false,
    [usage],
  );
}

const importPublic = (spki: Uint8Array<ArrayBuffer>) =>
  crypto.subtle.importKey("spki", spki, { name: "X25519" }, false, []);

/** Seals bytes to the view's public key (typed text goes this way). */
export async function sealForSignIn(
  plaintext: Uint8Array<ArrayBuffer>,
  recipientPublicKey: string,
): Promise<string> {
  const ephemeral = (await crypto.subtle.generateKey({ name: "X25519" }, true, [
    "deriveBits",
  ])) as unknown as KeyPair; // X25519 always makes a pair; some lib typings miss that overload.
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const key = await contentKey(
    ephemeral.privateKey,
    await importPublic(fromBase64(recipientPublicKey)),
    iv,
    "encrypt",
  );
  const sealed = new Uint8Array(
    await crypto.subtle.encrypt({ name: "AES-GCM", iv }, key, plaintext),
  );
  // WebCrypto appends the 16-byte tag; the format carries it as its own part.
  const ciphertext = sealed.subarray(0, sealed.length - 16);
  const tag = sealed.subarray(sealed.length - 16);
  const sender = new Uint8Array(await crypto.subtle.exportKey("spki", ephemeral.publicKey));
  return [sender, iv, tag, ciphertext].map(toBase64).join(".");
}

/** Opens what the server sealed to this viewer's key (frames come this way). Throws if it was changed. */
export async function unsealForSignIn(sealed: string, key: SignInViewerKey): Promise<Uint8Array> {
  const parts = sealed.split(".");
  if (parts.length !== 4) throw new Error("Not a sealed sign-in message.");
  const [sender, ivText, tag, data] = parts.map(fromBase64) as [
    Uint8Array<ArrayBuffer>,
    Uint8Array<ArrayBuffer>,
    Uint8Array<ArrayBuffer>,
    Uint8Array<ArrayBuffer>,
  ];
  const aes = await contentKey(key.privateKey, await importPublic(sender), ivText, "decrypt");
  const joined = new Uint8Array(data.length + tag.length);
  joined.set(data);
  joined.set(tag, data.length);
  return new Uint8Array(await crypto.subtle.decrypt({ name: "AES-GCM", iv: ivText }, aes, joined));
}

/** Short form of a key, as the server shows it: the first 16 hex digits of its SHA-256, in fours. */
export async function signInKeyFingerprint(publicKey: string): Promise<string> {
  const digest = new Uint8Array(await crypto.subtle.digest("SHA-256", fromBase64(publicKey)));
  const hex = Array.from(digest.subarray(0, 8), (byte) => byte.toString(16).padStart(2, "0")).join(
    "",
  );
  return [0, 4, 8, 12].map((at) => hex.slice(at, at + 4)).join("-");
}
