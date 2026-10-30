import { AuthProvidersManageScope } from "@specweave-studio/contracts";
import { readEnvironmentScope, useEnvironmentScope } from "../../state/session";
import {
  isAtomCommandInterrupted,
  squashAtomCommandFailure,
} from "@specweave-studio/client-runtime/state/runtime";
import type {
  AcpRegistryPrepareResult,
  AcpRegistrySearchAgent,
  EnvironmentId,
  ProviderInstanceConfig,
  ProviderInstanceId,
} from "@specweave-studio/contracts";
import { ChevronDownIcon, ExternalLinkIcon, SearchIcon } from "lucide-react";
import { type FormEvent, useEffect, useLayoutEffect, useRef, useState } from "react";

import { serverEnvironment } from "../../state/server";
import { useEnvironmentQuery } from "../../state/query";
import { useAtomCommand } from "../../state/use-atom-command";
import { Alert, AlertDescription } from "../ui/alert";
import { Button } from "../ui/button";
import { Collapsible, CollapsiblePanel, CollapsibleTrigger } from "../ui/collapsible";
import { InputGroup, InputGroupAddon, InputGroupInput } from "../ui/input-group";
import { ScrollArea } from "../ui/scroll-area";
import { Tooltip, TooltipPopup, TooltipTrigger } from "../ui/tooltip";
import {
  isConfiguredAcpRegistryAgent,
  partitionAcpRegistryResults,
} from "./AddProviderInstanceDialog.logic";
import { ProviderDriverKind } from "@specweave-studio/contracts";
import { ProviderInstanceIcon } from "../chat/ProviderInstanceIcon";
import { FEATURED_ACP_AGENT_IDS, FeaturedAcpProviders } from "./FeaturedAcpProviders";

function errorMessage(error: unknown): string {
  return error instanceof Error && error.message.trim()
    ? error.message
    : "The ACP could not be prepared.";
}

interface AcpRegistrySearchStepProps {
  readonly environmentId: EnvironmentId;
  readonly providerInstances: Readonly<Record<string, ProviderInstanceConfig>>;
  readonly onPrepared: (agent: AcpRegistrySearchAgent) => void;
  readonly onManage?: (instanceId: ProviderInstanceId) => void;
  readonly onManualConfiguration: () => void;
  readonly onLocalConfiguration?: () => void;
  readonly onLoadingChange?: (loading: boolean) => void;
  readonly onPreparingChange?: (preparing: boolean) => void;
  /** Offer the Grok Build installer card (while the built-in Grok provider is selected). */
  readonly showGrokInstaller?: boolean;
  /** Whether "More agents" is expanded; uncontrolled when omitted. */
  readonly moreAgentsOpen?: boolean;
  readonly onMoreAgentsOpenChange?: (open: boolean) => void;
}

const ACP_OVERVIEW_URL = "https://agentclientprotocol.com";

function applyAcpRegistryPrepareResult(
  agent: AcpRegistrySearchAgent,
  prepared: AcpRegistryPrepareResult,
): AcpRegistrySearchAgent {
  return {
    ...agent,
    id: prepared.agentId,
    version: prepared.version,
    distribution: prepared.distribution,
  };
}

export function AcpRegistrySearchStep({
  environmentId,
  providerInstances,
  onPrepared,
  onManage,
  onManualConfiguration,
  onLocalConfiguration,
  onLoadingChange,
  onPreparingChange,
  showGrokInstaller = false,
  moreAgentsOpen,
  onMoreAgentsOpenChange,
}: AcpRegistrySearchStepProps) {
  const [query, setQuery] = useState("");
  const [uncontrolledMoreOpen, setUncontrolledMoreOpen] = useState(false);
  const isMoreOpen = moreAgentsOpen ?? uncontrolledMoreOpen;
  const setMoreOpen = (open: boolean) => {
    setUncontrolledMoreOpen(open);
    onMoreAgentsOpenChange?.(open);
  };
  // An empty registry query is the compact compatible catalog. Start there so
  // entering this step is useful before the user knows what to search for.
  const [submittedQuery, setSubmittedQuery] = useState("");
  const canManageProviders = useEnvironmentScope(environmentId, AuthProvidersManageScope);
  const [preparingId, setPreparingId] = useState<string | null>(null);
  const [prepareError, setPrepareError] = useState<string | null>(null);
  const prepareGeneration = useRef(0);
  const preparationActive = useRef(false);
  const searchTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const search = useEnvironmentQuery(
    serverEnvironment.searchAcpRegistry({
      environmentId,
      input: { query: submittedQuery },
    }),
  );
  const prepareAgent = useAtomCommand(serverEnvironment.prepareAcpRegistryAgent, {
    reportFailure: false,
  });

  useEffect(
    () => () => {
      prepareGeneration.current += 1;
      preparationActive.current = false;
      if (searchTimer.current !== null) clearTimeout(searchTimer.current);
      onPreparingChange?.(false);
    },
    [environmentId, onPreparingChange],
  );

  const submitSearch = (nextQuery: string) => {
    if (searchTimer.current !== null) clearTimeout(searchTimer.current);
    const trimmed = nextQuery.trim();
    setQuery(trimmed);
    setPrepareError(null);
    if (trimmed === submittedQuery) {
      search.refresh();
    } else {
      setSubmittedQuery(trimmed);
    }
  };

  const handleSearch = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    submitSearch(query);
  };

  const handlePrepare = async (agent: AcpRegistrySearchAgent) => {
    if (preparationActive.current || !readEnvironmentScope(environmentId, AuthProvidersManageScope))
      return;
    preparationActive.current = true;
    const generation = ++prepareGeneration.current;
    setPrepareError(null);
    setPreparingId(agent.id);
    onPreparingChange?.(true);
    const result = await prepareAgent({ environmentId, input: { agentId: agent.id } });
    if (prepareGeneration.current !== generation) return;
    preparationActive.current = false;
    setPreparingId(null);
    onPreparingChange?.(false);
    if (result._tag === "Success") {
      onPrepared(applyAcpRegistryPrepareResult(agent, result.value));
      return;
    }
    if (!isAtomCommandInterrupted(result)) {
      setPrepareError(errorMessage(squashAtomCommandFailure(result)));
    }
  };

  // Featured cards already cover their agents on the default catalog, and
  // built-in providers are never repeated as registry rows.
  const partitioned = search.data
    ? partitionAcpRegistryResults(
        search.data.agents,
        submittedQuery === "" ? FEATURED_ACP_AGENT_IDS : [],
      )
    : null;
  const results = partitioned?.listed ?? null;
  const builtInMatches = partitioned?.builtInMatches ?? [];
  const isInitialSearch = search.isPending && results === null;
  const isRefreshing = search.isPending && results !== null;
  const resultCount = results?.length ?? 0;

  useLayoutEffect(() => {
    onLoadingChange?.(search.isPending);
    return () => onLoadingChange?.(false);
  }, [onLoadingChange, search.isPending]);

  return (
    <section className="grid grid-cols-1 gap-3" aria-labelledby="acp-registry-search-heading">
      <div className="grid gap-1">
        <h3 className="text-sm font-medium text-foreground" id="acp-registry-search-heading">
          From the ACP Registry
        </h3>
        <p className="text-xs leading-relaxed text-muted-foreground">
          The ACP Registry is the public catalog of coding agents built on the Agent Client
          Protocol, an open standard that lets any app drive any agent. The app installs the agent
          you pick on this machine.{" "}
          <a
            className="text-foreground underline-offset-2 hover:underline"
            href={ACP_OVERVIEW_URL}
            rel="noreferrer"
            target="_blank"
          >
            About ACP
          </a>
        </p>
      </div>

      <FeaturedAcpProviders
        key={environmentId}
        environmentId={environmentId}
        providerInstances={providerInstances}
        canManageProviders={canManageProviders}
        preparingId={preparingId}
        onPrepare={(agent) => void handlePrepare(agent)}
        showGrok={showGrokInstaller}
        {...(onManage ? { onManage } : {})}
      />

      {search.error || prepareError ? (
        <Alert variant="error" role="status" aria-live="polite">
          <AlertDescription>{prepareError ?? search.error}</AlertDescription>
        </Alert>
      ) : null}

      <Collapsible open={isMoreOpen} onOpenChange={setMoreOpen}>
        <CollapsibleTrigger className="group flex w-full items-center gap-3 rounded-lg px-3 py-2.5 text-left ring-1 ring-black/5 outline-none hover:bg-muted focus-visible:ring-2 focus-visible:ring-ring dark:ring-white/5 dark:hover:bg-white/5">
          <span className="min-w-0 flex-1">
            <span className="block text-sm font-medium text-foreground">More agents</span>
            <span className="block truncate text-xs text-muted-foreground">
              Search the full registry, or add an agent by ID or local command
            </span>
          </span>
          <ChevronDownIcon
            aria-hidden
            className="size-4 shrink-0 text-muted-foreground transition-transform group-data-panel-open:rotate-180 motion-reduce:transition-none"
          />
        </CollapsibleTrigger>
        <CollapsiblePanel className="-mx-1 px-1">
          <div className="grid grid-cols-1 gap-3 pt-3">
            <form className="flex flex-wrap items-center gap-2" onSubmit={handleSearch}>
              <InputGroup className="min-w-40 flex-1">
                <InputGroupAddon>
                  <SearchIcon />
                </InputGroupAddon>
                <InputGroupInput
                  aria-label="Search ACP Registry"
                  disabled={preparingId !== null}
                  onChange={(event) => {
                    const nextQuery = event.currentTarget.value;
                    setQuery(nextQuery);
                    setPrepareError(null);
                    if (searchTimer.current !== null) clearTimeout(searchTimer.current);
                    searchTimer.current = setTimeout(() => {
                      searchTimer.current = null;
                      setSubmittedQuery(nextQuery.trim());
                    }, 300);
                  }}
                  placeholder="Search agents…"
                  size="sm"
                  type="search"
                  value={query}
                />
              </InputGroup>
              <Button
                disabled={preparingId !== null}
                onClick={onManualConfiguration}
                size="sm"
                type="button"
                variant="ghost-muted"
              >
                Enter manually
              </Button>
              {onLocalConfiguration ? (
                <Button
                  disabled={preparingId !== null}
                  onClick={onLocalConfiguration}
                  size="sm"
                  type="button"
                  variant="outline"
                >
                  Local ACP command
                </Button>
              ) : null}
            </form>

            <div className="sr-only" role="status">
              {isInitialSearch
                ? "Searching the ACP Registry."
                : isRefreshing
                  ? "Refreshing ACP Registry results."
                  : results
                    ? `${resultCount} compatible ${resultCount === 1 ? "agent" : "agents"} found.`
                    : ""}
            </div>

            {isInitialSearch ? (
              <div className="flex min-h-20 items-center justify-center text-sm text-muted-foreground">
                Searching the registry...
              </div>
            ) : null}

            {results ? (
              results.length === 0 ? (
                <div className="flex min-h-28 flex-col items-center justify-center rounded-2xl border border-dashed px-4 text-center">
                  {builtInMatches.length > 0 ? (
                    <>
                      <p className="text-sm font-medium">
                        {builtInMatches.join(", ")} {builtInMatches.length === 1 ? "is" : "are"}{" "}
                        built in
                      </p>
                      <p className="mt-1 text-xs text-muted-foreground">
                        Choose {builtInMatches.length === 1 ? "it" : "them"} under Built-in
                        providers above.
                      </p>
                    </>
                  ) : (
                    <>
                      <p className="text-sm font-medium">No compatible agents found</p>
                      <p className="mt-1 text-xs text-muted-foreground">Try a broader search.</p>
                    </>
                  )}
                </div>
              ) : (
                <ScrollArea scrollFade className="max-h-64">
                  {/* The overlay scrollbar takes no layout space, so the rows
                reserve its lane explicitly. */}
                  <div className="pr-2.5">
                    {results.map((agent) => {
                      const alreadyAdded = isConfiguredAcpRegistryAgent(
                        providerInstances,
                        agent.id,
                      );
                      const isPreparing = preparingId === agent.id;
                      const progressLabel =
                        agent.distribution === "binary" ? "Downloading" : "Preparing";
                      return (
                        <article className="min-w-0 py-2.5" key={agent.id}>
                          <div className="flex min-w-0 items-center justify-between gap-3">
                            <div className="flex min-w-0 flex-1 items-center gap-3">
                              <ProviderInstanceIcon
                                driverKind={ProviderDriverKind.make("acpRegistry")}
                                displayName={agent.name}
                                acpRegistryAgentId={agent.id}
                                acpRegistryIconUrl={agent.icon ?? undefined}
                                iconClassName="size-6 rounded-md text-muted-foreground"
                              />
                              <div className="min-w-0 flex-1">
                                <div className="flex min-w-0 items-baseline gap-2">
                                  <h4 className="min-w-0 truncate text-sm font-medium text-foreground">
                                    {agent.name}
                                  </h4>
                                </div>
                                {agent.description ? (
                                  <p className="mt-0.5 truncate text-xs text-muted-foreground">
                                    {agent.description}
                                  </p>
                                ) : null}
                              </div>
                            </div>
                            <div className="flex shrink-0 items-center gap-1.5">
                              {agent.website || agent.repository ? (
                                <Tooltip>
                                  <TooltipTrigger
                                    render={
                                      <Button
                                        size="icon-xs"
                                        variant="ghost-muted"
                                        aria-label={`About ${agent.name}`}
                                        render={
                                          <a
                                            href={agent.website || agent.repository || undefined}
                                            target="_blank"
                                            rel="noreferrer"
                                          />
                                        }
                                      >
                                        <ExternalLinkIcon />
                                      </Button>
                                    }
                                  />
                                  <TooltipPopup>About {agent.name}</TooltipPopup>
                                </Tooltip>
                              ) : null}
                              <Button
                                aria-label={`${alreadyAdded ? "Already added" : isPreparing ? progressLabel : "Add"} ${agent.name}`}
                                disabled={
                                  !canManageProviders || alreadyAdded || preparingId !== null
                                }
                                onClick={() => void handlePrepare(agent)}
                                size="xs"
                                variant={isPreparing ? "secondary" : "outline"}
                              >
                                {alreadyAdded ? "Added" : isPreparing ? progressLabel : "Add"}
                              </Button>
                            </div>
                          </div>
                        </article>
                      );
                    })}
                  </div>
                </ScrollArea>
              )
            ) : null}
          </div>
        </CollapsiblePanel>
      </Collapsible>
    </section>
  );
}
