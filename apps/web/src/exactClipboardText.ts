/**
 * What a Copy button puts on the clipboard: exactly the text shown, ready to
 * paste into a terminal, a form field or a macOS file dialog. A code fence's
 * text always ends in a newline, and a field like Go to Folder (Cmd+Shift+G)
 * shows that newline as a trailing space the path then fails on.
 */

// Zero-width space, word joiner, byte order mark, soft hyphen. Zero-width
// joiners stay: emoji sequences and some scripts need them.
const INVISIBLE_CHARACTERS = /[​⁠﻿­]/g;
// No-break, narrow no-break and figure spaces read as spaces but are not.
const LOOKALIKE_SPACES = /[   ]/g;

/**
 * Text without invisible characters, lookalike spaces, leading blank lines or
 * trailing whitespace. Indentation and blank lines inside stay.
 */
export function exactCopyText(text: string): string {
  return text
    .replace(INVISIBLE_CHARACTERS, "")
    .replace(LOOKALIKE_SPACES, " ")
    .replace(/\r\n?/g, "\n")
    .replace(/^(?:[ \t]*\n)+/, "")
    .replace(/\s+$/, "");
}

// Quotes and backticks a message may wrap a path in, straight or curly.
const WRAPPING_QUOTES = /^[`"'‘’“”]+|[`"'‘’“”]+$/g;

/** One path on one line, with nothing around it and no zero-width characters. */
export function exactPathText(path: string): string {
  return exactCopyText(path)
    .replace(/[‌‍]/g, "")
    .trim()
    .replace(WRAPPING_QUOTES, "")
    .trim();
}

/** A list of paths, one exact path per line. */
export function exactPathListText(paths: ReadonlyArray<string>): string {
  return paths
    .map(exactPathText)
    .filter((path) => path.length > 0)
    .join("\n");
}
