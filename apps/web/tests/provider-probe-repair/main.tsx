// Headless fixture: the production Settings > Providers status row for an agent whose
// check failed, in the ways Codex fails on a real machine. Fictional machine and paths;
// no provider probes and no setup terminal (see ../provider-install-step/mocks.tsx).
import {
  EnvironmentId,
  ProviderDriverKind,
  ProviderInstanceId,
  type ProviderInstanceConfig,
  type ServerProvider,
} from "@specweave-studio/contracts";
import { createRoot } from "react-dom/client";

import { ProviderStatusRow } from "~/components/settings/ProviderStatusRow";
import "./fixture.css";

const params = new URLSearchParams(location.search);
document.documentElement.classList.toggle("dark", params.get("theme") === "dark");
document.body.classList.add("bg-background");

const MACHINE = EnvironmentId.make("linux-box");
const codex: ProviderInstanceConfig = { driver: ProviderDriverKind.make("codex"), enabled: true };

const failed = (message: string, patch: Partial<ServerProvider> = {}): ServerProvider => ({
  instanceId: ProviderInstanceId.make("codex"),
  driver: ProviderDriverKind.make("codex"),
  enabled: true,
  installed: true,
  version: null,
  status: "error",
  auth: { status: "unknown" },
  checkedAt: "2026-11-19T16:00:00.000Z",
  models: [],
  slashCommands: [],
  skills: [],
  message,
  ...patch,
});

const CASES = [
  {
    id: "a-exit-only",
    title: "a. Codex exits as it starts; the old server reports only the exit code",
    provider: failed(
      "Codex app-server provider probe failed: Codex App Server process exited with code 1.",
    ),
  },
  {
    id: "b-broken-install",
    title: "b. The same failure with Codex's own reason (this change's server)",
    provider: failed(
      "Codex stopped as it started (exit code 1): Error: Missing optional dependency @openai/codex-linux-x64. Reinstall Codex: npm install -g @openai/codex@latest.",
    ),
  },
  {
    id: "c-expired",
    title: "c. The sign-in expired",
    provider: failed("Codex app-server provider probe failed: token_expired.", {
      lastKnownAuth: { status: "authenticated", type: "chatgpt", email: "dev@example.com" },
    }),
  },
] as const;

function Fixture() {
  return (
    <main className="mx-auto min-h-screen max-w-3xl space-y-6 bg-background p-4 text-foreground sm:p-8">
      <p className="text-xs text-muted-foreground">Isolated UI fixture · no provider probes</p>
      {CASES.map((item) => (
        <section key={item.id} data-case={item.id} aria-label={item.title} className="space-y-2">
          <h2 className="text-sm font-medium">{item.title}</h2>
          <div data-case-row className="space-y-3 rounded-lg border bg-card p-4">
            <ProviderStatusRow
              environmentId={MACHINE}
              environmentLabel="linux-box"
              instanceId={item.provider.instanceId}
              instance={codex}
              provider={item.provider}
              enabled
              readOnly={false}
              name="Codex"
              onTurnOn={() => undefined}
            />
          </div>
        </section>
      ))}
    </main>
  );
}

createRoot(document.getElementById("root")!).render(<Fixture />);
