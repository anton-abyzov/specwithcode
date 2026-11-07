import type { SkillAuthoringContent } from "@specweave-studio/contracts";
import { fromYaml } from "@specweave-studio/shared/schemaYaml";
import * as Schema from "effect/Schema";

export interface SkillAuthoringSeed {
  readonly key: string;
  readonly label: string;
  readonly content: SkillAuthoringContent;
}

const parseHeader = Schema.decodeUnknownSync(fromYaml(Schema.Unknown));
const record = (value: unknown): Record<string, unknown> | null =>
  typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;

/** An explicit edit import. Never silently discard frontmatter the editor cannot preserve. */
export function skillAuthoringSeedFromMarkdown(
  markdown: string,
  fallbackName: string,
): { content: SkillAuthoringContent } | { error: string } {
  if (markdown.length > 110_000) return { error: "This skill is too large for the draft editor." };
  const match = /^\uFEFF?---\r?\n([\s\S]*?)\r?\n---(?:\r?\n|$)/.exec(markdown);
  if (/^\uFEFF?---(?:\r?\n|$)/.test(markdown) && !match)
    return { error: "The skill frontmatter is missing its closing delimiter." };
  if (match && (match[1]?.length ?? 0) > 20_000)
    return { error: "The skill frontmatter exceeds the editor limit." };
  let header: Record<string, unknown> = {};
  if (match) {
    try {
      const parsed = record(parseHeader(match[1]));
      if (!parsed) return { error: "The skill frontmatter must be a mapping." };
      header = parsed;
    } catch {
      return { error: "The skill frontmatter is not valid YAML. Correct it before editing here." };
    }
  }
  const seen = new Set<object>();
  let nodes = 0;
  const safe = (value: unknown, depth = 0): boolean => {
    if (++nodes > 2048 || depth > 12) return false;
    if (value === null || typeof value === "string" || typeof value === "boolean") return true;
    if (typeof value === "number") return Number.isFinite(value);
    if (typeof value !== "object" || seen.has(value)) return false;
    seen.add(value);
    if (Array.isArray(value)) return value.every((entry) => safe(entry, depth + 1));
    return Object.entries(value).every(
      ([key, entry]) =>
        !["__proto__", "constructor", "prototype"].includes(key) && safe(entry, depth + 1),
    );
  };
  if (!safe(header))
    return {
      error:
        "The skill frontmatter contains unsupported aliases, unsafe keys or excessively nested values.",
    };
  const metadata = header.metadata === undefined ? {} : record(header.metadata);
  if (!metadata) return { error: "The skill metadata must be a mapping." };
  const name = typeof header.name === "string" ? header.name : fallbackName;
  const description = typeof header.description === "string" ? header.description : "";
  const version = typeof metadata.version === "string" ? metadata.version : "1.0.0";
  const instructions = (match ? markdown.slice(match[0].length) : markdown).trim();
  if (name.length > 100 || description.length > 2000 || instructions.length > 100_000)
    return { error: "This skill exceeds the draft editor's content limits." };
  return {
    content: {
      name,
      description,
      instructions,
      version,
      prompt: "",
      sourceFrontmatter: match?.[1] ?? "",
    },
  };
}

export function nextSkillPatchVersion(version: string): string | null {
  const match = /^(\d+)\.(\d+)\.(\d+)$/.exec(version);
  if (!match || !Number.isSafeInteger(Number(match[3]) + 1)) return null;
  return `${match[1]}.${match[2]}.${Number(match[3]) + 1}`;
}

/** Render the same complete header that will be saved and published. */
export function skillAuthoringMarkdown(content: SkillAuthoringContent): string {
  if (!content.sourceFrontmatter)
    return `---\nname: ${JSON.stringify(content.name)}\ndescription: ${JSON.stringify(content.description)}\nmetadata:\n  version: ${JSON.stringify(content.version)}\n---\n\n${content.instructions.trim()}\n`;
  const header = record(parseHeader(content.sourceFrontmatter));
  if (!header) throw new Error("The skill frontmatter must be a mapping.");
  const metadata = header.metadata === undefined ? {} : record(header.metadata);
  if (!metadata) throw new Error("The skill metadata must be a mapping.");
  const updated = {
    ...header,
    name: content.name,
    description: content.description,
    metadata: { ...metadata, version: content.version },
  };
  const yaml = Schema.encodeSync(fromYaml(Schema.Unknown))(updated);
  return `---\n${yaml.trimEnd()}\n---\n\n${content.instructions.trim()}\n`;
}
