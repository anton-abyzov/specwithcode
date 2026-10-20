/**
 * A request the personal assistant routed to another project's coordinator is
 * stored there with this one-line header, followed by a blank line and the
 * user's words unchanged. The header names who routed it and from where, so the
 * coordinator can tell the assistant's note from what the user wrote.
 */
export interface RoutedMessageOrigin {
  readonly assistantTitle: string;
  readonly threadId: string;
  readonly messageId: string;
  /** The assistant's own one-line note, such as which part of the request is this project's. */
  readonly note?: string | undefined;
}

const NOTE_MAX_CHARS = 500;
const TITLE_MAX_CHARS = 120;
const LEAD = "Routed from personal assistant ";
const NOTE_LABEL = " Assistant note: ";

/** One line, no header delimiters, bounded. */
function oneLine(text: string, max: number): string {
  const flat = text.replace(/\s+/g, " ").trim();
  return flat.length > max ? `${flat.slice(0, max - 1)}…` : flat;
}

export function routedMessageNote(note: string | undefined): string | undefined {
  if (note === undefined) return undefined;
  const flat = oneLine(note, NOTE_MAX_CHARS);
  return flat === "" ? undefined : flat;
}

export function routedMessageHeader(origin: RoutedMessageOrigin): string {
  const title = oneLine(origin.assistantTitle, TITLE_MAX_CHARS).replaceAll('"', "'") || "Assistant";
  const note = routedMessageNote(origin.note);
  return `${LEAD}"${title}" (thread ${origin.threadId}, message ${origin.messageId}).${
    note === undefined ? "" : `${NOTE_LABEL}${note}`
  } The text after this line is the user's own request.\n\n`;
}

export function routedMessageText(origin: RoutedMessageOrigin, words: string): string {
  return routedMessageHeader(origin) + words;
}

const HEADER =
  /^Routed from personal assistant "([^"\n]*)" \(thread (\S+), message (\S+)\)\.(?: Assistant note: ([^\n]*?))? The text after this line is the user's own request\.\n\n/;

/** The origin and the user's words, or null when the text carries no routing header. */
export function parseRoutedMessage(
  text: string,
): (RoutedMessageOrigin & { readonly words: string }) | null {
  const match = HEADER.exec(text);
  if (!match) return null;
  return {
    assistantTitle: match[1]!,
    threadId: match[2]!,
    messageId: match[3]!,
    ...(match[4] === undefined ? {} : { note: match[4] }),
    words: text.slice(match[0].length),
  };
}
