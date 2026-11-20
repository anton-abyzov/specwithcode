import { ProviderInstanceId } from "@specweave-studio/contracts";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vite-plus/test";
import { ComposerModelIntent } from "./ComposerModelIntent";

const saved = { instanceId: ProviderInstanceId.make("codex"), model: "gpt-6.1-sol" };
const picked = { instanceId: ProviderInstanceId.make("acpRegistry_copilot"), model: "claude-opus-5.5" };

describe("composer model intent", () => {
  it("explains an unsent cross-provider choice without changing either identity", () => {
    const before = JSON.stringify({ saved, picked });
    expect(renderToStaticMarkup(<ComposerModelIntent threadSelection={saved}
      draftSelection={picked} explicit />)).toContain("Next message:");
    expect(JSON.stringify({ saved, picked })).toBe(before);
  });
  it("disappears when the server adopts the pick", () => {
    expect(renderToStaticMarkup(<ComposerModelIntent threadSelection={picked}
      draftSelection={picked} explicit />)).toBe("");
  });
  it("does not describe a stale seed as a pending user choice", () => {
    expect(renderToStaticMarkup(<ComposerModelIntent threadSelection={saved}
      draftSelection={picked} explicit={false} />)).toBe("");
  });
  it("also explains a same-provider model change", () => {
    expect(renderToStaticMarkup(<ComposerModelIntent threadSelection={saved}
      draftSelection={{ ...saved, model: "gpt-6.2-sol" }} explicit />)).toContain("Next message:");
  });
});
