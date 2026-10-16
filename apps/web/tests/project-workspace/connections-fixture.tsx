import type { NativeConnectionsSnapshot } from "@specweave-studio/contracts";
import { ConnectionMatrix } from "../../src/components/connections/ConnectionMatrix";

type Entry = NativeConnectionsSnapshot["connections"][number];
const entry = (
  name: string,
  provider: Entry["provider"],
  state: Entry["state"],
  scope: Entry["scope"] = "user",
  transport: Entry["transport"] = "stdio",
): Entry => ({
  id: `${name}-${provider}`,
  name,
  provider,
  sourceId: provider === "codex" ? "codex-user" : "claude-user",
  scope,
  transport,
  state,
  shadowed: false,
});

const snapshot: NativeConnectionsSnapshot = {
  observedAt: "2026-10-15T22:40:00Z",
  runtime: "unverified",
  truncated: false,
  sources: [
    { id: "codex-user", provider: "codex", scope: "user", status: "read" },
    { id: "claude-user", provider: "claude", scope: "user", status: "read" },
  ],
  connections: [
    entry("chrome-devtools", "codex", "configured"),
    entry("chrome-devtools", "claude", "configured"),
    entry("claude-in-chrome", "claude", "configured"),
    entry("context7", "codex", "configured", "user", "http"),
    entry("context7", "claude", "disabled", "user", "http"),
    entry(
      "figma-dev-mode-mcp-server-with-a-very-long-name",
      "claude",
      "configured",
      "project",
      "http",
    ),
    entry("playwright", "codex", "invalid"),
    entry("playwright", "claude", "configured", "local"),
    entry("posthog", "codex", "configured", "project", "http"),
    entry("specweave", "codex", "configured"),
    entry("specweave", "claude", "configured"),
  ],
};

export function ConnectionsFixture() {
  return (
    <div style={{ maxWidth: 860, margin: "32px auto", padding: "0 16px" }}>
      <ConnectionMatrix snapshot={snapshot} />
    </div>
  );
}
