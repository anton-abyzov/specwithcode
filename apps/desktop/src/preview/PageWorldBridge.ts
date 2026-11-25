import { contextBridge } from "electron";

import { installPageWorld } from "./PageWorld.ts";

/** Installed before page scripts run; each call crosses into the page's world and back. */
const pageWorld: ReturnType<typeof installPageWorld> = contextBridge.executeInMainWorld({
  func: installPageWorld,
});

export interface PageElementContext {
  readonly selector: string | null;
  readonly htmlPreview: string | undefined;
  readonly componentName: string | null;
  readonly styles: string | undefined;
  readonly stack: ReadonlyArray<{
    readonly functionName?: string;
    readonly fileName?: string;
    readonly lineNumber?: number;
    readonly columnNumber?: number;
  }>;
}

// The page's world can return anything, so every field is checked, not trusted.
const field = (source: unknown, key: string): unknown =>
  typeof source === "object" && source !== null ? Reflect.get(source, key) : undefined;
const text = (source: unknown, key: string): string | undefined => {
  const value = field(source, key);
  return typeof value === "string" ? value : undefined;
};
const count = (source: unknown, key: string): number | undefined => {
  const value = field(source, key);
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
};
type StackFrame = PageElementContext["stack"][number];
const stackFrame = (frame: unknown): StackFrame => {
  const functionName = text(frame, "functionName");
  const fileName = text(frame, "fileName");
  const lineNumber = count(frame, "lineNumber");
  const columnNumber = count(frame, "columnNumber");
  return {
    ...(functionName === undefined ? {} : { functionName }),
    ...(fileName === undefined ? {} : { fileName }),
    ...(lineNumber === undefined ? {} : { lineNumber }),
    ...(columnNumber === undefined ? {} : { columnNumber }),
  };
};

/** The picked element's React context, read in the page's world, or null without one. */
export async function readPageElementContext(element: Element): Promise<PageElementContext | null> {
  const context: unknown = await pageWorld.elementContext(element);
  if (typeof context !== "object" || context === null) return null;
  const frames = field(context, "stack");
  return {
    selector: text(context, "selector") ?? null,
    htmlPreview: text(context, "htmlPreview"),
    componentName: text(context, "componentName") ?? null,
    styles: text(context, "styles"),
    stack: (Array.isArray(frames) ? frames : []).map(stackFrame),
  };
}
