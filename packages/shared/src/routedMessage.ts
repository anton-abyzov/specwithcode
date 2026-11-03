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

/**
 * A reply typed in a worker on another machine reached the coordinator with this
 * header in earlier versions; those messages stay in coordinators' history,
 * where the person sees only the title and machine name.
 */
export interface RoutedThreadReplyTarget {
  readonly threadId: string;
  readonly environmentId: string;
  readonly title: string;
}

const THREAD_REPLY_HEADER = /^Regarding thread (\S+) on machine (\S+) \((.*)\):\n\n/;

/** The target and the user's words, or null when the text carries no such header. */
export function parseRoutedThreadReply(
  text: string,
): (RoutedThreadReplyTarget & { readonly words: string }) | null {
  const match = THREAD_REPLY_HEADER.exec(text);
  if (!match) return null;
  return {
    threadId: match[1]!,
    environmentId: match[2]!,
    title: match[3]!,
    words: text.slice(match[0].length),
  };
}

/** The text to show for a routed reply, without its IDs; other text comes back unchanged. */
export function routedThreadReplyDisplayText(
  text: string,
  machineLabel: (environmentId: string) => string,
): string {
  const reply = parseRoutedThreadReply(text);
  if (!reply) return text;
  const title = reply.title.trim() || "another thread";
  // A machine this device has no name for resolves to its ID, which stays out of sight too.
  // An unnamed one without an ID's shape is a person's own "Regarding thread x on machine y".
  const label = machineLabel(reply.environmentId);
  const unnamed = label === reply.environmentId;
  if (unnamed && !/^[0-9a-f-]{8,}$/i.test(label)) return text;
  const machine = unnamed ? "another machine" : label;
  return `Regarding ${title} on ${machine}:\n\n${reply.words}`;
}
