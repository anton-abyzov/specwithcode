import { ProviderInstanceId } from "@specweave-studio/contracts";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vite-plus/test";
import { ComposerModelIntent } from "./ComposerModelIntent";
import { composerChipModel } from "./composerModelDisplay";
const saved = { instanceId: ProviderInstanceId.make("codex"), model: "gpt-6.1-sol" };
const picked = { instanceId: ProviderInstanceId.make("acpRegistry_copilot"), model: "claude-opus-5.5" };
function render(current = saved, pick = picked, explicit = true, running = false, routed = false) {
  const chip = composerChipModel({ current, pick, pickExplicit: explicit, turnRunning: running });
  return renderToStaticMarkup(<ComposerModelIntent state={chip.state} routed={routed}/>);
}
describe("composer model intent with resolved chip state", () => {
  it("explains the idle resolved pick without changing either identity", () => {
    const before = JSON.stringify({ saved, picked });
    expect(render()).toContain("Composer selection differs from the thread model.");
    expect(JSON.stringify({ saved, picked })).toBe(before);
  });
  it("clears after server adoption", () => { expect(render(picked)).toBe(""); });
  it("does not label a seeded draft", () => { expect(render(saved, picked, false)).toBe(""); });
  it("does not duplicate the running next-model chip", () => {
    expect(render(saved, picked, true, true)).toBe("");
  });
  it("does not label coordinator-routed messages", () => {
    expect(render(saved, picked, true, false, true)).toBe("");
  });
  it("uses the effective current identity and resolved fallback pick", () => {
    expect(render(picked, picked)).toBe("");
    expect(render(saved, saved)).toBe("");
  });
  it("ignores option-only edits like the chip", () => {
    const effort = { ...saved, options: [{ id: "reasoningEffort", value: "high" }] };
    expect(render(saved, effort)).toBe("");
  });
  it("describes an idle switch without promising when saving completes", () => {
    expect(render(saved, { ...saved, model: "gpt-6.2-sol" })).toContain("differs");
    expect(render(saved, saved)).toBe("");
  });
});
