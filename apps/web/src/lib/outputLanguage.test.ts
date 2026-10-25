import { describe, expect, it } from "vite-plus/test";
import {
  rawToolOutputText,
  MAX_HIGHLIGHT_CHARS,
  resolveOutputLanguage,
  singleReadPath,
  toolOutputContext,
} from "./outputLanguage";

describe("output language trust and bounds", () => {
  it.each([
    ["tsx", "tsx"],
    ["jsx", "jsx"],
    ["ts", "typescript"],
    ["js", "javascript"],
    ["py", "python"],
    ["rs", "rust"],
    ["go", "go"],
    ["java", "java"],
    ["c", "c"],
    ["cpp", "cpp"],
    ["sh", "shellscript"],
    ["json", "json"],
    ["yaml", "yaml"],
    ["toml", "toml"],
    ["html", "html"],
    ["css", "css"],
    ["sql", "sql"],
    ["md", "markdown"],
  ])("supports explicit and filename %s", (ext, grammar) => {
    expect(resolveOutputLanguage("partial", { language: ext })).toBe(grammar);
    expect(resolveOutputLanguage("partial", { filePath: `/src/file.${ext}` })).toBe(grammar);
  });
  it.each([
    "cat src/View.tsx",
    "sed -n '1,80p' src/View.tsx",
    "head -n 12 src/View.tsx",
    "tail -n 20 src/View.tsx",
    "cat -- src/View.tsx",
  ])("trusts a single read: %s", (command) => {
    expect(singleReadPath(command)).toBe("src/View.tsx");
    expect(resolveOutputLanguage("partial", { command })).toBe("tsx");
  });
  it.each([
    "cat a.ts b.ts",
    "cat a.ts | head",
    "cat a.ts; echo done",
    "rg const a.ts",
    "cat *.ts",
    "cat src/[ab].tsx",
    "cat $(echo a.ts)",
    "cat a.ts\ncat b.ts",
    "cat -n a.ts",
    'sed -n "1,2p" a.ts && true',
    'echo "{}"',
    "npm test",
  ])("rejects mixed or non-read command %s", (command) => {
    expect(resolveOutputLanguage("{}", { command })).toBeUndefined();
  });
  it("prefers explicit metadata and respects unknown grammar", () => {
    expect(resolveOutputLanguage("x", { language: "python", filePath: "x.tsx" })).toBe("python");
    expect(
      resolveOutputLanguage("{}", { language: "unsupported", filePath: "x.tsx" }),
    ).toBeUndefined();
  });
  it("bounds inference and avoids streams, ANSI and mixed text", () => {
    expect(resolveOutputLanguage('{"ok":true}')).toBe("json");
    for (const value of [
      "INFO ready\n{}",
      "src/a.ts:1:export const a=1",
      '{"partial":',
      "\x1b[31m{}",
      "export const a = 1;\nPASS test",
    ])
      expect(resolveOutputLanguage(value)).toBeUndefined();
    expect(resolveOutputLanguage("{}", { streaming: true })).toBeUndefined();
    expect(resolveOutputLanguage(" ".repeat(8192) + "{}")).toBeUndefined();
    expect(
      resolveOutputLanguage("x".repeat(MAX_HIGHLIGHT_CHARS + 1), { language: "tsx" }),
    ).toBeUndefined();
  });
  it("does not confuse executed code with output language", () => {
    expect(
      toolOutputContext({
        type: "dynamic_tool",
        toolName: "functions.exec",
        input: { language: "tsx", code: "anything" },
        output: "{}",
      }),
    ).toEqual({ plain: true });
    expect(
      toolOutputContext({
        type: "dynamic_tool",
        toolName: "read_file",
        input: { path: "a.tsx" },
        output: "x",
      }).filePath,
    ).toBe("a.tsx");
    expect(
      toolOutputContext({
        type: "dynamic_tool",
        output: [
          { type: "text", language: "tsx", text: "x" },
          { type: "text", text: "log" },
        ],
      }),
    ).toEqual({ plain: true });
    expect(
      toolOutputContext({
        type: "dynamic_tool",
        output: [{ type: "text", language: "tsx", text: "x" }],
      }).language,
    ).toBe("tsx");
    expect(
      toolOutputContext({ type: "command_execution", input: "cat a.tsx", exitCode: 1 }),
    ).toEqual({ plain: true });
  });
});

it("retains structured results behind empty MCP text", () => {
  expect(
    rawToolOutputText({
      type: "dynamic_tool",
      output: { content: [{ type: "text", text: "" }], structuredContent: { records: [1] } },
    }),
  ).toBeUndefined();
  expect(
    rawToolOutputText({
      type: "dynamic_tool",
      output: { content: [{ type: "text", text: "\t\r\n" }] },
    }),
  ).toBe("\t\r\n");
});

it("does not hide diagnostics alongside a text content field", () => {
  const item = {
    type: "dynamic_tool",
    toolName: "read_file",
    input: { path: "x.tsx" },
    output: {
      content: [{ type: "text", text: "partial" }],
      diagnostics: [{ message: "required diagnostic" }],
    },
  };
  expect(rawToolOutputText(item)).toBeUndefined();
  expect(toolOutputContext(item)).toEqual({ plain: true });
});
