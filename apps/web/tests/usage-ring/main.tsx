import { createRoot } from "react-dom/client";
import { LaptopIcon } from "lucide-react";

import {
  ComposerControl,
  ComposerControlSeparator,
} from "../../src/components/chat/ComposerControl";
import { ModelUsageMarkRing } from "../../src/components/chat/ModelUsage";
import { ModelStateTag, fallbackModelState } from "../../src/components/chat/ModelStateTag";
import { ProviderLogo, type ProviderBrand } from "../../src/components/ProviderLogo";
import { availabilityText, type ModelAvailability } from "../../src/studio/modelAvailability";
import "./fixture.css";

// Every provider mark at the model chip's `icon` fit, where the usage ring wraps it. The mark
// mirrors ProviderModelPicker's trigger (its wrapper and ProviderInstanceIcon's box); the
// ring, the control and the CSS are the app's own.
const params = new URLSearchParams(location.search);
document.documentElement.classList.toggle("dark", params.get("theme") === "dark");

const BRANDS: readonly ProviderBrand[] = [
  "claude",
  "openai",
  "copilot",
  "gemini",
  "grok",
  "cursor",
  "opencode",
  "antigravity",
  "pi",
  "meta",
  "ollama",
  "qwen",
  "kimi",
  "mistral",
  "kiro",
  "goose",
  "cline",
  "auggie",
  "factory",
  "amp",
  "junie",
  "deepseek",
];

const state: ModelAvailability = {
  kind: "room",
  leftPercent: 62,
  tone: "ok",
  binding: { label: "5-hour", name: "5-hour", scope: "account", family: null, resetsAt: null },
  checkedAt: 0,
};
// The state glyph stays beside the mark at the `icon` fit, so the ring must clear it too.
const fallback = fallbackModelState({
  pick: { provider: "Claude Code", model: "Opus 5.5", full: "Claude Code · Opus 5.5" },
  running: { provider: "Codex", model: "GPT-6.1-Sol", full: "Codex · GPT-6.1-Sol" },
  reason: "usage limit",
});
const text = availabilityText(state, { provider: "Claude", nowMs: 0 });

function Mark({ brand }: { readonly brand: ProviderBrand | null }) {
  return (
    <span
      className="relative flex shrink-0 items-center"
      data-chat-provider-model-picker-icon=""
      data-model-chip-part="mark"
    >
      <span className="relative isolate z-30 inline-flex size-4 shrink-0 items-center justify-center overflow-visible">
        {brand ? (
          <ProviderLogo brand={brand} className="size-4" />
        ) : (
          <span className="size-4 text-3xs font-semibold leading-none">LM</span>
        )}
      </span>
      <ModelUsageMarkRing state={state} text={text} />
    </span>
  );
}

function Row({
  brand,
  size,
}: {
  readonly brand: ProviderBrand | null;
  readonly size: "sm" | "xs";
}) {
  return (
    <div
      className="flex items-center gap-1 rounded-xl border bg-card px-3 py-2"
      data-ring-case={`${brand ?? "initials"}-${size}`}
    >
      <ComposerControl size={size} render={<span />} data-machine-pill="">
        <LaptopIcon className={size === "xs" ? "size-3.5" : "size-4"} />
        <span>m1</span>
      </ComposerControl>
      <ComposerControlSeparator size={size} />
      <ComposerControl
        size={size}
        data-chat-provider-model-picker="true"
        data-model-chip=""
        data-model-fit="icon"
      >
        <span className={size === "xs" ? "flex items-center gap-1" : "flex items-center gap-1.5"}>
          <Mark brand={brand} />
          <ModelStateTag state={fallback} className="text-xs" chip />
        </span>
      </ComposerControl>
    </div>
  );
}

createRoot(document.getElementById("root")!).render(
  <main className="grid grid-cols-2 gap-2 bg-background p-3 text-foreground">
    {[...BRANDS, null].flatMap((brand) =>
      (["sm", "xs"] as const).map((size) => (
        <Row key={`${brand}-${size}`} brand={brand} size={size} />
      )),
    )}
  </main>,
);
