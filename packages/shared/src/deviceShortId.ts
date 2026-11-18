/**
 * A short ID for telling devices apart by eye (1406): four characters taken
 * from the device's proof-key thumbprint, so two phones that both call
 * themselves "iPhone" read differently, and the same on the machine and on the
 * device. A hint only: it can be ground in about a million keys, so nothing
 * may approve, deny, remove or merge by it. The typed code is what approves.
 *
 * The same rule is written in Swift (`DeviceShortID.swift`); the test vector in
 * `deviceShortId.test.ts` is asserted in both.
 */

/** The characters codes are made of: no 0, 1, I, L or O to misread. */
const ID_ALPHABET = "23456789ABCDEFGHJKMNPQRSTUVWXYZ";
const BASE64URL = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_";

export const DEVICE_SHORT_ID_LENGTH = 4;

/** The first `count` bytes a base64url text stands for, or null when it is not base64url. */
const leadingBytes = (text: string, count: number): ReadonlyArray<number> | null => {
  const needed = Math.ceil((count * 8) / 6);
  if (text.length < needed) return null;
  const bytes: Array<number> = [];
  let held = 0;
  let bits = 0;
  for (let index = 0; index < needed; index += 1) {
    const value = BASE64URL.indexOf(text[index]!);
    if (value < 0) return null;
    held = ((held << 6) | value) & 0xffff;
    bits += 6;
    if (bits >= 8) {
      bits -= 8;
      bytes.push((held >> bits) & 0xff);
    }
  }
  return bytes.slice(0, count);
};

/**
 * "7K3Q" for a key's RFC 7638 thumbprint (base64url of a SHA-256): each of its
 * first four bytes picks one character. Undefined when the text is not a thumbprint.
 */
export const deviceShortIdOfThumbprint = (thumbprint: string): string | undefined => {
  const bytes = leadingBytes(thumbprint.trim(), DEVICE_SHORT_ID_LENGTH);
  if (bytes === null) return undefined;
  return bytes.map((byte) => ID_ALPHABET[byte % ID_ALPHABET.length]).join("");
};
