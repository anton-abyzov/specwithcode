import type { ProviderInstanceEntry } from "../../providerInstances";
import type { ServerProviderModel } from "@specweave-studio/contracts";

/** Only report explicit facts. Missing telemetry is not a negative capability. */
export function describeModelFacts(model: ServerProviderModel | undefined): string {
  if (!model) return "";
  const billing =
    model.billing === "api" || model.billing === "paid-router"
      ? "Billed per token"
      : model.billing === "local"
        ? "Local model"
        : model.billing === "subscription"
          ? "Subscription"
          : "Billing unverified";
  return [
    billing,
    model.toolCalls === true ? "Tools" : model.toolCalls === false ? "No tools" : undefined,
    model.reasoning === "optional" || model.reasoning === "mandatory" ? "Thinking" : undefined,
    model.imageInput === true ? "Images" : model.imageInput === false ? "Text only" : undefined,
    model.contextWindow ? `${model.contextWindow.toLocaleString("en-US")} context` : undefined,
  ]
    .filter(Boolean)
    .join(" · ");
}

const HARNESSES: Record<string, { name: string; protocol: string }> = {
  codex: { name: "Codex", protocol: "app-server" },
  claudeAgent: { name: "Claude Code", protocol: "Agent SDK" },
  cursor: { name: "Cursor", protocol: "Cursor SDK" },
  grok: { name: "Grok", protocol: "ACP" },
  acpRegistry: { name: "Configured agent", protocol: "ACP" },
  opencode: { name: "OpenCode", protocol: "HTTP API and event stream" },
  pi: { name: "Pi", protocol: "JSONL RPC and app extension" },
};

export function describeHarness(entry: ProviderInstanceEntry) {
  const harness = HARNESSES[entry.driverKind];
  return {
    name:
      harness?.name === "Configured agent"
        ? entry.displayName
        : (harness?.name ?? entry.displayName),
    protocol: harness?.protocol ?? "Driver adapter",
    // A disabled instance is not probed: installed:false is not evidence that its binary is absent.
    readiness: !entry.enabled
      ? "Disabled. Installation and sign-in are not checked while disabled."
      : !entry.installed
        ? "Runtime unavailable. Open provider setup to check its executable or server."
        : entry.status !== "ready" || !entry.isAvailable
          ? (entry.snapshot.message ?? "Runtime is not ready. Open provider setup.")
          : "Runtime ready. Model access and billing follow this instance's configuration.",
  };
}

/** Runtime identity is independent of the vendor names in the model list. */
export function HarnessDescription({ entry }: { entry: ProviderInstanceEntry }) {
  const description = describeHarness(entry);
  return (
    <details
      className="max-h-36 shrink-0 overflow-y-auto overscroll-contain border-b border-border/70 px-3 py-2 text-xs leading-snug text-muted-foreground"
      data-harness-description={entry.instanceId}
    >
      <summary className="cursor-pointer text-foreground">
        Harness: {description.name}{" "}
        <span className="text-muted-foreground">· {description.protocol}</span>
      </summary>
      <div className="space-y-1 pt-2">
        <p>{description.readiness}</p>
        <p>
          The harness runs tools and keeps the native session. The model below supplies the
          responses; its vendor can differ from the harness.
        </p>
        <p>
          Billing comes from the configured account or model endpoint. A model name or catalog entry
          does not prove subscription access or a free turn.
        </p>
        {entry.driverKind === "opencode" || entry.driverKind === "pi" ? (
          <p>
            Models and capabilities come from this runtime. Local, subscription and API models can
            have different tool, image and billing support.
          </p>
        ) : null}
      </div>
    </details>
  );
}
