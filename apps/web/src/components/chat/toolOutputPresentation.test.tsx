// @vitest-environment jsdom
import { act, type ReactNode } from "react";
import { createRoot, type Root } from "react-dom/client";
import { renderToStaticMarkup } from "react-dom/server";
import type { WorkLogPresentationEntry } from "@specweave-studio/client-runtime/work-log/presentation";
import type { EnvironmentId, OrchestrationV2ProjectedTurnItem } from "@specweave-studio/contracts";
import { afterEach, describe, expect, it, vi } from "vite-plus/test";
import {
  ToolCodePanel,
  toolActivitySummary,
  toolExecutionInput,
  toolPresentationBlocks,
} from "./toolOutputPresentation";
import { V2ItemInspector } from "./V2ItemInspector";

vi.mock("../../hooks/useTheme", () => ({ useTheme: () => ({ resolvedTheme: "light" }) }));
vi.mock("./HighlightedTokens", () => ({
  HighlightedTokens: ({ code, language }: { code: string; language: string }) => (
    <span data-highlight-language={language}>{code}</span>
  ),
}));
vi.mock("../../state/queries", () => ({
  useTurnItemDetail: () => ({ data: undefined, isPending: false, error: null }),
}));
vi.mock("../../state/v2ItemSupport", () => ({ useV2ItemSupport: () => ({}) }));
(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const entry = (overrides: Partial<WorkLogPresentationEntry> = {}): WorkLogPresentationEntry => ({
  id: "tool-1",
  createdAt: "2026-10-08T15:00:00Z",
  label: "Exec",
  tone: "tool",
  ...overrides,
});

let root: Root | undefined;
let container: HTMLDivElement | undefined;
async function mount(children: ReactNode) {
  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
  await act(async () => {
    root!.render(children);
  });
  return container;
}
afterEach(async () => {
  if (root) await act(async () => root!.unmount());
  container?.remove();
  root = undefined;
  container = undefined;
  vi.restoreAllMocks();
});

describe("execution summaries and structured output", () => {
  it("names a shell action and counts lines without flattening its body into the row", () => {
    const shell = "python3 - <<'PY'\nimport pathlib\n    print('result')\nPY\n";
    const work = entry({ command: shell });
    expect(toolActivitySummary(work, "Exec")).toBe("Ran · python3 - <<'PY' · 4 lines");
    expect(toolExecutionInput(work)).toEqual({
      label: "Command",
      text: shell,
      language: "shellscript",
    });
  });
  it("recognizes Codex exec cmd and code inputs and retains metadata separately", () => {
    const work = entry({
      toolTitle: "functions.exec_command",
      toolData: { input: { cmd: "git status\nrg files", workdir: "/scratch" } },
    });
    expect(toolActivitySummary(work, "Exec")).toBe("Ran · git status · 2 lines");
    expect(toolPresentationBlocks(work, undefined, "Exec", null)).toEqual([
      { label: "Command", text: "git status\nrg files", language: "shellscript" },
      { label: "Input", text: '{\n  "workdir": "/scratch"\n}', language: "json" },
    ]);
    const code = entry({
      toolTitle: "functions.exec",
      toolData: {
        input: { code: "const result = await tools.read();\ntext(result);", title: "Read quota" },
      },
    });
    expect(toolActivitySummary(code, "Exec")).toBe("Ran script · Read quota · 2 lines");
    expect(toolExecutionInput(code)?.language).toBe("javascript");
  });
  it.each([
    "Get-Content package.json | Select-String version",
    'pwsh -NoProfile -Command "Get-Date"',
  ])("preserves PowerShell highlighting for native and dynamic commands: %s", (command) => {
    for (const work of [
      entry({ command }),
      entry({ toolTitle: "functions.exec_command", toolData: { input: { cmd: command } } }),
    ]) {
      expect(toolExecutionInput(work)).toEqual({
        label: "Command",
        text: command,
        language: "powershell",
      });
    }
  });
  it("formats PowerShell summaries with visible control characters and bounded lines", () => {
    const command = '  Write-Output "\u001b[31mred\u001b[0m"\r\nGet-Date\r\n';
    expect(toolActivitySummary(entry({ command }), "Exec")).toBe(
      'Ran · Write-Output "␛[31mred␛[0m" · 2 lines',
    );
  });
  it("does not treat arbitrary tools' code fields as executable scripts", () => {
    const work = entry({
      toolTitle: "http.get",
      toolData: { input: { code: "200", cmd: "example" } },
    });
    expect(toolExecutionInput(work)).toBeNull();
    expect(toolActivitySummary(work, "Fetch result")).toBe("Fetch result");
  });
  it("keeps running, failed, stopped and declined labels explicit", () => {
    for (const [toolLifecycleStatus, expected] of [
      ["inProgress", "Running"],
      ["failed", "Failed"],
      ["stopped", "Stopped"],
      ["declined", "Declined"],
    ] as const) {
      expect(toolActivitySummary(entry({ command: "npm test", toolLifecycleStatus }), "Exec")).toBe(
        `${expected} · npm test`,
      );
    }
    expect(toolActivitySummary(entry({ command: "npm test" }), "Running npm", true)).toBe(
      "Running · npm test",
    );
    expect(
      toolActivitySummary(entry({ command: "npm test", toolLifecycleStatus: "idle" }), "Exec"),
    ).toBe("Queued · npm test");
  });
  it("bounds very long previews and preserves output indentation and distinct files", () => {
    const work = entry({
      command: "x".repeat(200),
      detail: "\n  value = 1\n\treturn value\n",
      changedFiles: ["/repo/src/test.ts", "/repo/src/test.ts"],
    });
    expect(toolActivitySummary(work, "Exec").length).toBe(102);
    expect(toolPresentationBlocks(work, "/repo", "Exec", null).slice(1)).toEqual([
      { label: "Output", text: "\n  value = 1\n\treturn value\n" },
      { label: "Files", text: "repo/src/test.ts" },
    ]);
  });
  it("renders provider HTML as selectable text, never live markup", () => {
    const html = renderToStaticMarkup(
      <ToolCodePanel label="Output" text={'<img src=x onerror="alert(1)">\n  indented'} />,
    );
    expect(html).toContain("&lt;img");
    expect(html).not.toContain("<img");
    expect(html).toContain("<pre");
    expect(html).toContain("<code");
    expect(html).toContain('aria-label="Copy output"');
  });
});

describe("tool output controls", () => {
  it.each([undefined, "powershell"] as const)(
    "shows control characters with %s highlighting while copying original bytes",
    async (language) => {
      const value = '\n\tWrite-Output "\u001b[31mred\u001b[0m\u0007\u007f"\r\n';
      const copy = vi.fn().mockResolvedValue(undefined);
      Object.defineProperty(navigator, "clipboard", {
        configurable: true,
        value: { writeText: copy },
      });
      const element = await mount(
        <ToolCodePanel label="Command" text={value} {...(language ? { language } : {})} />,
      );
      expect(element.querySelector("code")?.textContent).toBe(
        '\n\tWrite-Output "␛[31mred␛[0m␇␡"\r\n',
      );
      await act(async () => {
        element.querySelector<HTMLButtonElement>('[aria-label="Copy command"]')!.click();
      });
      expect(copy).toHaveBeenCalledWith(value);
    },
  );
  it("copies exact whitespace and reports success without toggling its parent row", async () => {
    const value = "\n  print('kept')\n\tprint('tab')\n";
    const copy = vi.fn().mockResolvedValue(undefined);
    Object.defineProperty(navigator, "clipboard", {
      configurable: true,
      value: { writeText: copy },
    });
    const rowClick = vi.fn();
    const rowKey = vi.fn();
    const element = await mount(
      <div onClick={rowClick} onKeyDown={rowKey}>
        <ToolCodePanel label="Command" text={value} />
      </div>,
    );
    const button = element.querySelector<HTMLButtonElement>('[aria-label="Copy command"]')!;
    await act(async () => {
      button.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true }));
      button.click();
    });
    expect(copy).toHaveBeenCalledWith(value);
    expect(rowClick).not.toHaveBeenCalled();
    expect(rowKey).not.toHaveBeenCalled();
    expect(button.textContent).toContain("Copied");
    expect(element.querySelector("code")!.textContent).toBe(value);
  });
  it("keeps a long result scrollable, and allows wrapping and full expansion by keyboard", async () => {
    const value = Array.from(
      { length: 40 },
      (_, index) => `    ${index}: ${"value".repeat(50)}`,
    ).join("\n");
    const element = await mount(<ToolCodePanel label="Output" text={value} />);
    const pre = element.querySelector("pre")!;
    expect(pre.className).toContain("max-h-80");
    expect(pre.className).toContain("whitespace-pre");
    expect(pre.tabIndex).toBe(0);
    const wrap = element.querySelector<HTMLButtonElement>('[aria-label="Wrap output lines"]')!;
    const expand = element.querySelector<HTMLButtonElement>('[aria-label="Expand output"]')!;
    await act(async () => {
      wrap.click();
      expand.click();
    });
    expect(wrap.getAttribute("aria-pressed")).toBe("true");
    expect(pre.className).toContain("whitespace-pre-wrap");
    expect(pre.className).not.toContain("max-h-80");
    expect(
      element.querySelector('[aria-label="Collapse output"]')?.getAttribute("aria-expanded"),
    ).toBe("true");
    expect(pre.textContent).toBe(value);
  });
  it("reports clipboard failure honestly and keeps selectable original text", async () => {
    Object.defineProperty(navigator, "clipboard", {
      configurable: true,
      value: { writeText: vi.fn().mockRejectedValue(new Error("denied")) },
    });
    const element = await mount(<ToolCodePanel label="Output" text={"  result\n"} />);
    await act(async () => {
      element.querySelector<HTMLButtonElement>('[aria-label="Copy output"]')!.click();
    });
    expect(element.querySelector('[role="status"]')?.textContent).toContain("Couldn't copy");
    expect(element.querySelector("code")?.textContent).toBe("  result\n");
  });
  it("does not show an old copy success on newly streamed output", async () => {
    let finish: () => void = () => undefined;
    const copy = vi.fn().mockImplementation(
      () =>
        new Promise<void>((resolve) => {
          finish = resolve;
        }),
    );
    Object.defineProperty(navigator, "clipboard", {
      configurable: true,
      value: { writeText: copy },
    });
    const element = await mount(<ToolCodePanel label="Output" text="first chunk" />);
    await act(async () => {
      element.querySelector<HTMLButtonElement>('[aria-label="Copy output"]')!.click();
    });
    await act(async () => {
      root!.render(<ToolCodePanel label="Output" text={"first chunk\nsecond chunk"} />);
      finish();
    });
    expect(
      element.querySelector<HTMLButtonElement>('[aria-label="Copy output"]')!.textContent,
    ).toBe("Copy");
    expect(element.querySelector("code")?.textContent).toBe("first chunk\nsecond chunk");
  });
});

describe("projected tool inspector", () => {
  const inspect = (item: unknown) =>
    renderToStaticMarkup(
      <V2ItemInspector
        environmentId={"fixture" as EnvironmentId}
        projectedItem={
          {
            item,
            sourceThreadId: "thread-1",
            sourceItemId: "item-1",
          } as OrchestrationV2ProjectedTurnItem
        }
        onOpenThread={() => undefined}
        onOpenTurnDiff={() => undefined}
      />,
    );
  it("keeps a native command and its result in distinct selectable panels", () => {
    const markup = inspect({
      type: "command_execution",
      status: "completed",
      input: "  printf 'ready'\n",
      output: "    ready\n",
      exitCode: 0,
    });
    expect(markup).toContain('data-tool-code-panel="command"');
    expect(markup).toContain('data-tool-code-panel="output"');
    expect(markup).toContain("    ready\n");
    expect(markup).not.toContain("exit 0");
  });
  it.each(["command_execution", "dynamic_tool"])(
    "uses PowerShell highlighting in a projected %s inspector",
    (type) => {
      const command = "Get-Content package.json | Select-String version";
      const markup = inspect({
        type,
        status: "completed",
        ...(type === "command_execution"
          ? { input: command, output: "ready" }
          : { toolName: "functions.exec_command", input: { cmd: command }, output: "ready" }),
      });
      expect(markup).toContain('data-highlight-language="powershell"');
      expect(markup).toContain(command);
    },
  );
  it("separates Codex dynamic exec command, metadata, result and failed exit", () => {
    const markup = inspect({
      type: "dynamic_tool",
      status: "completed",
      toolName: "functions.exec_command",
      input: { cmd: "git status\nrg files", workdir: "/scratch" },
      output: [{ type: "text", text: "  no changes\n" }],
    });
    expect(markup).toContain('data-tool-code-panel="command"');
    expect(markup).toContain('data-tool-code-panel="input"');
    expect(markup).toContain('data-tool-code-panel="output"');
    expect(markup).toContain("/scratch");
    expect(markup).toContain("  no changes\n");
    expect(
      inspect({
        type: "command_execution",
        status: "failed",
        input: "npm test",
        output: "failed",
        exitCode: 2,
      }),
    ).toContain("exit 2");
  });
});
