import { describe, expect, it } from "vite-plus/test";
import { chatControlAnchor, chatUsesPanelSheet } from "./embeddedProjectLayout";
describe("embedded project chat", () => {
  it("anchors controls to the pane while normal chat retains its native viewport anchor", () => {
    expect(chatControlAnchor("embedded")).toBe("absolute top-0 right-2");
    expect(chatControlAnchor("workspace")).toContain("fixed top-[var(--workspace-controls-top)]");
  });
  it("uses the actual worker width for sheets, preserving normal viewport behavior", () => {
    expect(chatUsesPanelSheet("embedded", 540, false)).toBe(true);
    expect(chatUsesPanelSheet("embedded", 1100, true)).toBe(false);
    expect(chatUsesPanelSheet("workspace", 540, false)).toBe(false);
    expect(chatUsesPanelSheet("workspace", 1100, true)).toBe(true);
  });
});
