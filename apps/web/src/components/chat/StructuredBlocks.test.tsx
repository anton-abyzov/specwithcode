// @vitest-environment jsdom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it } from "vite-plus/test";

import { chatMarkdownClipboardPayload } from "../../markdown-clipboard";
import { structuredFenceView } from "./StructuredBlocks";
import { pathBreakSegments } from "./structuredBlocks.logic";

const SPEC_PATH = "/Users/example/Projects/specweave-umb/.specweave/increments/1049-files/spec.md";
const ARTIFACT_URL = "https://claude.ai/artifact/ExampleArtifact0001";
const ZERO_WIDTH = /[​⁠﻿­]/;

let root: Root;
let host: HTMLDivElement;

beforeEach(() => {
  (globalThis as Record<string, unknown>).IS_REACT_ACT_ENVIRONMENT = true;
  host = document.createElement("div");
  document.body.append(host);
  root = createRoot(host);
});
afterEach(() => {
  act(() => root.unmount());
  host.remove();
  window.getSelection()?.removeAllRanges();
});

function renderFence(language: string, code: string) {
  const view = structuredFenceView(language, code);
  expect(view).not.toBeNull();
  act(() => root.render(<>{view}</>));
}

function valueCell(key: string): HTMLElement {
  const dt = [...host.querySelectorAll("dt")].find((node) => node.textContent === key);
  expect(dt).toBeDefined();
  const dd = dt!.nextElementSibling as HTMLElement;
  expect(dd.tagName).toBe("DD");
  return dd;
}

function select(range: Range): Selection {
  const selection = window.getSelection()!;
  selection.removeAllRanges();
  selection.addRange(range);
  return selection;
}

describe("property card values", () => {
  it("wrap only after path separators, as <wbr>, and read as the original text", () => {
    renderFence("kv", `Spec: ${SPEC_PATH}\nArtifact: ${ARTIFACT_URL}\nPending: 1`);
    const spec = valueCell("Spec");
    expect(spec.hasAttribute("data-path-wrap")).toBe(true);
    expect(spec.textContent).toBe(SPEC_PATH);
    expect(spec.innerHTML).toBe(pathBreakSegments(SPEC_PATH).join("<wbr>"));
    expect(spec.querySelectorAll("wbr")).toHaveLength(10);
    expect(spec.innerHTML).toContain("specweave-<wbr>umb/<wbr>.specweave/");
    expect(ZERO_WIDTH.test(spec.innerHTML)).toBe(false);

    const artifact = valueCell("Artifact");
    expect(artifact.textContent).toBe(ARTIFACT_URL);
    expect(artifact.innerHTML).toContain("https://<wbr>claude.");
    expect(artifact.innerHTML).not.toContain(":<wbr>");

    const pending = valueCell("Pending");
    expect(pending.innerHTML).toBe("1");
  });

  it("copy exactly when selected whole or in part", () => {
    renderFence("kv", `Spec: ${SPEC_PATH}`);
    const spec = valueCell("Spec");

    const whole = document.createRange();
    whole.selectNodeContents(spec);
    const selection = select(whole);
    expect(selection.toString()).toBe(SPEC_PATH);
    expect(chatMarkdownClipboardPayload(selection)?.text).toBe(SPEC_PATH);

    const texts = [...spec.childNodes].filter((node) => node.nodeType === Node.TEXT_NODE);
    const part = document.createRange();
    part.setStart(texts[1]!, 3);
    part.setEnd(texts[8]!, 2);
    const partial = select(part);
    const expected = SPEC_PATH.slice(
      SPEC_PATH.indexOf("example/") + 3,
      SPEC_PATH.indexOf("files/") + 2,
    );
    expect(partial.toString()).toBe(expected);
    expect(chatMarkdownClipboardPayload(partial)?.text).toBe(expected);
  });

  it("keep keys at their own width and stack them on a narrow card", () => {
    renderFence("kv", `# Worker\nIncrement spec path for the worker: ${SPEC_PATH}\nEmpty:`);
    const card = host.querySelector("[data-structured-kv]")!;
    expect(card.className).toContain("@container/kv");
    expect(card.className).toContain("[contain-intrinsic-inline-size:32rem]");
    const dl = card.querySelector("dl")!;
    expect(dl.className).toContain("grid-cols-[minmax(7rem,max-content)_minmax(0,1fr)]");
    expect(dl.className).toContain("@max-[22rem]/kv:grid-cols-1");
    const [first, second] = [...dl.querySelectorAll("dt")];
    for (const dt of [first!, second!]) {
      expect(dt.className).toContain("break-words");
      expect(dt.className).toContain("[word-break:normal]");
      expect(dt.className).toContain("hyphens-none");
      expect(dt.className).toContain("max-w-[16rem]");
    }
    expect(first!.className).not.toContain("@max-[22rem]/kv:mt-1.5");
    expect(second!.className).toContain("@max-[22rem]/kv:mt-1.5");
    expect(valueCell("Empty").textContent).toBe("—");
  });

  it("wrap a long key at its separators and keep its text exact", () => {
    renderFence("kv", "worker.queue_path-override: /tmp/example\nRatio: 0.75");
    const key = [...host.querySelectorAll("dt")][0]!;
    expect(key.textContent).toBe("worker.queue_path-override");
    expect(key.innerHTML).toBe("worker.<wbr>queue_<wbr>path-<wbr>override");
    expect(valueCell("Ratio").innerHTML).toBe("0.75");
  });
});

describe("JSON grids", () => {
  it("wrap string paths the same way and leave dates and numbers alone", () => {
    renderFence(
      "json",
      JSON.stringify({
        path: "/tmp/example/a-b_c.d",
        at: "2026-10-21T08:22:41.586Z",
        port: 8319,
        ratio: 0.25,
        wait_seconds: 1534,
        label: "",
        owner: null,
        queue: { pending: 1, log: "/tmp/example/queue.log" },
      }),
    );
    const json = host.querySelector("[data-structured-json]")!;
    expect(json.querySelector(".\\@container\\/kv")).not.toBeNull();

    const path = valueCell("Path").querySelector("[data-path-wrap]")!;
    expect(path.textContent).toBe("/tmp/example/a-b_c.d");
    expect(path.innerHTML).toBe("/tmp/<wbr>example/<wbr>a-<wbr>b_<wbr>c.<wbr>d");

    const at = valueCell("At").querySelector("time")!;
    expect(at.getAttribute("datetime")).toBe("2026-10-21T08:22:41.586Z");
    expect(at.querySelector("wbr")).toBeNull();
    expect(valueCell("Port").textContent).toBe("8319");
    expect(valueCell("Ratio").textContent).toBe("0.25");
    expect(valueCell("Wait seconds").textContent).toBe("25m 34s");
    expect(valueCell("Label").textContent).toBe("empty");
    expect(valueCell("Owner").textContent).toBe("—");

    const group = host.querySelector('[data-structured-group="queue"]')!;
    expect(group.className).toContain("col-span-full");
    expect(valueCell("Log").innerHTML).toContain("queue.<wbr>log");
    expect(valueCell("Path").previousElementSibling!.className).toContain("[word-break:normal]");
  });

  it("wrap table cells and keep the fence's other views", () => {
    renderFence("json", '[{"job":"a","log":"/tmp/example/a.log"},{"job":"b","log":"/tmp/b"}]');
    const cells = [...host.querySelectorAll("td")].map((cell) => cell.textContent);
    expect(cells).toEqual(["a", "/tmp/example/a.log", "b", "/tmp/b"]);
    expect(host.querySelectorAll("td")[1]!.querySelector("[data-path-wrap]")!.innerHTML).toBe(
      "/tmp/<wbr>example/<wbr>a.<wbr>log",
    );
    expect(structuredFenceView("kv", "just prose")).toBeNull();
    expect(structuredFenceView("json", "{broken")).toBeNull();
  });
});
