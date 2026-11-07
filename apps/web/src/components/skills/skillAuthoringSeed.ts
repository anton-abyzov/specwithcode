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
  const metadata = header.metadata === undefined ? {} : record(header.metadata);
  if (!metadata) return { error: "The skill metadata must be a mapping." };
  const unsupported = [
    ...Object.keys(header).filter((key) => !["name", "description", "metadata"].includes(key)),
    ...Object.keys(metadata)
      .filter((key) => key !== "version")
      .map((key) => `metadata.${key}`),
  ];
  if (unsupported.length > 0)
    return {
      error: `This skill uses additional frontmatter (${unsupported.join(", ")}). Edit its source to preserve those fields.`,
    };
  const name = typeof header.name === "string" ? header.name : fallbackName;
  const description = typeof header.description === "string" ? header.description : "";
  const version = typeof metadata.version === "string" ? metadata.version : "1.0.0";
  const instructions = (match ? markdown.slice(match[0].length) : markdown).trim();
  if (name.length > 100 || description.length > 2000 || instructions.length > 100_000)
    return { error: "This skill exceeds the draft editor's content limits." };
  return { content: { name, description, instructions, version, prompt: "" } };
}

export function nextSkillPatchVersion(version: string): string | null {
  const match = /^(\d+)\.(\d+)\.(\d+)$/.exec(version);
  if (!match || !Number.isSafeInteger(Number(match[3]) + 1)) return null;
  return `${match[1]}.${match[2]}.${Number(match[3]) + 1}`;
}
