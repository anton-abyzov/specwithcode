/**
 * A fired routine's message split back into what it is made of, so the conversation can
 * show a card instead of the prompt the provider received. The server composes it as
 * `[coordinator line\n\n][brief header\n---\n]prompt[\n\nThe check `cmd` passed. Its
 * output:\n```\noutput\n```]` (ScheduledTaskService, ScheduledTaskCheck, routineBrief).
 * The routine itself, when it is still known, pins the title, prompt and command, so
 * text that only looks like one of those parts is never mistaken for it.
 */

export type RoutineTrigger = "scheduled" | "manual" | "webhook";

export interface RoutineRunMessage {
  readonly title: string | null;
  readonly trigger: RoutineTrigger | null;
  /** Where the coordinator should run the threads it starts, as one sentence. */
  readonly where: string | null;
  /** The brief's opening lines: inputs, output and the prepare-only rule. */
  readonly brief: string | null;
  readonly prompt: string;
  readonly check: {
    readonly command: string;
    readonly output: string;
    readonly truncated: boolean;
  } | null;
}

export interface KnownRoutine {
  readonly title: string;
  readonly prompt: string;
  readonly check?: { readonly command: string } | undefined;
}

const COORDINATOR_LINE =
  /^Routine "(.*)" fired\. Answer it yourself or start the threads it needs\.(?: (Run any thread it needs in [^\n]*))?\n\n/;
const BRIEF_START = /^Routine "(.*)", run on [^\n]*\n/;
const BRIEF_END = "\n---\n";
const CHECK_SUFFIX = /^\n\nThe check `([^\n]*)` passed\. Its output:\n```\n([\s\S]*)\n```\s*$/;
const TRUNCATED_MARK = "\n[output truncated]";

export function routineTrigger(messageId: string): RoutineTrigger | null {
  if (!messageId.startsWith("scheduled-task-message:")) return null;
  if (messageId.includes(":webhook:")) return "webhook";
  if (/:manual(?::|$)/.test(messageId)) return "manual";
  if (messageId.endsWith(":scheduled")) return "scheduled";
  return null;
}

/** The suffix starting exactly at `from`, read only when it runs to the end of the text. */
function checkSuffixAt(body: string, from: number): RegExpExecArray | null {
  return CHECK_SUFFIX.exec(body.slice(from));
}

function splitCheck(
  body: string,
  known: KnownRoutine | undefined,
): { prompt: string; check: RoutineRunMessage["check"] } {
  // A routine that has no check never gets a suffix, whatever its prompt says.
  if (known !== undefined && known.check === undefined) return { prompt: body, check: null };
  // The server appends the real suffix last, so the last candidate that reads as a
  // whole suffix is it; text earlier in the prompt only looks like one.
  const marker =
    known?.check === undefined
      ? "\n\nThe check `"
      : `\n\nThe check \`${known.check.command}\` passed. Its output:\n\`\`\`\n`;
  let start = body.lastIndexOf(marker);
  let match = start >= 0 ? checkSuffixAt(body, start) : null;
  while (start > 0 && match === null) {
    start = body.lastIndexOf(marker, start - 1);
    match = start >= 0 ? checkSuffixAt(body, start) : null;
  }
  if (start < 0 || match === null) return { prompt: body, check: null };
  let output = match[2]!;
  const truncated = output.endsWith(TRUNCATED_MARK);
  if (truncated) output = output.slice(0, -TRUNCATED_MARK.length);
  if (output === "(no output)") output = "";
  return {
    prompt: body.slice(0, start),
    check: { command: match[1]!, output, truncated },
  };
}

export function parseRoutineRunMessage(
  message: { readonly id: string; readonly text: string },
  known?: KnownRoutine,
): RoutineRunMessage {
  let body = message.text;
  let title: string | null = known?.title ?? null;
  let where: string | null = null;
  const coordinator = COORDINATOR_LINE.exec(body);
  if (coordinator) {
    title ??= coordinator[1]!;
    where = coordinator[2] ?? null;
    body = body.slice(coordinator[0].length);
  }
  let brief: string | null = null;
  const briefStart = BRIEF_START.exec(body);
  const briefEnd = briefStart ? body.indexOf(BRIEF_END) : -1;
  if (briefStart && briefEnd >= 0) {
    title ??= briefStart[1]!;
    // The title is on the card; the run date and the period the brief covers are not.
    const dated = briefStart[0].slice(`Routine "${briefStart[1]!}", r`.length).trim();
    brief = [`R${dated}`, body.slice(briefStart[0].length, briefEnd).trim()]
      .filter(Boolean)
      .join("\n");
    body = body.slice(briefEnd + BRIEF_END.length);
  }
  const { prompt, check } = splitCheck(body, known);
  return {
    title,
    trigger: routineTrigger(message.id),
    where,
    brief,
    prompt: prompt.trim(),
    check,
  };
}

/** The prompt's first sentence or line, short enough for the folded card. */
export function routinePromptPreview(prompt: string, max = 140): string {
  const line =
    prompt
      .split("\n")
      .find((entry) => entry.trim().length > 0)
      ?.trim() ?? "";
  const plain = line.replace(/[`*_]/g, "");
  return plain.length > max ? `${plain.slice(0, max - 1).trimEnd()}…` : plain;
}
