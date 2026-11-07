import { CLAUDE_READ_ONLY_STUDIO_MCP_ALLOWED_TOOLS } from "../orchestration-v2/Adapters/claudeReadOnlyMcpTools.ts";

/**
 * SpecWithCode's own tools that only read state, by bare tool name. A provider
 * may run them without asking in any mode: the read-only toolkit tools Claude
 * already allows, plus Google's setup status and the status of this thread's
 * own delegated tasks. Gmail, Drive and Calendar content, and other threads'
 * transcripts, stay behind approval.
 */
export const STUDIO_READ_ONLY_TOOLS: ReadonlySet<string> = new Set([
  ...CLAUDE_READ_ONLY_STUDIO_MCP_ALLOWED_TOOLS.map((name) =>
    name.replace(/^mcp__studio-code__/, ""),
  ),
  "studio_google_status",
  "task_status",
]);

// How providers spell a studio-code tool: mcp__studio_code__x (Muse, Claude),
// studio-code_x (OpenCode), studio-code/x, studio-code.x or "x (studio-code MCP Server)".
const QUALIFIED = [
  /^mcp__studio[-_]code__([a-z0-9_]+)$/i,
  /^studio[-_]code[_/.:]([a-z0-9_]+)$/i,
  /^([a-z0-9_]+) \(studio[-_]code(?: MCP Server)?\)$/i,
];

/** The bare name of a SpecWithCode tool, only when the title names its server. */
export function studioToolName(title: string | null | undefined): string | null {
  const trimmed = title?.trim() ?? "";
  for (const pattern of QUALIFIED) {
    const match = pattern.exec(trimmed);
    if (match?.[1] !== undefined) return match[1];
  }
  return null;
}

export function isStudioReadOnlyTool(title: string | null | undefined): boolean {
  const name = studioToolName(title);
  return name !== null && STUDIO_READ_ONLY_TOOLS.has(name);
}
