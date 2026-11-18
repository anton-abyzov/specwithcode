// @vitest-environment jsdom
import * as NodeFS from "node:fs";
import * as NodePath from "node:path";
import * as NodeURL from "node:url";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vite-plus/test";

import { STEP_PICTURE_KEYS, StepPicture, type StepPictureStep } from "./StepPicture";

const indexCss = NodeFS.readFileSync(
  NodePath.resolve(NodePath.dirname(NodeURL.fileURLToPath(import.meta.url)), "./setupMotion.css"),
  "utf8",
);

let root: Root;
let container: HTMLDivElement;

beforeEach(() => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
});
afterEach(async () => {
  await act(async () => root.unmount());
  container.remove();
  vi.unstubAllGlobals();
});

const STEPS: readonly StepPictureStep[] = ["connect", "agents", "access", "projects"];
const svg = () => container.querySelector<SVGSVGElement>("[data-step-picture]")!;
const litThreads = () =>
  [...container.querySelectorAll("[data-setup-thread][data-lit]")].map((path) =>
    path.getAttribute("data-setup-thread"),
  );

it.each(STEPS)("draws %s hidden from assistive technology, with no text", async (step) => {
  await act(async () => root.render(<StepPicture step={step} />));
  expect(svg().getAttribute("data-step-picture")).toBe(step);
  expect(svg().getAttribute("aria-hidden")).toBe("true");
  expect(container.querySelector("text, title, desc, foreignObject")).toBeNull();
  expect(container.textContent).toBe("");
  // Theme colors only: no fill or stroke written as a color value.
  for (const element of container.querySelectorAll("[fill], [stroke]")) {
    for (const attribute of ["fill", "stroke"]) {
      const value = element.getAttribute(attribute);
      if (value !== null) expect(["none", "currentColor"]).toContain(value);
    }
  }
  // Nothing is drawn yet: every thread waits for what it stands for.
  expect(litThreads()).toEqual([]);
});

it("pulls a thread tight from the agent to each allowed thing, and only for the rows shown", async () => {
  await act(async () =>
    root.render(
      <StepPicture step="access" rows={["files", "browser", "mac-apps"]} lit={["files"]} />,
    ),
  );
  const rows = [...container.querySelectorAll("[data-setup-access-row]")].map((row) =>
    row.getAttribute("data-setup-access-row"),
  );
  expect(rows).toEqual(["files", "browser", "mac-apps"]);
  expect(svg().getAttribute("viewBox")).toBe("0 0 200 220");
  expect(litThreads()).toEqual(["files"]);
  expect(container.querySelector('[data-setup-slack="files"]')?.hasAttribute("data-lit")).toBe(
    true,
  );
  expect(container.querySelector('[data-setup-glow="files"]')?.hasAttribute("data-lit")).toBe(true);
  expect(container.querySelector('[data-setup-glow="browser"]')?.hasAttribute("data-lit")).toBe(
    false,
  );

  // A row allowed later draws its own thread; the earlier one stays as it is.
  const filesThread = container.querySelector('[data-setup-thread="files"]');
  await act(async () =>
    root.render(
      <StepPicture
        step="access"
        rows={["files", "browser", "mac-apps"]}
        lit={["files", "mac-apps"]}
      />,
    ),
  );
  expect(litThreads()).toEqual(["files", "mac-apps"]);
  expect(container.querySelector('[data-setup-thread="files"]')).toBe(filesThread);
  // Every thread runs from the agent.
  for (const thread of container.querySelectorAll("[data-setup-thread]")) {
    expect(thread.getAttribute("d")).toMatch(/^M50 110C/);
    expect(thread.getAttribute("pathLength")).toBe("1");
  }
});

it("draws all five Access rows when none are named", async () => {
  await act(async () => root.render(<StepPicture step="access" />));
  expect(container.querySelectorAll("[data-setup-access-row]")).toHaveLength(
    STEP_PICTURE_KEYS.access.length,
  );
});

it.each([
  ["connect", ["machine", "phone"], ["machine", "phone"]],
  ["agents", ["review"], ["review", "back"]],
  ["projects", ["picked"], ["picked", "picked-2"]],
] as const)("%s draws its threads for its keys", async (step, lit, threads) => {
  expect(STEP_PICTURE_KEYS[step]).toEqual(lit);
  await act(async () => root.render(<StepPicture step={step} lit={lit} />));
  expect(litThreads()).toEqual(threads);
});

it("marks everything that moves for the setup motion rules, reduced motion included", async () => {
  for (const step of STEPS) {
    await act(async () => root.render(<StepPicture step={step} lit={STEP_PICTURE_KEYS[step]} />));
    const moving = container.querySelectorAll(
      "[data-setup-thread], [data-setup-slack], [data-setup-glow]",
    );
    expect(moving.length).toBeGreaterThan(0);
    for (const element of moving) expect(element.getAttribute("data-motion")).toBe("setup");
  }
  // Transitions only, which run once per change; no keyframes, so nothing loops.
  const pictureRules = indexCss.slice(indexCss.indexOf('[data-slot="step-picture"]'));
  for (const selector of ["[data-setup-thread]", "[data-setup-slack]", "[data-setup-glow]"]) {
    const rule = pictureRules.slice(pictureRules.indexOf(`${selector} {`));
    const body = rule.slice(0, rule.indexOf("}"));
    expect(body, selector).toMatch(/transition: (stroke-dashoffset|opacity) var\(--motion-/);
    expect(body, selector).not.toMatch(/animation/);
  }
  const reduced = indexCss.slice(indexCss.lastIndexOf("@media (prefers-reduced-motion: reduce)"));
  // Only what is marked: motion that is not setup's (a spinner in a step) keeps running.
  expect(reduced).toMatch(/\[data-motion="setup"\],\s*\[data-motion="setup"\]::before,/);
  expect(reduced).not.toContain('[data-motion="setup"] *');
  // The entrances play only where motion is welcome.
  const entrance = indexCss.indexOf('[data-setup-entry="first"][data-slot="setup-step"] > * {');
  expect(
    indexCss.lastIndexOf("@media (prefers-reduced-motion: no-preference)", entrance),
  ).toBeGreaterThan(indexCss.indexOf("--motion-soft:"));
  expect(reduced).toMatch(/animation: none !important;\s*transition: none !important;/);
});
