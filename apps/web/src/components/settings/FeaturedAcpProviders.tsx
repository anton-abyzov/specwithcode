import {
  ProviderDriverKind,
  type AcpRegistrySearchAgent,
  type EnvironmentId,
  type ProviderInstanceConfig,
  ProviderInstanceId,
} from "@specweave-studio/contracts";

import { serverEnvironment } from "../../state/server";
import { useEnvironmentQuery, type EnvironmentQueryView } from "../../state/query";
import { ProviderInstanceIcon } from "../chat/ProviderInstanceIcon";
import { cn } from "../../lib/utils";
import { Button } from "../ui/button";
import { isConfiguredAcpRegistryAgent } from "./AddProviderInstanceDialog.logic";

import { FEATURED_ACP_AGENT_IDS } from "../../providerQuickSetup";

export { FEATURED_ACP_AGENT_IDS };

interface FeaturedAcpProvidersProps {
  readonly environmentId: EnvironmentId;
  readonly providerInstances: Readonly<Record<string, ProviderInstanceConfig>>;
  readonly canManageProviders: boolean;
  readonly preparingId: string | null;
  readonly onPrepare: (agent: AcpRegistrySearchAgent) => void;
  readonly onManage?: (instanceId: ProviderInstanceId) => void;
  /**
   * Show the Grok Build installer card. The add dialog offers it only while
   * the built-in Grok provider is selected, so Grok is not listed twice.
   */
  readonly showGrok?: boolean;
}

type CatalogQuery = Pick<
  EnvironmentQueryView<{ readonly agents: ReadonlyArray<AcpRegistrySearchAgent> }>,
  "data" | "error" | "isPending" | "refresh"
>;

interface FeaturedProvider {
  readonly id: (typeof FEATURED_ACP_AGENT_IDS)[number];
  readonly label: string;
  readonly description: string;
  readonly catalog: CatalogQuery;
}

/** Separate queries avoid the registry's bounded search results hiding a featured agent. */
export function FeaturedAcpProviders(props: FeaturedAcpProvidersProps) {
  const copilot = useEnvironmentQuery(
    serverEnvironment.searchAcpRegistry({
      environmentId: props.environmentId,
      input: { query: "github-copilot-cli" },
    }),
  );
  const grok = useEnvironmentQuery(
    serverEnvironment.searchAcpRegistry({
      environmentId: props.environmentId,
      input: { query: "grok-build" },
    }),
  );
  const gemini = useEnvironmentQuery(
    serverEnvironment.searchAcpRegistry({
      environmentId: props.environmentId,
      input: { query: "gemini" },
    }),
  );
  return <FeaturedAcpProviderCards {...props} copilot={copilot} grok={grok} gemini={gemini} />;
}

/** Presentation is also used by the isolated responsive browser fixture. */
export function FeaturedAcpProviderCards({
  providerInstances,
  canManageProviders,
  preparingId,
  onPrepare,
  onManage,
  showGrok = true,
  copilot,
  grok,
  gemini,
}: Omit<FeaturedAcpProvidersProps, "environmentId"> & {
  readonly copilot: CatalogQuery;
  readonly grok: CatalogQuery;
  readonly gemini: CatalogQuery;
}) {
  const allProviders: ReadonlyArray<FeaturedProvider> = [
    {
      id: "github-copilot-cli",
      label: "GitHub Copilot",
      description: "Use the models available to your GitHub account.",
      catalog: copilot,
    },
    {
      id: "grok-build",
      label: "Grok Build",
      description: "No grok CLI on this machine? Install Grok as a registry agent instead.",
      catalog: grok,
    },
    {
      id: "gemini",
      label: "Gemini CLI",
      description: "Connect with the sign-in options offered by Gemini CLI.",
      catalog: gemini,
    },
  ];
  const providers = showGrok
    ? allProviders
    : allProviders.filter((provider) => provider.id !== "grok-build");
  return (
    <section className="grid gap-2" aria-label="Featured ACP providers">
      <div
        className={cn(
          "grid grid-cols-1 gap-2",
          providers.length === 3 ? "sm:grid-cols-3" : "sm:grid-cols-2",
        )}
      >
        {providers.map(({ id, label, description, catalog }) => {
          // Search is fuzzy; only the exact registry identity is trusted.
          const agent = catalog.data?.agents.find((candidate) => candidate.id === id);
          const added = isConfiguredAcpRegistryAgent(providerInstances, id);
          const configuredId = Object.entries(providerInstances).find(([instanceId, instance]) =>
            isConfiguredAcpRegistryAgent({ [instanceId]: instance }, id),
          )?.[0];
          const preparing = preparingId === id;
          const unavailable = !catalog.isPending && (catalog.error !== null || !agent);
          const blocked =
            !canManageProviders ||
            preparingId !== null ||
            added ||
            catalog.isPending ||
            unavailable;
          return (
            <article key={id} className="grid min-w-0 gap-3 rounded-lg border border-border/70 p-3">
              <div className="flex min-w-0 items-start gap-2.5">
                <ProviderInstanceIcon
                  driverKind={ProviderDriverKind.make("acpRegistry")}
                  displayName={label}
                  acpRegistryAgentId={id}
                  acpRegistryIconUrl={agent?.icon ?? undefined}
                  iconClassName="mt-0.5 size-5 shrink-0 text-muted-foreground"
                />
                <div className="min-w-0">
                  <h4 className="text-sm font-medium text-foreground">{label}</h4>
                  <p className="mt-1 text-xs leading-relaxed text-muted-foreground">
                    {description}
                  </p>
                </div>
              </div>
              <div className="flex flex-wrap items-center justify-between gap-2">
                <p className="min-w-0 text-xs text-muted-foreground" role="status">
                  {added
                    ? "Added · check setup"
                    : catalog.isPending
                      ? "Checking registry…"
                      : catalog.error
                        ? "Registry unavailable"
                        : !agent
                          ? "Unavailable on this environment"
                          : `v${agent.version} · ${agent.distribution}`}
                </p>
                {added && onManage && configuredId ? (
                  <Button
                    aria-label={`Manage ${label}`}
                    disabled={preparingId !== null}
                    onClick={() => {
                      if (preparingId === null) onManage(ProviderInstanceId.make(configuredId));
                    }}
                    size="xs"
                    variant="outline"
                  >
                    Manage
                  </Button>
                ) : unavailable && !added ? (
                  <Button
                    aria-label={`Retry ${label} registry lookup`}
                    disabled={preparingId !== null}
                    onClick={catalog.refresh}
                    size="xs"
                    variant="ghost-muted"
                  >
                    Retry
                  </Button>
                ) : (
                  <Button
                    aria-label={`${added ? "Already added" : preparing ? "Preparing" : "Add"} ${label}`}
                    disabled={blocked || !agent}
                    onClick={() => {
                      if (!blocked && agent) onPrepare(agent);
                    }}
                    size="xs"
                    variant="outline"
                  >
                    {added ? "Added" : preparing ? "Preparing…" : "Add"}
                  </Button>
                )}
              </div>
            </article>
          );
        })}
      </div>
      <p className="text-xs leading-relaxed text-muted-foreground">
        Add an agent, complete its sign-in, then choose its models in chat. Registry agents work in
        the project folder; projects with additional approved folders currently require Codex,
        Claude or Muse Code.
      </p>
    </section>
  );
}
