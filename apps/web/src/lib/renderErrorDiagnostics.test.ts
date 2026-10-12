import { describe, expect, it } from "vite-plus/test";

import {
  raiseErrorStackTraceLimit,
  recordRenderErrorComponentStack,
  renderErrorComponentStackLines,
} from "./renderErrorDiagnostics";

describe("renderErrorDiagnostics", () => {
  it("raises a short stack trace limit and keeps a longer one", () => {
    const chromeDefault = { stackTraceLimit: 10 };
    raiseErrorStackTraceLimit(chromeDefault);
    expect(chromeDefault.stackTraceLimit).toBe(50);

    const unset: { stackTraceLimit?: number } = {};
    raiseErrorStackTraceLimit(unset);
    expect(unset.stackTraceLimit).toBe(50);

    const longer = { stackTraceLimit: 200 };
    raiseErrorStackTraceLimit(longer);
    expect(longer.stackTraceLimit).toBe(200);
  });

  it("adds the caught component stack to that error's report only", () => {
    const caught = new Error("Minified React error #185");
    const other = new Error("unrelated");

    recordRenderErrorComponentStack(caught, {
      componentStack: "\n    at ChatComposer\n    at ChatView\n",
    });

    expect(renderErrorComponentStackLines(caught)).toEqual([
      "",
      "Component stack:",
      "at ChatComposer\n    at ChatView",
    ]);
    expect(renderErrorComponentStackLines(other)).toEqual([]);
    expect(renderErrorComponentStackLines("string error")).toEqual([]);
  });

  it("ignores empty component stacks", () => {
    const caught = new Error("boom");
    recordRenderErrorComponentStack(caught, { componentStack: "  \n" });
    recordRenderErrorComponentStack(caught, {});
    expect(renderErrorComponentStackLines(caught)).toEqual([]);
  });
});
