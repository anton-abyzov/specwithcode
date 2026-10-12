/** Replies longer than this are cut at a sentence boundary when read aloud. */
export const VOICE_CALL_SPOKEN_CHARACTER_LIMIT = 700;

const MORE_IN_CHAT = "The rest is in the chat.";

/**
 * Turns a markdown reply into something worth hearing: code, tables and URLs are
 * dropped, links keep their label, list markers and emphasis disappear.
 */
export function speakableText(
  markdown: string,
  limit: number = VOICE_CALL_SPOKEN_CHARACTER_LIMIT,
): string {
  let omitted = false;
  let text = markdown.replace(/\r\n?/g, "\n");
  text = text.replace(/```[\s\S]*?(```|$)/g, () => {
    omitted = true;
    return "\n";
  });
  const lines: string[] = [];
  for (const rawLine of text.split("\n")) {
    const line = rawLine.trim();
    if (/^\|.*\|$/.test(line) || /^[-:| ]{3,}$/.test(line)) {
      omitted = true;
      continue;
    }
    if (/^<[^>]+>$/.test(line)) continue;
    lines.push(
      line
        .replace(/^#{1,6}\s+/, "")
        .replace(/^>\s?/, "")
        .replace(/^([-*+]|\d+[.)])\s+(\[[ xX]\]\s+)?/, ""),
    );
  }
  text = lines
    .join("\n")
    .replace(/!\[[^\]]*\]\([^)]*\)/g, "")
    .replace(/\[([^\]]+)\]\([^)]*\)/g, "$1")
    .replace(/`([^`]+)`/g, "$1")
    .replace(/(\*\*|__)(.+?)\1/g, "$2")
    .replace(/(^|[\s(])[*_]([^*_\n]+)[*_](?=[\s).,!?:;]|$)/g, "$1$2")
    .replace(/~~(.+?)~~/g, "$1")
    .replace(/https?:\/\/\S+/g, "")
    .replace(/\n{2,}/g, "\n")
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => line.length > 0)
    .map((line) => (/[.!?:;]$/.test(line) ? line : `${line}.`))
    .join(" ")
    .replace(/\s{2,}/g, " ")
    .trim();

  if (text.length > limit) {
    const slice = text.slice(0, limit);
    const boundary = Math.max(
      slice.lastIndexOf(". "),
      slice.lastIndexOf("! "),
      slice.lastIndexOf("? "),
    );
    text = boundary > limit / 3 ? slice.slice(0, boundary + 1) : `${slice.trimEnd()}…`;
    omitted = true;
  }
  if (text.length === 0) return omitted ? MORE_IN_CHAT.replace("The rest", "My answer") : "";
  return omitted ? `${text} ${MORE_IN_CHAT}` : text;
}
