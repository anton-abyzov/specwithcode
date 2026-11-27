/**
 * A block reason as SpecWeave writes it. SpecWeave 3.2 fixes a reason's
 * spacing as it writes it (`src/core/tasks/reason-text.ts`, normalizeReason):
 * runs of whitespace become one space and a missing space after `,` or `;` is
 * added, but text in backticks, URLs and paths are never changed. This is a
 * copy of that rule, so the write tools send a reason already in its written
 * form (SpecWeave 3.1 only trims, so both versions store the same text) and a
 * retry is the same reason only when it would be written the same way.
 */

/**
 * Backtick code, URLs (scheme or scheme-less), and path-like tokens; as
 * SpecWeave 3.2.5, with its flags. With `u` added, `i` would also match `ſ`
 * and the Kelvin sign as letters, and the two would split a reason differently.
 */
const PROTECTED =
  /`[^`]*`|\b[a-z][a-z0-9+.-]*:\/\/\S+|\b(?:[A-Za-z0-9-]+\.)+[A-Za-z]{2,}(?:[/?#]\S*)?|\b[^\s()[\]{}"'`,;]*\/[^\s()[\]{}"'`,;]*/gi;

/** Length of the protected part of a URL or path match; a `,word` sentence tail after a digit is not protected. */
function protectedLength(raw: string): number {
  if (raw.startsWith("`")) return raw.length;
  let end = raw.length;
  while (end > 0 && /[.;:!?)\]'"]/u.test(raw[end - 1]!)) end--;
  const core = raw.slice(0, end);
  if (core.includes("?") || core.includes("#")) return end;
  const tail = /^(.*\d)(,[A-Za-z]+)$/u.exec(core);
  if (tail) return tail[1]!.length;
  return end;
}

function spans(text: string): Array<{ readonly text: string; readonly kept: boolean }> {
  const out: Array<{ readonly text: string; readonly kept: boolean }> = [];
  let last = 0;
  for (const match of text.matchAll(PROTECTED)) {
    const at = match.index ?? 0;
    const keep = protectedLength(match[0]);
    if (keep === 0) continue;
    if (at > last) out.push({ text: text.slice(last, at), kept: false });
    out.push({ text: match[0].slice(0, keep), kept: true });
    last = at + keep;
  }
  if (last < text.length) out.push({ text: text.slice(last), kept: false });
  return out;
}

/** The reason as SpecWeave writes it. */
export function writtenReason(reason: string | undefined): string {
  return spans(reason ?? "")
    .map((span, index, all) => {
      if (span.kept) return span.text;
      let text = span.text
        .replace(/\s+/gu, " ")
        .replace(/^([,;])(?=[\p{L}(`])/u, (mark) =>
          index > 0 && all[index - 1]!.kept ? `${mark} ` : mark,
        )
        .replace(/([\p{L})\]%])([,;])(?=[\p{L}\p{N}(])/gu, "$1$2 ")
        .replace(/(\p{N})([,;])(?=\p{L})/gu, "$1$2 ");
      if (all[index + 1]?.kept) text = text.replace(/([\p{L}\p{N})\]%:])([,;])$/u, "$1$2 ");
      return text;
    })
    .join("")
    .trim();
}

/**
 * Whether a blocked task's recorded reason is the one this call would write:
 * the written form of the requested reason, or (for a block made in a shell
 * with SpecWeave 3.1, which only trims) the requested reason trimmed.
 */
export function sameReason(recorded: string | undefined, requested: string | undefined): boolean {
  if (recorded === undefined) return false;
  return recorded === writtenReason(requested) || recorded === (requested ?? "").trim();
}
