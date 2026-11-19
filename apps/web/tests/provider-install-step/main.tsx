// Headless fixture: the production Settings > Providers status row, and through it the
// install step, in each state a newly installed or broken agent passes through.
// Fictional machines, agents and paths; no provider probes and no setup terminal.
import {
  EnvironmentId,
  ProviderDriverKind,
  ProviderInstanceId,
  type ProviderInstanceConfig,
  type ServerProvider,
} from "@specweave-studio/contracts";
import { createRoot } from "react-dom/client";

import { AcpRegistryRepair } from "~/components/settings/AcpRegistryRepair";
import { ProviderStatusRow } from "~/components/settings/ProviderStatusRow";
import "./fixture.css";

const params = new URLSearchParams(location.search);
document.documentElement.classList.toggle("dark", params.get("theme") === "dark");
document.body.classList.add("bg-background");

const MAC = EnvironmentId.make("office-mac");
const PC = EnvironmentId.make("office-pc");
const LABELS: Record<string, string> = { "office-mac": "office-mac", "office-pc": "office-pc" };

const provider = (driver: string, patch: Partial<ServerProvider> = {}): ServerProvider => ({
  instanceId: ProviderInstanceId.make(driver),
  driver: ProviderDriverKind.make(driver),
  enabled: true,
  installed: false,
  version: null,
  status: "error",
  auth: { status: "unknown" },
  checkedAt: "2026-11-16T15:00:00.000Z",
  models: [],
  slashCommands: [],
  skills: [],
  ...patch,
});

interface Case {
  readonly id: string;
  readonly title: string;
  readonly environmentId: EnvironmentId;
  readonly name: string;
  readonly instance: ProviderInstanceConfig;
  readonly provider: ServerProvider;
  readonly readOnly?: boolean;
  readonly registryAgentId?: string;
}

const muse: ProviderInstanceConfig = { driver: ProviderDriverKind.make("muse"), enabled: true };
const museMissing = provider("muse", { cli: { state: "missing", command: "muse" } });

const CASES: ReadonlyArray<Case> = [
  {
    id: "a-waiting",
    title: "a. Not installed, new server (waiting for the install)",
    environmentId: MAC,
    name: "Muse Code",
    instance: muse,
    provider: museMissing,
  },
  {
    id: "b-broken",
    title: "b. Installed, but it does not start",
    environmentId: MAC,
    name: "Muse Code",
    instance: muse,
    provider: provider("muse", {
      cli: { state: "broken", command: "muse", path: "/Users/dev/.local/bin/muse" },
      message:
        "Muse Code could not start: its installed binary is missing. Run the Muse Code installer again.",
    }),
  },
  {
    id: "c-windows",
    title: "c. Not installed on a Windows machine",
    environmentId: PC,
    name: "Claude Code",
    instance: { driver: ProviderDriverKind.make("claudeAgent"), enabled: true },
    provider: provider("claudeAgent", { cli: { state: "missing", command: "claude" } }),
  },
  {
    id: "d-no-command-guide",
    title: "d. No known install command, with an install guide",
    environmentId: MAC,
    name: "Cursor Agent",
    instance: { driver: ProviderDriverKind.make("cursor"), enabled: true },
    provider: provider("cursor", {
      cli: { state: "missing", command: "cursor-agent" },
      setup: {
        canAuthenticate: false,
        canInstall: false,
        documentationUrl: "https://docs.example.com/agent/install",
      },
    }),
  },
  {
    id: "d-no-command",
    title: "d. No known install command, no install guide",
    environmentId: MAC,
    name: "Cursor Agent",
    instance: { driver: ProviderDriverKind.make("cursor"), enabled: true },
    provider: provider("cursor", { cli: { state: "missing", command: "cursor-agent" } }),
  },
  {
    id: "e-registry",
    title: "e. Agent from the ACP registry, not installed",
    environmentId: MAC,
    name: "Gemini CLI",
    instance: {
      driver: ProviderDriverKind.make("acpRegistry"),
      enabled: true,
      config: { source: "registry", agentId: "gemini" },
    },
    registryAgentId: "gemini",
    provider: provider("acpRegistry", {
      instanceId: ProviderInstanceId.make("gemini"),
      cli: { state: "missing", command: "gemini" },
    }),
  },
  {
    id: "f-older-server",
    title: "f. Not installed, older server (no cli field)",
    environmentId: MAC,
    name: "Grok",
    instance: { driver: ProviderDriverKind.make("grok"), enabled: true },
    provider: provider("grok", {
      message: "Grok CLI (`grok`) is not installed or not on PATH.",
    }),
  },
  {
    id: "g-ready",
    title: "g. Case a after the server reports it ready",
    environmentId: MAC,
    name: "Muse Code",
    instance: muse,
    provider: provider("muse", {
      installed: true,
      status: "ready",
      version: "0.9.1",
      auth: { status: "authenticated", email: "dev@example.com", label: "Pro" },
      models: [{ slug: "muse-1", name: "Muse 1", isCustom: false }] as never,
    }),
  },
  {
    id: "h-read-only",
    title: "h. Case a over a read-only connection",
    environmentId: MAC,
    name: "Muse Code",
    instance: muse,
    provider: museMissing,
    readOnly: true,
  },
  {
    id: "i-plan",
    title: "i. Signed in, with its plan",
    environmentId: MAC,
    name: "Muse Code",
    instance: muse,
    provider: provider("muse", {
      installed: true,
      status: "ready",
      version: "0.9.1",
      auth: { status: "authenticated", type: "subscription", label: "Muse Code Max Usage" },
      models: [{ slug: "muse-1", name: "Muse 1", isCustom: false }] as never,
    }),
  },
  {
    id: "k-email",
    title: "k. Signed in with an email, partly masked",
    environmentId: MAC,
    name: "Claude",
    instance: { driver: ProviderDriverKind.make("claudeAgent"), enabled: true },
    provider: provider("claudeAgent", {
      installed: true,
      status: "ready",
      version: "2.1.0",
      auth: {
        status: "authenticated",
        type: "subscription",
        email: "samplecoder@gmail.com",
        label: "Claude Ultra Subscription",
      },
      models: [{ slug: "claude-sonnet-5-5", name: "Sonnet 5.5", isCustom: false }] as never,
    }),
  },
  {
    id: "j-signed-out",
    title: "j. Installed, not signed in",
    environmentId: MAC,
    name: "Muse Code",
    instance: muse,
    provider: provider("muse", {
      installed: true,
      status: "error",
      version: "0.9.1",
      auth: { status: "unauthenticated", type: "subscription" },
      message: "Muse Code is not signed in. Run `muse login` in a terminal on this machine.",
    }),
  },
];

function Fixture() {
  return (
    <main className="mx-auto min-h-screen max-w-3xl space-y-6 bg-background p-4 text-foreground sm:p-8">
      <p className="text-xs text-muted-foreground">Isolated UI fixture · no provider probes</p>
      {CASES.map((item) => (
        <section key={item.id} data-case={item.id} aria-label={item.title} className="space-y-2">
          <h2 className="text-sm font-medium">{item.title}</h2>
          <div data-case-row className="space-y-3 rounded-lg border bg-card p-4">
            <ProviderStatusRow
              environmentId={item.environmentId}
              environmentLabel={LABELS[item.environmentId] ?? item.environmentId}
              instanceId={item.provider.instanceId}
              instance={item.instance}
              provider={item.provider}
              enabled
              readOnly={item.readOnly === true}
              name={item.name}
              registryAgentId={item.registryAgentId}
              onTurnOn={() => undefined}
            />
            {item.registryAgentId ? (
              // The card under a registry agent's row keeps its own install block.
              <AcpRegistryRepair
                environmentId={item.environmentId}
                instanceId={item.provider.instanceId}
                instance={item.instance}
                readOnly={item.readOnly === true}
              />
            ) : null}
          </div>
        </section>
      ))}
    </main>
  );
}

createRoot(document.getElementById("root")!).render(<Fixture />);
