import type { ProjectSkillPresence } from "@specweave-studio/contracts";

/** Excerpts only: opening a skill never generates or invents usage guidance. */
export function skillDescriptionParts(description: string | undefined) {
  const text = description?.trim() ?? "";
  const first = text.split(/\n\s*\n/)[0] ?? "";
  const sentence = first.match(/^.*?[.!?](?:\s|$)/)?.[0]?.trim() ?? first;
  const summary = sentence;
  const usage =
    text
      .match(/(?:^|[.!?]\s+|\n)(?:Use when|Activate when|When to use:?)[\s\S]*?(?=\n\s*\n|$)/i)?.[0]
      ?.replace(/^[.!?]\s*/, "")
      .trim() ?? null;
  return { summary, usage, full: text, more: text !== summary };
}

export function groupSkillPresences(presences: ReadonlyArray<ProjectSkillPresence>) {
  const groups = new Map<
    string,
    { path: string; scope: string | null; presences: ProjectSkillPresence[] }
  >();
  for (const presence of presences) {
    const key = JSON.stringify([presence.scope, presence.path]);
    const group = groups.get(key) ?? { path: presence.path, scope: presence.scope, presences: [] };
    group.presences.push(presence);
    groups.set(key, group);
  }
  return [...groups.values()];
}

export function safeSkillLink(url: string) {
  try {
    const parsed = new URL(url);
    return ["https:", "http:", "mailto:"].includes(parsed.protocol) ? url : "";
  } catch {
    return "";
  }
}

export function skillBody(content: string) {
  return content.replace(/^---\r?\n[\s\S]*?\r?\n---(?:\r?\n|$)/, "");
}
