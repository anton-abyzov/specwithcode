/**
 * Turns the raw errors a move or copy can surface into a sentence that says what happened
 * and what to do. A sentence the app already wrote for people keeps its words, with a next
 * step added when it has none.
 */

export type HandoffAction = "move" | "copy";

/** The machines involved, by the names the person sees. */
export interface HandoffErrorPlaces {
  readonly source?: string | undefined;
  readonly destination?: string | undefined;
}

/** What the destination's "copy_failed" code puts before the server's own detail. */
const COPY_FAILED = /^The copy failed(?: on this machine)?[.:]\s*/;
/** Raised on the destination itself ("on this machine" is the machine that failed). */
const ON_DESTINATION = /^The copy failed on this machine/;
/**
 * durable.ts: a private working folder that resolves somewhere else, because it or a folder
 * above it is a link. Newer servers add where it leads after " -> ".
 */
const PRIVATE_LINK = /^Private folder resolves elsewhere(?::\s*(.+?))?(?:\s+->\s+(.+?))?\.?$/;
/** Node's file errors: "EACCES: permission denied, mkdir '/x'". */
const NODE_FILE = /^(EACCES|EPERM|ENOENT|ENOSPC|EROFS|EEXIST|ENOTDIR|EISDIR)\b[^']*(?:'([^']+)')?/;
/** The link between the machines dropped mid-transfer. */
const INTERRUPTED = /\bconnection (?:was )?(?:interrupted|dropped|lost|closed)\b/i;
/** A sentence that already tells the person what to do. */
const HAS_NEXT_STEP =
  /\b(try again|then|choose|check|review|install|sign in|update|reconnect|restart|open|turn on|free|move it|use)\b/i;
/** About the project's own folder on the source, not the step on screen. */
const ABOUT_SOURCE = /\bsource\b|\b(?:could not|cannot|can't) be read\b/i;

const NODE_FILE_TEXT: Record<string, (path: string, action: HandoffAction) => string> = {
  EACCES: (path) => `SpecWithCode can't write to ${path}. Check its permissions, then try again.`,
  EPERM: (path) =>
    `SpecWithCode isn't allowed to change ${path}. Check its permissions, then try again.`,
  ENOENT: (path, action) => `${path} doesn't exist. Choose another folder, then ${action} again.`,
  ENOSPC: (_path, action) =>
    `The disk is full, so the ${action} stopped. Free some space, then try again.`,
  EROFS: (path) => `${path} is on a read-only drive. Choose another folder.`,
  EEXIST: (path) => `${path} already exists and is in the way. Move it aside, then try again.`,
  ENOTDIR: (path) => `Part of ${path} is a file, not a folder. Choose another folder.`,
  EISDIR: (path) => `${path} is a folder where a file was expected. Move it aside, then try again.`,
};

/** A message written for people: a capitalised sentence, not a code or a stack line. */
const isPlainSentence = (text: string) => /^[A-Z“"‘'(]/.test(text) && !/^[A-Z_]{3,}\b/.test(text);
const sentence = (text: string) => (/[.!?]$/.test(text) ? text : `${text}.`);

function linkText(
  path: string | undefined,
  real: string | undefined,
  machine: string | undefined,
  action: HandoffAction,
): string {
  const on = machine ? ` on ${machine}` : "";
  const where = path ? ` (${path})` : "";
  const leads = real ? ` leads to ${real} through a shortcut` : " is behind a shortcut";
  return `SpecWithCode's working folder${on}${where}${leads}, so the ${action} can't start. Use a normal folder that isn't a shortcut or inside one, then try again.`;
}

/** The next step for an error with no mapping of its own. */
function nextStep(text: string, places: HandoffErrorPlaces): string {
  const source = places.source ?? "this machine";
  if (ABOUT_SOURCE.test(text))
    return `Check that ${source} can open the project's folder, then try again.`;
  const destination = places.destination ?? "the other machine";
  return `Try again. If it happens again, check that ${source} and ${destination} are both online.`;
}

interface HandoffErrorView {
  readonly text: string;
  /** A refusal the app recognises: the move or copy stopped on the step on screen. */
  readonly recognised: boolean;
}

function view(
  message: string,
  action: HandoffAction,
  places: HandoffErrorPlaces,
): HandoffErrorView {
  const text = message.trim();
  const detail = text.replace(COPY_FAILED, "");
  const link = PRIVATE_LINK.exec(detail);
  if (link) {
    const machine = ON_DESTINATION.test(text) ? places.destination : undefined;
    return { text: linkText(link[1], link[2], machine, action), recognised: true };
  }
  if (INTERRUPTED.test(detail))
    return {
      text: `The connection dropped while ${action === "move" ? "moving" : "copying"} files. ${nextStep("", places)}`,
      recognised: true,
    };
  const file = NODE_FILE.exec(detail);
  if (file)
    return {
      text: NODE_FILE_TEXT[file[1]!]!(file[2] ?? "a folder it needs", action),
      recognised: true,
    };
  const plain = isPlainSentence(detail);
  const said = plain ? sentence(detail) : detail;
  const next = plain && HAS_NEXT_STEP.test(detail) ? "" : ` ${nextStep(detail, places)}`;
  if (detail !== text)
    return {
      text: plain
        ? `The ${action} stopped. ${said}${next}`
        : `The ${action} stopped: ${said}.${next}`,
      recognised: true,
    };
  // Not a refusal the app knows, such as a status check that failed while the machines
  // keep working: shown as it is, with what to do, and never called "stopped".
  return { text: `${plain ? said : `Something went wrong: ${said}.`}${next}`, recognised: false };
}

export function plainHandoffError(
  message: string,
  action: HandoffAction = "move",
  places: HandoffErrorPlaces = {},
): string {
  return view(message, action, places).text;
}

/**
 * True when the error belongs on the step on screen, so the step bar marks it stopped:
 * a refusal the app recognises, or any error while starting or choosing. An error about the
 * source folder, or one from a status check while the machines work, marks no step.
 */
export function handoffErrorMarksStep(message: string, stage: string): boolean {
  const detail = message.trim().replace(COPY_FAILED, "");
  if (ABOUT_SOURCE.test(detail) && !PRIVATE_LINK.test(detail) && !NODE_FILE.test(detail))
    return false;
  return view(message, "move", {}).recognised || stage === "setup" || stage === "preview";
}
