// @vitest-environment jsdom

import { act, Component, type ReactNode } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vite-plus/test";

import {
  recordRenderErrorComponentStack,
  useRenderErrorComponentStackLines,
} from "./renderErrorDiagnostics";

class Boundary extends Component<{ children: ReactNode }, { error: unknown }> {
  override state = { error: null as unknown };
  static getDerivedStateFromError(error: unknown) {
    return { error };
  }
  override render() {
    return this.state.error ? <Report error={this.state.error} /> : this.props.children;
  }
}

function Report({ error }: { error: unknown }) {
  return <pre>{useRenderErrorComponentStackLines(error).join("\n")}</pre>;
}

function LoopingComposer(): ReactNode {
  throw new Error("Minified React error #185");
}

let root: Root;
let container: HTMLDivElement;

beforeEach(() => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container, { onCaughtError: recordRenderErrorComponentStack });
});

afterEach(async () => {
  await act(async () => root.unmount());
  container.remove();
  vi.unstubAllGlobals();
});

describe("useRenderErrorComponentStackLines", () => {
  it("shows the component stack React reports after the fallback renders", async () => {
    await act(async () => {
      root.render(
        <Boundary>
          <LoopingComposer />
        </Boundary>,
      );
    });

    const report = container.textContent ?? "";
    expect(report).toContain("Component stack:");
    expect(report).toContain("LoopingComposer");
  });
});
