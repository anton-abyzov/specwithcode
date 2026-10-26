import { describe, expect, it } from "vite-plus/test";

import { getSyntaxHighlighterPromise } from "../../lib/syntaxHighlighting";
import {
  groupHighlightedWords,
  inlineRunTerminalId,
  looksLikeShellCommand,
  resolveCodeFenceLanguage,
  runnableShellCommand,
  shellRunNeedsConfirmation,
  terminalOutputPlainText,
  withoutTerminalEscapes,
} from "./shellCodeBlocks";

const SCREENSHOT_COMMAND =
  "cd ~/Downloads/specwithcode-browser-cws && mkdir -p unpacked && unzip -o *.zip -d unpacked";

describe("shell block detection", () => {
  it("reads unlabeled and text fences of commands as bash", () => {
    expect(resolveCodeFenceLanguage("text", SCREENSHOT_COMMAND)).toBe("bash");
    expect(resolveCodeFenceLanguage("text", "$ npm install\n$ npm test")).toBe("bash");
    expect(resolveCodeFenceLanguage("text", "# build first\npnpm build\n./scripts/run.sh")).toBe(
      "bash",
    );
    expect(resolveCodeFenceLanguage("text", "FOO=1 node app.js")).toBe("bash");
    expect(resolveCodeFenceLanguage("text", "git add . && \\\n  git commit -m x")).toBe("bash");
  });

  it("keeps a list of file paths as text, so it renders as files", () => {
    const list =
      "/Users/me/Downloads/cws/specwithcode-browser-1.0.0.zip\n/Users/me/Downloads/cws/icon-128.png\n";
    expect(looksLikeShellCommand(list)).toBe(false);
    expect(resolveCodeFenceLanguage("text", list)).toBe("text");
    expect(resolveCodeFenceLanguage("text", "~/Downloads/cws/SUBMISSION.md")).toBe("text");
    // Programs and scripts, alone or with arguments, still run.
    expect(resolveCodeFenceLanguage("text", "./scripts/release.sh")).toBe("bash");
    expect(resolveCodeFenceLanguage("text", "/usr/local/bin/tool")).toBe("bash");
    expect(resolveCodeFenceLanguage("text", "/opt/app/report.png --open")).toBe("bash");
  });

  it("keeps prose, output and other languages as they are", () => {
    expect(looksLikeShellCommand("This is a sentence, not a command.")).toBe(false);
    expect(looksLikeShellCommand("total 8\ndrwxr-xr-x  2 me staff  64 Oct 17 .")).toBe(false);
    expect(looksLikeShellCommand("ls -la\ntotal 8")).toBe(false);
    expect(looksLikeShellCommand("")).toBe(false);
    expect(resolveCodeFenceLanguage("typescript", "echo hi")).toBe("typescript");
    expect(resolveCodeFenceLanguage("text", "Error: manifest missing")).toBe("text");
  });
});

describe("runnableShellCommand", () => {
  it("runs closed shell fences, multi-line ones included", () => {
    expect(runnableShellCommand("bash", "echo hello\n")).toBe("echo hello");
    expect(runnableShellCommand("zsh", "echo one\necho two\n")).toBe("echo one\necho two");
    expect(runnableShellCommand("sh", "$ npm ci\n$ npm test\n")).toBe("npm ci\nnpm test");
    expect(runnableShellCommand("bash", "printf 'a\\tb'\n")).toBe("printf 'a\\tb'");
  });

  it("refuses open fences, other languages and hidden characters", () => {
    expect(runnableShellCommand("bash", "echo incomplete")).toBeNull();
    expect(runnableShellCommand("typescript", "echo hello\n")).toBeNull();
    expect(runnableShellCommand("powershell", "dir\n")).toBeNull();
    expect(runnableShellCommand("bash", "\n")).toBeNull();
    expect(runnableShellCommand("bash", "echo hello\\\n")).toBeNull();
    expect(runnableShellCommand("bash", "echo safe ‮#\n")).toBeNull();
    expect(runnableShellCommand("bash", "echo a​b\n")).toBeNull();
  });
});

describe("inline run policy", () => {
  it("gives a command one stable inline terminal per thread", () => {
    expect(inlineRunTerminalId("ls")).toBe(inlineRunTerminalId("ls"));
    expect(inlineRunTerminalId("ls")).not.toBe(inlineRunTerminalId("ls -la"));
    expect(inlineRunTerminalId(SCREENSHOT_COMMAND)).toMatch(/^run-[0-9a-z]+-\d+$/);
  });

  it("asks first in every mode except Full access", () => {
    expect(shellRunNeedsConfirmation("full-access")).toBe(false);
    expect(shellRunNeedsConfirmation("approval-required")).toBe(true);
    expect(shellRunNeedsConfirmation("auto-accept-edits")).toBe(true);
    expect(shellRunNeedsConfirmation("auto")).toBe(true);
    expect(shellRunNeedsConfirmation(null)).toBe(true);
  });
});

describe("withoutTerminalEscapes", () => {
  it("removes escape sequences and keeps line endings and carriage returns", () => {
    expect(withoutTerminalEscapes("\u001b[1;32mok\u001b[0m\r\n10%\r100%\u0007")).toBe(
      "ok\r\n10%\r100%\u0007",
    );
  });
});

describe("terminalOutputPlainText", () => {
  it("drops escape sequences and keeps what a carriage return drew last", () => {
    expect(terminalOutputPlainText("\u001b[1;32mok\u001b[0m\r\n")).toBe("ok\n");
    expect(terminalOutputPlainText("\u001b]0;title\u0007done")).toBe("done");
    expect(terminalOutputPlainText("10%\r55%\r100%\r\nnext")).toBe("100%\nnext");
    expect(terminalOutputPlainText("abc\rX")).toBe("Xbc");
  });
});

type HastNode = {
  type: string;
  value?: string;
  properties?: { className?: unknown };
  children?: HastNode[];
};

function textContent(node: HastNode): string {
  return node.type === "text"
    ? (node.value ?? "")
    : (node.children ?? []).map(textContent).join("");
}

function wordBoxes(node: HastNode): string[] {
  const className = node.properties?.className;
  if (Array.isArray(className) && className.includes("chat-markdown-word")) {
    return [textContent(node)];
  }
  return (node.children ?? []).flatMap(wordBoxes);
}

describe("groupHighlightedWords", () => {
  it("puts every word of a command in one box and keeps the text", async () => {
    const highlighter = await getSyntaxHighlighterPromise("bash");
    const root = highlighter.codeToHast(SCREENSHOT_COMMAND, { lang: "bash", theme: "pierre-dark" });
    const grouped = groupHighlightedWords(root);

    expect(textContent(grouped as HastNode)).toBe(textContent(root as HastNode));
    expect(wordBoxes(grouped as HastNode)).toEqual(SCREENSHOT_COMMAND.split(" "));
    // Completed lines keep their grouped identity for the streaming renderer.
    const again = groupHighlightedWords(root);
    const lineOf = (tree: HastNode) => tree.children?.[0]?.children?.[0]?.children?.[0];
    expect(lineOf(again as HastNode)).toBe(lineOf(grouped as HastNode));
  });
});
