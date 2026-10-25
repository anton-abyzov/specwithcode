import type { DiffsHighlighter } from "@pierre/diffs";
import { INLINE_RUN_TERMINAL_ID_PREFIX, type RuntimeMode } from "@specweave-studio/contracts";

import { fnv1a32 } from "../../lib/diffRendering";

type HighlightedRoot = ReturnType<DiffsHighlighter["codeToHast"]>;
type HighlightedNode = HighlightedRoot["children"][number];
type HighlightedElement = Extract<HighlightedNode, { type: "element" }>;
type HighlightedContent = HighlightedElement["children"][number];

/** Fence languages whose code runs in the host's login shell. */
export const SHELL_FENCE_LANGUAGE_REGEX = /^(?:sh|bash|zsh|shell|console|shellscript)$/;

const PLAIN_FENCE_LANGUAGES = new Set(["text", "plaintext", "plain", "txt"]);

/** First words an agent puts at the start of a command it asks someone to run. */
const SHELL_COMMAND_WORDS = new Set([
  "awk",
  "bash",
  "brew",
  "bun",
  "bunx",
  "cargo",
  "cat",
  "cd",
  "chmod",
  "chown",
  "claude",
  "codex",
  "cp",
  "curl",
  "deno",
  "docker",
  "du",
  "echo",
  "env",
  "export",
  "find",
  "gh",
  "git",
  "go",
  "grep",
  "head",
  "kill",
  "kubectl",
  "ln",
  "ls",
  "lsof",
  "make",
  "mkdir",
  "mv",
  "node",
  "npm",
  "npx",
  "open",
  "pip",
  "pip3",
  "pnpm",
  "ps",
  "pwd",
  "python",
  "python3",
  "rm",
  "rsync",
  "scp",
  "sed",
  "sh",
  "source",
  "specweave",
  "specweave-studio",
  "ssh",
  "sudo",
  "tail",
  "tar",
  "touch",
  "unzip",
  "uv",
  "vercel",
  "wget",
  "which",
  "xcodebuild",
  "yarn",
  "zip",
  "zsh",
]);

function shellLines(code: string): string[] {
  return code
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => line.length > 0 && !line.startsWith("#"));
}

function isCommandLine(line: string): boolean {
  const first = line.replace(/^\$\s+/, "").split(/\s+/, 1)[0] ?? "";
  // `FOO=1 cmd` and paths like `./run.sh` or `~/bin/tool` are commands too.
  if (/^[A-Za-z_][A-Za-z0-9_]*=\S*$/.test(first)) return true;
  if (/^(?:\.{1,2}|~)?\/[\w./-]+$/.test(first)) return true;
  return SHELL_COMMAND_WORDS.has(first);
}

/**
 * Whether an unlabeled block reads as shell commands: every line that is not a
 * comment or a continuation starts with a command. Prose and output fail.
 */
export function looksLikeShellCommand(code: string): boolean {
  const lines = shellLines(code);
  if (lines.length === 0 || lines.length > 20) return false;
  let continued = false;
  for (const line of lines) {
    if (!continued && !isCommandLine(line)) return false;
    continued = line.endsWith("\\") || line.endsWith("&&") || line.endsWith("|");
  }
  return !continued;
}

/** The language a fence is shown and run as: an unlabeled or `text` command is shell. */
export function resolveCodeFenceLanguage(language: string, code: string): string {
  return PLAIN_FENCE_LANGUAGES.has(language) && looksLikeShellCommand(code) ? "bash" : language;
}

/**
 * The command a closed shell fence runs, or null. `code` keeps the fence's
 * trailing newline, which only a closed fence has.
 */
export function runnableShellCommand(language: string, code: string): string | null {
  if (!SHELL_FENCE_LANGUAGE_REGEX.test(language) || !code.endsWith("\n")) return null;
  // Control and invisible format characters (bidi overrides, zero-width) can
  // make the rendered command differ from what the shell would receive.
  if (/[\p{Cc}\p{Cf}]/u.test(code.slice(0, -1).replace(/[\n\t]/g, ""))) return null;
  const lines = code.trimEnd().split("\n");
  // A transcript with `$ ` prompts runs without them.
  const prompted = lines.filter((line) => line.trim().length > 0);
  const stripped = prompted.every((line) => /^\s*\$\s/.test(line))
    ? lines.map((line) => line.replace(/^\s*\$\s/, ""))
    : lines;
  const command = stripped.join("\n").trim();
  if (command.length === 0 || command.length > 16_384 || command.endsWith("\\")) return null;
  return command;
}

/** One terminal per command in a thread, so running it again replaces the last output. */
export function inlineRunTerminalId(command: string): string {
  return `${INLINE_RUN_TERMINAL_ID_PREFIX}${fnv1a32(command).toString(36)}-${command.length}`;
}

/** Full access runs a code block on click; every stricter mode asks first. */
export function shellRunNeedsConfirmation(runtimeMode: RuntimeMode | null): boolean {
  return runtimeMode !== "full-access";
}

// CSI, OSC (BEL or ST terminated) and two-byte escape sequences.
const ANSI_SEQUENCE_REGEX =
  // oxlint-disable-next-line no-control-regex -- terminal escape sequences start with ESC
  /\u001b(?:\[[0-?]*[ -/]*[@-~]|\][^\u0007\u001b]*(?:\u0007|\u001b\\)|[@-Z\\-_])/g;
// oxlint-disable-next-line no-control-regex -- strips control bytes left in terminal output
const STRAY_CONTROL_REGEX = /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/g;

/** Text without terminal escape sequences; line endings and every other byte stay. */
export function withoutTerminalEscapes(raw: string): string {
  return raw.replace(ANSI_SEQUENCE_REGEX, "");
}

/**
 * Terminal output as plain text: escape sequences removed, and a carriage
 * return keeps only what was drawn last on that line, as progress bars expect.
 */
export function terminalOutputPlainText(raw: string): string {
  const text = raw.replace(ANSI_SEQUENCE_REGEX, "").replaceAll("\r\n", "\n");
  return text
    .split("\n")
    .map((line) => {
      const parts = line.split("\r");
      let rendered = "";
      for (const part of parts) rendered = part + rendered.slice(part.length);
      return rendered.replace(STRAY_CONTROL_REGEX, "");
    })
    .join("\n");
}

function textOf(node: HighlightedContent): string | null {
  if (node.type === "text") return node.value;
  if (node.type !== "element") return null;
  let value = "";
  for (const child of node.children) {
    if (child.type !== "text") return null;
    value += child.value;
  }
  return value;
}

function groupLineWords(line: HighlightedElement): HighlightedElement {
  const children: HighlightedContent[] = [];
  let word: HighlightedContent[] | null = null;
  const flush = () => {
    if (word === null) return;
    children.push({
      type: "element",
      tagName: "span",
      properties: { className: ["chat-markdown-word"] },
      children: word,
    });
    word = null;
  };
  for (const token of line.children) {
    const value = textOf(token);
    if (value === null) return line;
    for (const part of value.split(/(\s+)/)) {
      if (part.length === 0) continue;
      const text = { type: "text" as const, value: part };
      const piece: HighlightedContent =
        token.type === "element" ? { ...token, children: [text] } : text;
      if (/^\s+$/.test(part)) {
        flush();
        children.push(piece);
      } else {
        (word ??= []).push(piece);
      }
    }
  }
  flush();
  return { ...line, children };
}

const groupedLines = new WeakMap<HighlightedElement, HighlightedElement>();

/**
 * Wraps each run of non-space characters on a highlighted line in one span, so
 * wrapping breaks a command only at spaces: `-d` never splits after its dash.
 * Lines keep their identity across calls, which the streaming renderer needs.
 */
export function groupHighlightedWords(root: HighlightedRoot): HighlightedRoot {
  const pre = root.children[0];
  if (pre?.type !== "element" || pre.tagName !== "pre") return root;
  const code = pre.children[0];
  if (code?.type !== "element" || code.tagName !== "code") return root;
  const lines = code.children.map((node) => {
    if (node.type !== "element") return node;
    let grouped = groupedLines.get(node);
    if (!grouped) {
      grouped = groupLineWords(node);
      groupedLines.set(node, grouped);
    }
    return grouped;
  });
  return {
    ...root,
    children: [
      { ...pre, children: [{ ...code, children: lines }, ...pre.children.slice(1)] },
      ...root.children.slice(1),
    ],
  };
}
