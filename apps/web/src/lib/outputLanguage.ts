/** Deliberately bounded: streams use context only; uncertain large results stay plain. */
export const MAX_INFERENCE_CHARS = 8192;
export const MAX_HIGHLIGHT_CHARS = 32768;

const aliases: Record<string, string> = {
  tsx: "tsx",
  jsx: "jsx",
  ts: "typescript",
  typescript: "typescript",
  js: "javascript",
  javascript: "javascript",
  mjs: "javascript",
  cjs: "javascript",
  mts: "typescript",
  cts: "typescript",
  py: "python",
  python: "python",
  rs: "rust",
  rust: "rust",
  go: "go",
  java: "java",
  c: "c",
  h: "c",
  cc: "cpp",
  cpp: "cpp",
  cxx: "cpp",
  hpp: "cpp",
  "c++": "cpp",
  sh: "shellscript",
  bash: "shellscript",
  zsh: "shellscript",
  shell: "shellscript",
  shellscript: "shellscript",
  ps1: "powershell",
  powershell: "powershell",
  json: "json",
  jsonc: "jsonc",
  yaml: "yaml",
  yml: "yaml",
  toml: "toml",
  html: "html",
  htm: "html",
  css: "css",
  scss: "scss",
  sql: "sql",
  md: "markdown",
  markdown: "markdown",
  text: "text",
  txt: "text",
  plaintext: "text",
};
export function sourceLanguage(value: unknown): string | undefined {
  return typeof value === "string" ? aliases[value.trim().toLowerCase()] : undefined;
}
function pathLanguage(value: unknown): string | undefined {
  const name = typeof value === "string" ? value.split(/[\\/]/u).pop() : undefined;
  return name?.includes(".") ? sourceLanguage(name.split(".").pop()) : undefined;
}

/** No shell evaluation. Accept only cat, head/tail, or sed's numeric print range. */
export function singleReadPath(command: string): string | undefined {
  if (command.length > 4096 || /[\r\n|;&<>`$*?{}()\[\]]/u.test(command)) return undefined;
  const words = command.match(/"[^"\\]*"|'[^']*'|[^\s"'\\]+/gu);
  if (!words || words.join(" ") !== command.trim().replace(/\s+/gu, " ")) return undefined;
  const args = words.map((word) => word.replace(/^(['"])(.*)\1$/u, "$2"));
  const tool = args.shift();
  if (tool === "cat" && args[0] === "--") args.shift();
  else if ((tool === "head" || tool === "tail") && args[0] === "-n" && /^\d+$/u.test(args[1] ?? ""))
    args.splice(0, 2);
  else if (tool === "sed" && args[0] === "-n" && /^\d+(?:,\d+)?p$/u.test(args[1] ?? ""))
    args.splice(0, 2);
  else if (tool !== "cat" && tool !== "head" && tool !== "tail") return undefined;
  return args.length === 1 && !args[0]!.startsWith("-") ? args[0] : undefined;
}
export interface OutputLanguageContext {
  language?: string | undefined;
  filePath?: string | undefined;
  command?: string | undefined;
  streaming?: boolean | undefined;
  /** Search/multi-block output and failed tools cannot be inferred as source. */
  plain?: boolean | undefined;
}
export function resolveOutputLanguage(
  code: string,
  context: OutputLanguageContext = {},
): string | undefined {
  if (context.plain || code.length > MAX_HIGHLIGHT_CHARS || /\x1b/u.test(code)) return undefined;
  if (context.language !== undefined) return sourceLanguage(context.language);
  if (context.filePath !== undefined) return pathLanguage(context.filePath);
  if (context.command !== undefined) {
    if (
      /(?:^|\n)(?:\[?(?:INFO|WARN|ERROR|DEBUG|PASS|FAIL)\b|(?:cat|sed|head|tail): |[^\n]+:\d+:)/u.test(
        code,
      )
    )
      return undefined;
    return pathLanguage(singleReadPath(context.command));
  }
  if (context.streaming || code.length > MAX_INFERENCE_CHARS) return undefined;
  // Complete JSON is the only inferred configuration grammar. Prefix matches
  // would accidentally color search excerpts and logging wrappers as source.
  const trimmed = code.trim();
  if (/^[\[{]/u.test(trimmed)) {
    try {
      const value: unknown = JSON.parse(trimmed);
      if (value && typeof value === "object") return "json";
    } catch {
      /* partial or mixed */
    }
  }
  if (/^#!\/.*\b(?:bash|sh|zsh)(?:\r?\n)/u.test(code)) return "shellscript";
  if (/^#!\/.*\bpython[\d.]*(?:\r?\n)/u.test(code)) return "python";
  return undefined;
}
function record(value: unknown): Record<string, unknown> | undefined {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}
function string(value: unknown): string | undefined {
  return typeof value === "string" ? value : undefined;
}

/** Only metadata attached to the sole returned text block describes its bytes.
 * Input language often describes the script being executed, not its stdout. */
export function toolOutputContext(item: unknown): OutputLanguageContext {
  const tool = record(item);
  if (!tool) return {};
  const streaming = tool.status === "inProgress" || tool.status === "running";
  if (
    record(tool.output)?.isError === true ||
    record(tool.output)?.is_error === true ||
    tool.status === "failed" ||
    (typeof tool.exitCode === "number" && tool.exitCode !== 0)
  )
    return { plain: true };
  if (tool.type === "command_execution") return { command: string(tool.input), streaming };
  if (tool.type !== "dynamic_tool") return { plain: true };
  if (typeof tool.output !== "string" && rawToolOutputText(tool) === undefined)
    return { plain: true };
  const input = record(tool.input);
  const output = Array.isArray(tool.output) ? tool.output : record(tool.output)?.content;
  if (Array.isArray(output) && output.length !== 1) return { plain: true };
  const block = record(Array.isArray(output) ? output[0] : tool.output);
  const language = string(block?.language);
  const filePath = string(block?.filePath) ?? string(block?.file_path) ?? string(block?.path);
  // A metadata-bearing object must actually be a source block, not a JSON result.
  if (block?.type === "text" && typeof block.text === "string" && (language || filePath))
    return { language, filePath, streaming };
  const name = string(tool.toolName) ?? "";
  if (/(?:^|[._])(?:read_file|read|Read)$/u.test(name)) {
    return {
      filePath: string(input?.file_path) ?? string(input?.path) ?? string(input?.filePath),
      streaming,
    };
  }
  if (/(?:^|[._])(?:exec_command|bash|shell|terminal)$/u.test(name)) {
    return { command: string(input?.cmd) ?? string(input?.command), streaming };
  }
  return { plain: true };
}

/** Keep a sole text source byte-for-byte; generic tool formatting prettifies JSON. */
export function rawToolOutputText(item: unknown): string | undefined {
  const tool = record(item);
  if (tool?.type !== "dynamic_tool" || tool.outputOmitted === true) return undefined;
  if (typeof tool.output === "string") return tool.output;
  const wrapper = record(tool.output);
  if (
    wrapper &&
    wrapper.type !== "text" &&
    Object.keys(wrapper).some(
      (key) => !["content", "structuredContent", "isError", "is_error"].includes(key),
    )
  )
    return undefined;
  const blocks = Array.isArray(tool.output) ? tool.output : wrapper?.content;
  const block = record(Array.isArray(blocks) && blocks.length === 1 ? blocks[0] : tool.output);
  if (block?.type !== "text") return undefined;
  const value = string(block.text);
  // Empty MCP text delegates to structuredContent in the existing formatter.
  if (!value?.trim() && record(tool.output)?.structuredContent !== undefined) return undefined;
  return value;
}
