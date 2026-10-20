/**
 * The per-turn handoff note: Done, Next, Open questions, at most 120 words.
 * A model writes it when one is configured; otherwise, or when generation
 * fails, a plain note is built from the last user request and reply.
 */
import { HANDOFF_NOTE_MAX_WORDS, type HandoffNote } from "@specweave-studio/contracts";

export interface NoteMessage {
  readonly role: "user" | "assistant";
  readonly text: string;
}

const TRANSCRIPT_TURNS = 12;
const TRANSCRIPT_MESSAGE_CHARS = 2_000;

/** The latest turns as plain text, oldest first, each message trimmed. */
export function handoffTranscript(messages: ReadonlyArray<NoteMessage>): string {
  return messages
    .slice(-TRANSCRIPT_TURNS)
    .map((message) => {
      const text = message.text.trim();
      const clipped =
        text.length > TRANSCRIPT_MESSAGE_CHARS
          ? `${text.slice(0, TRANSCRIPT_MESSAGE_CHARS)} [...]`
          : text;
      return `${message.role === "user" ? "User" : "Assistant"}: ${clipped}`;
    })
    .join("\n\n");
}

function words(text: string): Array<string> {
  return text.split(/\s+/).filter(Boolean);
}

/**
 * Trims the three fields to `max` words in total, taking from Done first
 * since Next is what the continuing machine needs most.
 */
export function capHandoffNote(
  note: { readonly done: string; readonly next: string; readonly openQuestions: string },
  max = HANDOFF_NOTE_MAX_WORDS,
): { done: string; next: string; openQuestions: string } {
  const fields = {
    done: words(note.done),
    next: words(note.next),
    openQuestions: words(note.openQuestions),
  };
  const total = () => fields.done.length + fields.next.length + fields.openQuestions.length;
  for (const key of ["done", "openQuestions", "next"] as const) {
    const over = total() - max;
    if (over <= 0) break;
    fields[key] = fields[key].slice(0, Math.max(0, fields[key].length - over));
  }
  return {
    done: fields.done.join(" "),
    next: fields.next.join(" "),
    openQuestions: fields.openQuestions.join(" "),
  };
}

function firstSentence(text: string, maxWords: number): string {
  const line = text.trim().split(/\n+/)[0] ?? "";
  const sentence = line.split(/(?<=[.!?])\s/)[0] ?? line;
  return words(sentence).slice(0, maxWords).join(" ");
}

/** The note used when no model writes one. */
export function fallbackHandoffNote(
  messages: ReadonlyArray<NoteMessage>,
  createdAt: string,
): HandoffNote {
  const lastUser = messages.findLast((message) => message.role === "user");
  const lastAssistant = messages.findLast((message) => message.role === "assistant");
  const capped = capHandoffNote({
    done: lastAssistant ? `Latest reply: ${firstSentence(lastAssistant.text, 50)}` : "",
    next: lastUser
      ? `Continue the latest request: ${firstSentence(lastUser.text, 50)}`
      : "Read the thread and continue.",
    openQuestions: "",
  });
  return { ...capped, createdAt };
}
