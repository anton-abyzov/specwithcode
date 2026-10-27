// @vitest-environment jsdom
import type { DesignSystemProposeInput } from "@specweave-studio/contracts";
import { act, useState } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vite-plus/test";

import { FIGMA_CONNECTED, FIGMA_OFF, PROJECTS, SCAN_RESULT } from "./fixtureData";
import {
  defaultSystemOwner,
  FIGMA_OFF_INSTRUCTIONS,
  NewDesignSystemDialog,
  type FigmaStatusView,
  type NewSystemMode,
} from "./NewDesignSystemDialog";

let container: HTMLDivElement;
let root: Root;

beforeEach(() => {
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
});

afterEach(() => {
  act(() => root.unmount());
  container.remove();
  document.body.innerHTML = "";
});

const flush = () => act(async () => new Promise((resolve) => setTimeout(resolve, 0)));
const $ = <T extends Element = HTMLElement>(selector: string) =>
  document.body.querySelector<T>(selector);
const button = (text: string) =>
  [...document.body.querySelectorAll("button")].find((b) => b.textContent?.includes(text)) ?? null;

function Harness({
  initial,
  figma,
  onPropose,
}: {
  initial: NewSystemMode;
  figma: FigmaStatusView;
  onPropose: (input: DesignSystemProposeInput) => Promise<string | null>;
}) {
  const [mode, setMode] = useState(initial);
  return (
    <NewDesignSystemDialog
      mode={mode}
      onModeChange={setMode}
      onOpenChange={() => undefined}
      projects={PROJECTS}
      figma={figma}
      onScan={async () => ({ ok: true, result: SCAN_RESULT })}
      onPropose={onPropose}
    />
  );
}

const figmaView = (status: FigmaStatusView["status"]): FigmaStatusView => ({
  status,
  error: null,
  checking: false,
  onCheck: vi.fn(),
});

describe("NewDesignSystemDialog", () => {
  it("says plainly how to turn on Figma's desktop server and offers a file instead", async () => {
    const figma = figmaView(FIGMA_OFF);
    await act(async () =>
      root.render(<Harness initial="figma" figma={figma} onPropose={async () => null} />),
    );
    await flush();
    const off = $('[data-testid="figma-off"]')!;
    expect(off.textContent).toContain(FIGMA_OFF_INSTRUCTIONS);
    expect(FIGMA_OFF_INSTRUCTIONS).toBe(
      "In Figma, open Preferences and turn on Enable desktop MCP server.",
    );
    expect(button("Read variables")).toBeNull();
    await act(async () => button("Check again")!.click());
    expect(figma.onCheck).toHaveBeenCalledOnce();
    await act(async () => $<HTMLElement>('[data-testid="figma-use-file"]')!.click());
    await flush();
    expect($('[data-testid="new-design-system-dialog"]')!.dataset.mode).toBe("tokens-file");
    expect($('[data-testid="tokens-file-panel"]')).not.toBeNull();
  });

  it("lists the tools Figma's desktop server exposes and marks the variables tool (AC-09)", async () => {
    const status = {
      ...FIGMA_CONNECTED,
      tools: [
        { name: "get_code", description: "Generates code for a node" },
        { name: "get_variable_defs" },
        { name: "get_screenshot" },
      ],
    };
    await act(async () =>
      root.render(
        <Harness initial="figma" figma={figmaView(status)} onPropose={async () => null} />,
      ),
    );
    await flush();
    const tools = $('[data-testid="figma-tools"]')!;
    expect(tools.textContent).toContain("3 tools listed");
    const rows = [...tools.querySelectorAll("li")].map((row) => row.textContent);
    expect(rows).toEqual(["get_code", "get_variable_defsreads variables", "get_screenshot"]);
    expect(button("Read variables")).not.toBeNull();
  });

  it("still lists Figma's tools when none of them reads variables", async () => {
    const status = { ...FIGMA_CONNECTED, tools: [{ name: "get_code" }], variablesTool: null };
    await act(async () =>
      root.render(
        <Harness initial="figma" figma={figmaView(status)} onPropose={async () => null} />,
      ),
    );
    await flush();
    expect($('[data-testid="figma-panel"]')!.dataset.state).toBe("no-tool");
    expect($('[data-testid="figma-tools"]')!.textContent).toBe("1 tool listedget_code");
    expect(button("Read variables")).toBeNull();
  });

  it("reads picked tokens files and proposes them with their names", async () => {
    const onPropose = vi.fn(async (_input: DesignSystemProposeInput) => null);
    await act(async () =>
      root.render(<Harness initial="tokens-file" figma={figmaView(null)} onPropose={onPropose} />),
    );
    await flush();
    const input = $<HTMLInputElement>('[data-testid="tokens-file-input"]')!;
    expect(input.accept).toBe(".json,application/json");
    expect(input.multiple).toBe(true);
    const files = [
      new File(['{"color":{"$type":"color"}}'], "Brand.Light.tokens.json", {
        type: "application/json",
      }),
      new File(['{"color":{}}'], "Brand.Dark.tokens.json", { type: "application/json" }),
    ];
    Object.defineProperty(input, "files", { value: files, configurable: true });
    await act(async () => input.dispatchEvent(new Event("change", { bubbles: true })));
    await flush();
    expect($('[data-testid="tokens-file-list"]')!.textContent).toContain("Brand.Dark.tokens.json");
    await act(async () => $<HTMLButtonElement>('[data-testid="tokens-file-propose"]')!.click());
    await flush();
    expect(onPropose).toHaveBeenCalledWith({
      owner: { kind: "project", projectId: "atlas-web" },
      from: {
        kind: "tokens-file",
        files: [
          { fileName: "Brand.Light.tokens.json", contents: '{"color":{"$type":"color"}}' },
          { fileName: "Brand.Dark.tokens.json", contents: '{"color":{}}' },
        ],
      },
    });
  });

  it("scans a project and proposes a suggestion with its preselected files", async () => {
    const onPropose = vi.fn(async (_input: DesignSystemProposeInput) => null);
    await act(async () =>
      root.render(<Harness initial="code" figma={figmaView(null)} onPropose={onPropose} />),
    );
    await act(async () => button("Scan project")!.click());
    await flush();
    const weave = $('[data-testid="scan-suggestion"][data-key="weave"]')!;
    const ticked = [...weave.querySelectorAll<HTMLElement>('[data-testid="scan-candidate"]')].map(
      (row) => [
        row.dataset.path,
        row.querySelector('[role="checkbox"]')?.getAttribute("aria-checked"),
      ],
    );
    expect(ticked).toEqual([
      ["weave/tokens.json", "true"],
      ["weave/weave.css", "true"],
      ["weave/legacy.tokens.json", "false"],
    ]);
    expect($('[data-testid="scan-skipped"]')!.textContent).toContain("Larger than 2 MB");
    await act(async () =>
      weave.querySelector<HTMLElement>('[data-testid="scan-propose"]')!.click(),
    );
    await flush();
    expect(onPropose).toHaveBeenCalledWith({
      owner: { kind: "project", projectId: "atlas-web" },
      from: {
        kind: "code",
        paths: ["weave/tokens.json", "weave/weave.css"],
        // Brand files beside copies are offered too.
        copies: ["vskill-platform/src/styles/weave.css"],
        name: "Weave",
      },
    });
  });
});

describe("defaultSystemOwner", () => {
  const archived = { id: "archived" as never, title: "Archived", unavailable: "Archived project" };
  const missing = { id: "missing" as never, title: "Missing", unavailable: "Folder missing" };
  const plain = { id: "plain" as never, title: "Plain" };

  it("uses the project the dialog was opened for", () => {
    expect(defaultSystemOwner([archived, plain], plain.id)).toEqual({
      kind: "project",
      projectId: "plain",
    });
  });

  it("never falls back to an archived, automated or missing-folder project", () => {
    expect(defaultSystemOwner([archived, missing, plain])).toEqual({
      kind: "project",
      projectId: "plain",
    });
    expect(defaultSystemOwner([archived, missing])).toEqual({ kind: "playground" });
  });
});
