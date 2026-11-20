/**
 * A signed-in account email, partly hidden so a screenshot does not give it away
 * while its owner can still tell which account it is: `antonabyzov@gmail.com`
 * reads `an••••ov@gmail.com`.
 *
 * The rule, on the name before the `@` (a `+tag` is masked with it):
 * - 1 or 2 characters: the first one shows (`a••••@`).
 * - 3 to 5 characters: the first and the last show (`b••••b@`).
 * - 6 or more: the first two and the last two show (`an••••ov@`).
 *
 * The mask is always four dots, so it does not tell the name's length. The whole
 * domain shows, subdomains included. Anything that is not an email returns null,
 * so a caller can fall back to hiding it entirely.
 */
export const EMAIL_MASK = "••••";

export function maskEmail(value: string | null | undefined): string | null {
  const email = value?.trim();
  if (!email) return null;
  const at = email.lastIndexOf("@");
  if (at <= 0 || at === email.length - 1) return null;
  const local = Array.from(email.slice(0, at));
  const domain = email.slice(at + 1);
  if (/\s/u.test(email)) return null;
  const shown = local.length >= 6 ? 2 : local.length >= 3 ? 1 : 0;
  const head = local.slice(0, Math.max(shown, 1)).join("");
  const tail = shown > 0 ? local.slice(-shown).join("") : "";
  return `${head}${EMAIL_MASK}${tail}@${domain}`;
}
