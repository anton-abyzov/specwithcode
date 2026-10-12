import {
  ProviderDriverKind,
  type AcpRegistrySearchAgent,
  type EnvironmentId,
  type ProviderInstanceConfig,
} from "@specweave-studio/contracts";

import { serverEnvironment } from "../../state/server";
import { useEnvironmentQuery, type EnvironmentQueryView } from "../../state/query";
import { ProviderInstanceIcon } from "../chat/ProviderInstanceIcon";
import { Button } from "../ui/button";
import { isConfiguredAcpRegistryAgent } from "./AddProviderInstanceDialog.logic";

export const FEATURED_ACP_AGENT_IDS = ["github-copilot-cli", "grok-build"] as const;

interface FeaturedAcpProvidersProps {
  readonly environmentId: EnvironmentId;
  readonly providerInstances: Readonly<Record<string, ProviderInstanceConfig>>;
  readonly canManageProviders: boolean;
  readonly preparingId: string | null;
  readonly onPrepare: (agent: AcpRegistrySearchAgent) => void;
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
  return <FeaturedAcpProviderCards {...props} copilot={copilot} grok={grok} />;
}

/** Presentation is also used by the isolated responsive browser fixture. */
export function FeaturedAcpProviderCards({
  providerInstances,
  canManageProviders,
  preparingId,
  onPrepare,
  copilot,
  grok,
}: Omit<FeaturedAcpProvidersProps, "environmentId"> & {
  readonly copilot: CatalogQuery;
  readonly grok: CatalogQuery;
}) {
  const providers: ReadonlyArray<FeaturedProvider> = [
    {
      id: "github-copilot-cli",
      label: "GitHub Copilot",
      description: "Use the models available to your GitHub account.",
      catalog: copilot,
    },
    {
      id: "grok-build",
      label: "Grok Build",
      description: "Install here, or choose Grok above for an existing CLI.",
      catalog: grok,
    },
  ];
  return (
    <section className="grid gap-2" aria-label="Featured ACP providers">
      <p className="text-xs text-muted-foreground">
        SpecWithCode-managed installs from the official ACP Registry. Sign in after setup.
      </p>
      <div className="grid grid-cols-1 gap-2 sm:grid-cols-2">
        {providers.map(({ id, label, description, catalog }) => {
          // Search is fuzzy; only the exact registry identity is trusted.
          const agent = catalog.data?.agents.find((candidate) => candidate.id === id);
          const added = isConfiguredAcpRegistryAgent(providerInstances, id);
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
                  {catalog.isPending
                    ? "Checking registry…"
                    : catalog.error
                      ? "Registry unavailable"
                      : !agent
                        ? "Unavailable on this environment"
                        : `v${agent.version} · ${agent.distribution}`}
                </p>
                {unavailable ? (
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
    </section>
  );
}
