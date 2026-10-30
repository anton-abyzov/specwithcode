import { aggregateProjectAttention } from "@specweave-studio/client-runtime/state/projectAttention";
import { projectAttentionRoots, useAttentionMembers } from "../../studio/useProjectAttention";
import { useSettingsProjectGroups } from "../settings/useSettingsProjectGroups";
import { useNowMinute } from "../../hooks/useNowMinute";
import {
  archivedMemberKeys,
  automatedMemberKeys,
  partitionProjectGroups,
  projectPickerMembers,
  type ScratchRootLookup,
} from "../../studio/projectListVisibility";
import { scopeProjectRef } from "@specweave-studio/client-runtime/environment";
import type { ModelSelection, ServerProvider } from "@specweave-studio/contracts";
import { AuthOrchestrationOperateScope, PROVIDER_DISPLAY_NAMES } from "@specweave-studio/contracts";
import { Link } from "@tanstack/react-router";
import {
  ArrowRightIcon,
  CheckIcon,
  ChevronLeftIcon,
  ChevronRightIcon,
  CircleIcon,
  LayersIcon,
  LinkIcon,
  PlusIcon,
  SearchIcon,
} from "lucide-react";
import { useCallback, useEffect, useMemo, useState, type ReactNode } from "react";
import { APP_DISPLAY_NAME } from "../../branding";
import { useComposerDraftStore } from "../../composerDraftStore";
import { isElectron } from "../../env";
import { useNewChatDestination } from "../../hooks/useNewChatDestination";
import type { SidebarProjectSnapshot } from "../../sidebarProjectGrouping";
import { chatNavigationTarget } from "../../studio/projectPaneThreads";
import {
  useAllEnvironmentShellsBootstrapped,
  useProjects,
  useServerConfigs,
  useThreadShells,
} from "../../state/entities";
import { useEnvironments } from "../../state/environments";
import { useEnvironmentsWithScope } from "../../state/session";
import {
  attentionLabel,
  deriveSessions,
  relativeTime,
  sessionStateSince,
  resolveNativeModel,
  type SessionView,
} from "../../studio/overviewModel";
import { ProjectFavicon, type ProjectFaviconProject } from "../ProjectFavicon";
import { WorkspacePageHeader } from "../WorkspacePageHeader";
import { Select, SelectItem, SelectPopup, SelectTrigger, SelectValue } from "../ui/select";
import { SidebarInset } from "../ui/sidebar";
import { CapacityFleet } from "./CapacityFleet";
import type { ProviderInstanceEntry } from "../../providerInstances";
import { ThreadModelBadge, useProviderEntriesByEnvironment } from "./shell/ModelBadge";
import { PlanProgressChip } from "./PlanProgressChip";
import { compactThreadPlan } from "../../studio/threadPlanProgress";
import { useThreadIncrementProgress } from "../../studio/useThreadIncrementProgress";
import "./overview.css";

type DraftRequest = {
  readonly environmentId?: string;
  readonly model?: ModelSelection;
  readonly validate?: () => boolean;
};

type SessionFilter = "all" | "attention" | "working" | "ready" | "resolved";

const ATTENTION_PAGE = 3;
const SESSION_PAGE = 8;
const PROJECT_PAGE = 6;

const SESSION_FILTERS: ReadonlyArray<{ value: SessionFilter; label: string }> = [
  { value: "all", label: "All" },
  { value: "attention", label: "Needs you" },
  { value: "working", label: "Working" },
  { value: "ready", label: "Ready" },
  { value: "resolved", label: "Resolved" },
];

function matchesFilter(session: SessionView, filter: SessionFilter): boolean {
  switch (filter) {
    case "all":
      return true;
    case "attention":
      return session.attention !== null;
    case "working":
      return session.working;
    case "resolved":
      return session.settled && session.attention === null && !session.working;
    case "ready":
      return !session.settled && session.attention === null && !session.working;
  }
}

function providerLabel(providers: readonly ServerProvider[], instanceId: string | null): string {
  if (!instanceId) return "Provider unknown";
  const provider = providers.find((candidate) => candidate.instanceId === instanceId);
  return (
    provider?.displayName ??
    (provider ? PROVIDER_DISPLAY_NAMES[provider.driver] : undefined) ??
    (PROVIDER_DISPLAY_NAMES as Record<string, string | undefined>)[instanceId] ??
    instanceId
  );
}

function attentionTone(session: SessionView): "amber" | "red" {
  return session.attention === "failed" ? "red" : "amber";
}

export function StudioOverview() {
  const projectGroups = useSettingsProjectGroups();
  // A project's thread opens in that project's right panel, as from the sidebar.
  const chatTarget = useMemo(() => {
    const groupByMember = new Map<string, (typeof projectGroups)[number]>();
    for (const group of projectGroups)
      for (const member of group.memberProjects)
        groupByMember.set(`${member.environmentId}:${member.id}`, group);
    return (thread: SessionView["thread"]) =>
      chatNavigationTarget(
        thread,
        groupByMember.get(`${thread.environmentId}:${thread.projectId}`),
      );
  }, [projectGroups]);
  const projects = useProjects();
  const attentionMembers = useAttentionMembers(projects);
  const currentIds = useMemo(
    () =>
      new Set(
        attentionMembers
          .filter((member) => member.freshness === "live")
          .map((member) => member.environmentId),
      ),
    [attentionMembers],
  );
  const allShells = useThreadShells();
  const attentionComplete = useMemo(
    () =>
      aggregateProjectAttention({
        members: attentionMembers,
        roots: projectAttentionRoots(allShells, attentionMembers),
        threads: allShells,
      }).complete,
    [attentionMembers, allShells],
  );
  const configs = useServerConfigs();
  const scratchRootFor = useCallback<ScratchRootLookup>(
    (environmentId) => configs.get(environmentId)?.scratchWorkspaceRoot ?? null,
    [configs],
  );
  // Projects in use: no machine's "No project" folder, nothing archived and no check's project.
  const listedGroups = useMemo(
    () => partitionProjectGroups(projectGroups, scratchRootFor).listed,
    [projectGroups, scratchRootFor],
  );
  // Threads of archived and automated projects stay out of Overview, as the projects
  // stay out of its cards, so its counts match the projects it shows.
  const shells = useMemo(() => {
    const hidden = new Set([
      ...archivedMemberKeys(projectGroups, scratchRootFor),
      ...automatedMemberKeys(projectGroups, scratchRootFor),
    ]);
    return hidden.size === 0
      ? allShells
      : allShells.filter((thread) => !hidden.has(`${thread.environmentId}:${thread.projectId}`));
  }, [allShells, projectGroups, scratchRootFor]);
  const bootstrapped = useAllEnvironmentShellsBootstrapped();
  const { environments, isReady, networkStatus } = useEnvironments();
  const canOperate = useEnvironmentsWithScope(environments, AuthOrchestrationOperateScope);
  const openDestination = useNewChatDestination();
  const [request, setRequest] = useState<DraftRequest | null>(null);
  const [selectedProject, setSelectedProject] = useState("");
  const [starting, setStarting] = useState(false);
  const [startError, setStartError] = useState<string | null>(null);
  const [filter, setFilter] = useState<SessionFilter>("all");
  const [sessionPage, setSessionPage] = useState(0);
  const [attentionPage, setAttentionPage] = useState(0);
  const [projectPage, setProjectPage] = useState(0);
  const [projectQuery, setProjectQuery] = useState("");
  const [now, setNow] = useState(Date.now);
  useEffect(() => {
    // Display age advances locally; this clock never refreshes a provider or session.
    const timer = setInterval(() => setNow(Date.now()), 30_000);
    return () => clearInterval(timer);
  }, []);
  const connectedIds = useMemo(
    () =>
      new Set(
        environments
          .filter((environment) => environment.connection.phase === "connected")
          .map((environment) => environment.environmentId),
      ),
    [environments],
  );
  // Stalls come from time passing, so the list refreshes each minute.
  const nowMinute = useNowMinute();
  const sessions = useMemo(
    () => deriveSessions(shells, projects, currentIds, Date.parse(`${nowMinute}:00Z`)),
    [shells, projects, currentIds, nowMinute],
  );
  const attention = sessions.filter((s) => s.attention !== null);
  const working = sessions.filter((s) => s.working).length;
  const connected = connectedIds.size;
  const hostNames = new Map(environments.map((e) => [e.environmentId, e.label]));
  const draftProjects = projectPickerMembers(
    projects,
    (environmentId) => configs.get(environmentId)?.scratchWorkspaceRoot ?? null,
  ).filter(
    (p) =>
      canOperate.has(p.environmentId) &&
      connectedIds.has(p.environmentId) &&
      (!request?.environmentId || request.environmentId === p.environmentId),
  );
  // A project can leave the list after it was picked; only one still listed counts as chosen.
  const chosenProject =
    draftProjects.find((p) => `${p.environmentId}:${p.id}` === selectedProject) ?? null;
  const filterCounts = useMemo(
    () =>
      Object.fromEntries(
        SESSION_FILTERS.map(({ value }) => [
          value,
          sessions.filter((s) => matchesFilter(s, value)).length,
        ]),
      ) as Record<SessionFilter, number>,
    [sessions],
  );
  const filteredSessions = sessions.filter((s) => matchesFilter(s, filter));
  const sessionPages = Math.max(1, Math.ceil(filteredSessions.length / SESSION_PAGE));
  const currentSessionPage = Math.min(sessionPage, sessionPages - 1);
  const attentionPages = Math.max(1, Math.ceil(attention.length / ATTENTION_PAGE));
  const currentAttentionPage = Math.min(attentionPage, attentionPages - 1);
  const projectCards = useMemo(
    () =>
      summarizeProjects(listedGroups, sessions).map((card) => ({
        ...card,
        complete:
          attentionComplete &&
          card.group.memberProjectRefs.every((ref) =>
            attentionMembers.some(
              (member) =>
                member.environmentId === ref.environmentId &&
                member.projectId === ref.projectId &&
                member.freshness === "live" &&
                member.remoteWorkersComplete !== false,
            ),
          ),
      })),
    [listedGroups, sessions, attentionMembers, attentionComplete],
  );
  const query = projectQuery.trim().toLowerCase();
  const filteredProjects = query
    ? projectCards.filter((card) => card.group.displayName.toLowerCase().includes(query))
    : projectCards;
  const projectPages = Math.max(1, Math.ceil(filteredProjects.length / PROJECT_PAGE));
  const currentProjectPage = Math.min(projectPage, projectPages - 1);
  const providerEntries = useProviderEntriesByEnvironment();
  const providersFor = (environmentId: SessionView["thread"]["environmentId"]) =>
    configs.get(environmentId)?.providers ?? [];

  const openDraftChooser = (next: DraftRequest = {}) => {
    setRequest(next);
    setSelectedProject("");
    setStartError(null);
  };
  const showSessions = (next: SessionFilter) => {
    setFilter(next);
    setSessionPage(0);
    document.getElementById("studio-sessions-title")?.scrollIntoView({ block: "start" });
  };
  const startDraft = async () => {
    const project = chosenProject;
    if (!project || starting) return;
    // Creating a draft is deliberate. The composer and server retain native approval/start controls.
    setStarting(true);
    setStartError(null);
    try {
      if (request?.validate && !request.validate()) {
        throw new Error("capacity-policy-no-longer-eligible");
      }
      if (
        request?.model &&
        resolveNativeModel(
          configs.get(project.environmentId)?.providers ?? [],
          request.model.instanceId,
        ) === null
      ) {
        throw new Error("native-instance-unavailable");
      }
      // A workers-only copy's request opens its coordinator on another machine. The handoff
      // redirects it, names this copy and leaves out this machine's model; a draft stays here.
      const result = await openDestination(scopeProjectRef(project.environmentId, project.id), {
        environmentSelection: "manual",
        model: request?.model,
      });
      if (result.kind === "unavailable") throw new Error("destination-unavailable");
      if (result.kind === "draft" && request?.model) {
        useComposerDraftStore
          .getState()
          .setModelSelection(result.draftId, request.model, { explicit: true });
      }
      setRequest(null);
    } catch {
      setStartError(
        request?.validate
          ? "This capacity choice is no longer available. Refresh observations or check the host connection and permissions, then choose again."
          : "The draft could not be opened. Reconnect the host or check the project, then try again.",
      );
    } finally {
      setStarting(false);
    }
  };

  const summary = !bootstrapped
    ? "Reading session state from connected hosts…"
    : !attentionComplete
      ? `${attention.length} sessions with known actions. Partial observations; some hosts are not current.`
      : attention.length > 0
        ? `${attention.length} ${attention.length === 1 ? "session needs" : "sessions need"} your decision. ${working} working across ${listedGroups.length} projects.`
        : working > 0
          ? `Nothing needs you. ${working} ${working === 1 ? "session is" : "sessions are"} working.`
          : "Nothing needs you right now. Start a session or pick up where you left off.";

  return (
    <SidebarInset className="studio-desk h-dvh min-h-0 overflow-hidden overscroll-y-none">
      <WorkspacePageHeader electron={isElectron} className="studio-topbar">
        <span className="studio-topbar-title">Overview</span>
        <span className="studio-private-label">
          <CircleIcon aria-hidden="true" /> Private workspace
        </span>
        <Link to="/settings/connections" className="studio-text-link no-drag">
          Connections <ArrowRightIcon aria-hidden="true" />
        </Link>
      </WorkspacePageHeader>
      <main className="studio-scroll" aria-labelledby="studio-heading">
        <div className="studio-content">
          <header className="studio-masthead">
            <div className="studio-masthead-copy">
              <p className="studio-eyebrow">{APP_DISPLAY_NAME}</p>
              <h1 id="studio-heading">Control desk</h1>
              <p className="studio-intro" aria-live="polite">
                {summary}
              </p>
            </div>
            <div className="studio-masthead-actions">
              <Link to="/settings/projects" className="studio-secondary">
                Manage projects
              </Link>
              <button className="studio-primary" onClick={() => openDraftChooser()}>
                <PlusIcon aria-hidden="true" /> New session
              </button>
            </div>
          </header>

          {networkStatus === "offline" && (
            <p className="studio-notice" role="status">
              This device is offline. Saved session state may be incomplete; reconnect before
              starting work.
            </p>
          )}
          <div className="studio-stat-strip" aria-label="Observed workspace status">
            <Stat
              value={bootstrapped ? String(attention.length) : "—"}
              label="Sessions needing action"
              hint={
                !attentionComplete
                  ? "Partial observations"
                  : attention.length > 0
                    ? "Review now"
                    : "All clear"
              }
              tone={attention.length > 0 ? "amber" : "plain"}
              onClick={() => showSessions("attention")}
            />
            <Stat
              value={bootstrapped ? String(working) : "—"}
              label="Sessions working"
              hint={`${sessions.length} sessions in total`}
              tone={working > 0 ? "moss" : "plain"}
              onClick={() => showSessions("working")}
            />
            <Stat
              value={bootstrapped ? String(listedGroups.length) : "—"}
              label="Registered projects"
              hint="Browse projects"
              onClick={() =>
                document.getElementById("studio-projects-title")?.scrollIntoView({ block: "start" })
              }
            />
            <Stat
              value={isReady ? `${connected}/${environments.length}` : "—"}
              label="Hosts connected"
              hint={connected < environments.length ? "Some hosts are offline" : "Manage hosts"}
              tone={isReady && connected < environments.length ? "amber" : "plain"}
              href="/settings/connections"
            />
          </div>

          {request !== null && (
            <section className="studio-draft-chooser" aria-labelledby="studio-draft-title">
              <div>
                <p className="studio-eyebrow">Start deliberately</p>
                <h2 id="studio-draft-title">Choose a project</h2>
                <p className="studio-small">
                  {request.model
                    ? `Native instance: ${request.model.instanceId} · ${request.model.model}`
                    : "The project’s native provider and permission settings apply."}
                </p>
              </div>
              {draftProjects.length === 0 ? (
                <p className="studio-notice">
                  No connected project is available with this connection’s operating permission.{" "}
                  <Link to="/settings/projects">Open Projects</Link> or{" "}
                  <Link to="/settings/connections">Connections</Link>.
                </p>
              ) : (
                <div className="studio-draft-fields">
                  <label htmlFor="studio-project">Project and host</label>
                  <Select
                    value={chosenProject ? selectedProject : ""}
                    onValueChange={(value) => setSelectedProject(value ?? "")}
                  >
                    <SelectTrigger id="studio-project" className="studio-project-pick" autoFocus>
                      <SelectValue>
                        {() =>
                          chosenProject ? (
                            <ProjectChoice
                              project={chosenProject}
                              host={hostNames.get(chosenProject.environmentId) ?? "Host"}
                            />
                          ) : (
                            <span className="studio-project-none">
                              Choose a registered project…
                            </span>
                          )
                        }
                      </SelectValue>
                    </SelectTrigger>
                    <SelectPopup
                      align="start"
                      alignItemWithTrigger={false}
                      className="max-w-(--available-width)"
                    >
                      {draftProjects.map((p) => (
                        <SelectItem
                          key={`${p.environmentId}:${p.id}`}
                          value={`${p.environmentId}:${p.id}`}
                          // Typing a name finds the project; the icon's letters are not part of it.
                          label={`${p.title} / ${hostNames.get(p.environmentId) ?? "Host"}`}
                        >
                          <ProjectChoice
                            project={p}
                            host={hostNames.get(p.environmentId) ?? "Host"}
                          />
                        </SelectItem>
                      ))}
                    </SelectPopup>
                  </Select>
                  <button
                    className="studio-primary"
                    disabled={!chosenProject || starting}
                    onClick={() => void startDraft()}
                  >
                    {starting ? "Opening…" : "Open native draft"}
                    <ArrowRightIcon aria-hidden="true" />
                  </button>
                </div>
              )}
              {startError && (
                <p role="alert" className="studio-notice">
                  {startError}
                </p>
              )}
              <button
                className="studio-text-link"
                onClick={() => setRequest(null)}
                disabled={starting}
              >
                Cancel
              </button>
            </section>
          )}

          <div className="studio-work-grid">
            <section
              className="studio-panel studio-attention"
              aria-labelledby="studio-attention-title"
            >
              <SectionHeading
                title="Needs you"
                id="studio-attention-title"
                count={bootstrapped ? attention.length : undefined}
                tone={attention.length > 0 ? "amber" : "plain"}
              />
              {!bootstrapped ? (
                <EmptyState
                  title="Reading session state…"
                  detail="Each connected host reports its native sessions."
                />
              ) : attention.length === 0 ? (
                <div className="studio-clear">
                  <CheckIcon aria-hidden="true" />
                  <div>
                    <h3>A clear desk.</h3>
                    <p>
                      No approvals, questions or plans reported by connected hosts need a decision.
                    </p>
                    {connected < environments.length && (
                      <p>Disconnected hosts have not reported current attention.</p>
                    )}
                  </div>
                </div>
              ) : (
                <>
                  <div className="studio-attention-list">
                    {attention
                      .slice(
                        currentAttentionPage * ATTENTION_PAGE,
                        (currentAttentionPage + 1) * ATTENTION_PAGE,
                      )
                      .map((s) => (
                        <AttentionItem
                          key={`${s.thread.environmentId}:${s.thread.id}`}
                          session={s}
                          target={chatTarget(s.thread)}
                          host={hostNames.get(s.thread.environmentId) ?? "Host"}
                          now={now}
                        />
                      ))}
                  </div>
                  <Pager
                    label="Attention pages"
                    page={currentAttentionPage}
                    pageSize={ATTENTION_PAGE}
                    total={attention.length}
                    onChange={setAttentionPage}
                  />
                </>
              )}
            </section>

            <section className="studio-panel" aria-labelledby="studio-sessions-title">
              <SectionHeading title="Sessions" id="studio-sessions-title" count={sessions.length} />
              <div className="studio-filter-row" role="tablist" aria-label="Filter sessions">
                {SESSION_FILTERS.map((option) => (
                  <button
                    key={option.value}
                    role="tab"
                    aria-selected={filter === option.value}
                    className={`studio-filter${filter === option.value ? " selected" : ""}${option.value === "attention" && filterCounts.attention > 0 ? " amber" : ""}`}
                    onClick={() => {
                      setFilter(option.value);
                      setSessionPage(0);
                    }}
                  >
                    {option.label}
                    <span>{filterCounts[option.value]}</span>
                  </button>
                ))}
              </div>
              {filteredSessions.length === 0 ? (
                <EmptyState
                  title={
                    !bootstrapped
                      ? "Reading sessions…"
                      : sessions.length === 0
                        ? "The next session starts here."
                        : "No sessions match this filter."
                  }
                  detail={
                    !bootstrapped
                      ? "Saved hosts and session shells are synchronizing."
                      : sessions.length === 0
                        ? "Choose New session above. Native plans, approvals and checkpoints stay with the conversation."
                        : "Choose another filter to see the rest."
                  }
                />
              ) : (
                <div className="studio-session-list">
                  {filteredSessions
                    .slice(
                      currentSessionPage * SESSION_PAGE,
                      (currentSessionPage + 1) * SESSION_PAGE,
                    )
                    .map((s) => (
                      <SessionItem
                        key={`${s.thread.environmentId}:${s.thread.id}`}
                        session={s}
                        target={chatTarget(s.thread)}
                        host={hostNames.get(s.thread.environmentId) ?? "Host"}
                        provider={providerLabel(
                          providersFor(s.thread.environmentId),
                          s.thread.providerInstanceId,
                        )}
                        entries={providerEntries.get(s.thread.environmentId) ?? new Map()}
                        now={now}
                      />
                    ))}
                </div>
              )}
              <Pager
                label="Session pages"
                page={currentSessionPage}
                pageSize={SESSION_PAGE}
                total={filteredSessions.length}
                onChange={setSessionPage}
              />
            </section>
          </div>

          <section className="studio-project-section" aria-labelledby="studio-projects-title">
            <SectionHeading
              title="Projects"
              id="studio-projects-title"
              count={projectCards.length}
              action={
                projectCards.length > PROJECT_PAGE ? (
                  <label className="studio-search">
                    <SearchIcon aria-hidden="true" />
                    <input
                      type="search"
                      placeholder="Filter projects"
                      aria-label="Filter projects"
                      value={projectQuery}
                      onChange={(event) => {
                        setProjectQuery(event.target.value);
                        setProjectPage(0);
                      }}
                    />
                  </label>
                ) : (
                  <Link to="/settings/projects" className="studio-text-link">
                    Add project <ArrowRightIcon aria-hidden="true" />
                  </Link>
                )
              }
            />
            {projectCards.length === 0 ? (
              <EmptyState
                title="Add your first project."
                detail="Register a folder on a connected host to start sessions in it."
              />
            ) : filteredProjects.length === 0 ? (
              <EmptyState title="No projects match." detail="Try a shorter name." />
            ) : (
              <div className="studio-project-grid">
                {filteredProjects
                  .slice(currentProjectPage * PROJECT_PAGE, (currentProjectPage + 1) * PROJECT_PAGE)
                  .map((card) => {
                    const target = card.group.memberProjectRefs.find(
                      (ref) =>
                        canOperate.has(ref.environmentId) && connectedIds.has(ref.environmentId),
                    );
                    return (
                      <ProjectCard
                        key={card.group.projectKey}
                        card={card}
                        hosts={[
                          ...new Set(
                            card.group.memberProjectRefs.map(
                              (ref) => hostNames.get(ref.environmentId) ?? "Host",
                            ),
                          ),
                        ].join(", ")}
                        now={now}
                        canStart={target !== undefined}
                        onNewSession={() => {
                          if (!target) return;
                          openDraftChooser({ environmentId: target.environmentId });
                          setSelectedProject(`${target.environmentId}:${target.projectId}`);
                        }}
                      />
                    );
                  })}
              </div>
            )}
            <Pager
              label="Project pages"
              page={currentProjectPage}
              pageSize={PROJECT_PAGE}
              total={filteredProjects.length}
              onChange={setProjectPage}
            />
          </section>

          <CapacityFleet
            environments={environments}
            configs={configs}
            onNewDraft={(environmentId, model, validate) =>
              openDraftChooser({ environmentId, model, ...(validate ? { validate } : {}) })
            }
          />

          <nav className="studio-controls" aria-label="Workspace settings">
            <Link to="/settings/projects" className="studio-control-link">
              <PlusIcon aria-hidden="true" />
              <div>
                <h3>{projects.length ? "All projects" : "Add your first project"}</h3>
                <p>Register a workspace on a connected host.</p>
              </div>
              <ArrowRightIcon aria-hidden="true" />
            </Link>
            <Link to="/settings/providers" className="studio-control-link">
              <LayersIcon aria-hidden="true" />
              <div>
                <h3>Providers</h3>
                <p>Native instances, sign-in and model settings.</p>
              </div>
              <ArrowRightIcon aria-hidden="true" />
            </Link>
            <Link to="/settings/connections" className="studio-control-link">
              <LinkIcon aria-hidden="true" />
              <div>
                <h3>Connections</h3>
                <p>
                  Reach machines from anywhere with SpecWithCode Connect, or over LAN, SSH or
                  Tailscale.
                </p>
              </div>
              <ArrowRightIcon aria-hidden="true" />
            </Link>
          </nav>
          <footer className="studio-footer">
            <span>SpecWeave keeps intent and ownership portable.</span>
            <span>SpecWithCode keeps native conversations on their host.</span>
          </footer>
        </div>
      </main>
    </SidebarInset>
  );
}

type ProjectCardView = {
  readonly group: SidebarProjectSnapshot;
  readonly sessions: number;
  readonly attention: number;
  readonly working: number;
  readonly lastActivity: string | null;
  readonly complete?: boolean;
};

/** Projects that need a decision or are running lead, then the most recently active. */
function summarizeProjects(
  groups: readonly SidebarProjectSnapshot[],
  sessions: readonly SessionView[],
): ProjectCardView[] {
  const groupByProject = new Map<string, string>();
  for (const group of groups) {
    for (const ref of group.memberProjectRefs) {
      groupByProject.set(`${ref.environmentId}:${ref.projectId}`, group.projectKey);
    }
  }
  const stats = new Map<
    string,
    { sessions: number; attention: number; working: number; last: string | null }
  >();
  for (const session of sessions) {
    const key = groupByProject.get(`${session.thread.environmentId}:${session.thread.projectId}`);
    if (!key) continue;
    const entry = stats.get(key) ?? { sessions: 0, attention: 0, working: 0, last: null };
    entry.sessions += 1;
    if (session.attention) entry.attention += 1;
    if (session.working) entry.working += 1;
    if (!entry.last || Date.parse(session.thread.updatedAt) > Date.parse(entry.last)) {
      entry.last = session.thread.updatedAt;
    }
    stats.set(key, entry);
  }
  const time = (value: string | null) => (value ? Date.parse(value) || 0 : 0);
  return groups
    .map((group) => {
      const entry = stats.get(group.projectKey);
      return {
        group,
        sessions: entry?.sessions ?? 0,
        attention: entry?.attention ?? 0,
        working: entry?.working ?? 0,
        lastActivity: entry?.last ?? null,
      };
    })
    .sort(
      (a, b) =>
        b.attention - a.attention ||
        b.working - a.working ||
        time(b.lastActivity) - time(a.lastActivity) ||
        a.group.displayName.localeCompare(b.group.displayName),
    );
}

function Stat({
  value,
  label,
  hint,
  tone = "plain",
  onClick,
  href,
}: {
  value: string;
  label: string;
  hint: string;
  tone?: "plain" | "amber" | "moss";
  onClick?: () => void;
  href?: "/settings/connections";
}) {
  const className = `studio-stat${tone === "amber" ? " studio-stat-attention" : tone === "moss" ? " studio-stat-working" : ""}`;
  const body = (
    <>
      <span>{label}</span>
      <strong>{value}</strong>
      <em>
        {hint}
        <ArrowRightIcon aria-hidden="true" />
      </em>
    </>
  );
  return href ? (
    <Link to={href} className={className}>
      {body}
    </Link>
  ) : (
    <button type="button" className={className} onClick={onClick}>
      {body}
    </button>
  );
}

export function SectionHeading({
  number,
  title,
  id,
  detail,
  count,
  tone = "plain",
  action,
}: {
  number?: string;
  title: string;
  id: string;
  detail?: string;
  count?: number | undefined;
  tone?: "plain" | "amber";
  action?: ReactNode;
}) {
  return (
    <div className="studio-section-heading">
      {number && <span className="studio-section-number">{number}</span>}
      <h2 id={id}>{title}</h2>
      {count !== undefined && (
        <span className={`studio-count${tone === "amber" && count > 0 ? " amber" : ""}`}>
          {count}
        </span>
      )}
      {detail && <span className="studio-small">{detail}</span>}
      {action && <div className="studio-section-action">{action}</div>}
    </div>
  );
}

function Pager({
  label,
  page,
  pageSize,
  total,
  onChange,
}: {
  label: string;
  page: number;
  pageSize: number;
  total: number;
  onChange: (page: number) => void;
}) {
  if (total <= pageSize) return null;
  const pages = Math.ceil(total / pageSize);
  return (
    <nav className="studio-pager" aria-label={label}>
      <span>
        {page * pageSize + 1}–{Math.min(total, (page + 1) * pageSize)} of {total}
      </span>
      <button
        type="button"
        aria-label="Previous page"
        disabled={page === 0}
        onClick={() => onChange(page - 1)}
      >
        <ChevronLeftIcon aria-hidden="true" />
      </button>
      <span className="studio-pager-pages">
        {page + 1} / {pages}
      </span>
      <button
        type="button"
        aria-label="Next page"
        disabled={page >= pages - 1}
        onClick={() => onChange(page + 1)}
      >
        <ChevronRightIcon aria-hidden="true" />
      </button>
    </nav>
  );
}

/** One project in the chooser: its icon and title, with the host it lives on beside it. */
function ProjectChoice({ project, host }: { project: ProjectFaviconProject; host: string }) {
  return (
    <span className="studio-project-choice">
      <ProjectFavicon project={project} className="studio-project-choice-icon" />
      <span className="studio-project-choice-title">{project.title}</span>
      <span className="studio-project-choice-host">{host}</span>
    </span>
  );
}
function EmptyState({ title, detail }: { title: string; detail: string }) {
  return (
    <div className="studio-empty">
      <h3>{title}</h3>
      <p>{detail}</p>
    </div>
  );
}

type ChatTarget = ReturnType<typeof chatNavigationTarget>;

/** A link to a chat: a project's thread in the project's right panel, any other full page. */
function ChatLink({
  target,
  className,
  children,
}: {
  target: ChatTarget;
  className: string;
  children: ReactNode;
}) {
  return target.to === "/projects/$projectKey" ? (
    <Link
      to={target.to}
      params={{ ...target.params }}
      search={{ ...target.search }}
      className={className}
    >
      {children}
    </Link>
  ) : (
    <Link to={target.to} params={{ ...target.params }} className={className}>
      {children}
    </Link>
  );
}

function AttentionItem({
  session: s,
  target,
  host,
  now,
}: {
  session: SessionView;
  target: ChatTarget;
  host: string;
  now: number;
}) {
  return (
    <ChatLink target={target} className={`studio-attention-item ${attentionTone(s)}`}>
      <div className="studio-attention-top">
        <span className="studio-chip">{attentionLabel(s.attention!)}</span>
        <time dateTime={sessionStateSince(s.thread)}>
          {relativeTime(sessionStateSince(s.thread), now)}
        </time>
      </div>
      <h3>{s.thread.title || "Untitled session"}</h3>
      <div className="studio-row-meta">
        <span>
          {s.project?.title ?? "Project unavailable"} · {host}
        </span>
        <span>
          Open <ArrowRightIcon aria-hidden="true" />
        </span>
      </div>
    </ChatLink>
  );
}

function SessionItem({
  session: s,
  target,
  host,
  provider,
  entries,
  now,
}: {
  session: SessionView;
  target: ChatTarget;
  host: string;
  provider: string;
  entries: ReadonlyMap<string, ProviderInstanceEntry>;
  now: number;
}) {
  // A cached row from an older host can arrive without its model.
  const selection = s.thread.modelSelection as typeof s.thread.modelSelection | undefined;
  const tone = s.attention ? attentionTone(s) : s.working ? "moss" : s.settled ? "muted" : "plain";
  const incrementProgress = useThreadIncrementProgress({
    environmentId: s.thread.environmentId,
    projectId: s.project === null ? null : s.thread.projectId,
    threadIds: [s.thread.id],
    activityKey: s.thread.updatedAt,
  });
  const plan = compactThreadPlan(incrementProgress.get(s.thread.id) ?? null, s.thread.planProgress);
  return (
    <ChatLink target={target} className="studio-session-item">
      <span
        className={`studio-state-dot${s.attention ? " attention" : s.working ? " working" : ""}`}
        aria-hidden="true"
      />
      <div className="studio-session-main">
        <h3>{s.thread.title || "Untitled session"}</h3>
        <p style={{ container: "sessmeta / inline-size" }}>
          <span className="studio-session-project">
            {s.project?.title ?? "Project unavailable"}
          </span>
          <span aria-hidden="true">·</span> {host} <span aria-hidden="true">·</span>{" "}
          {selection ? <ThreadModelBadge thread={s.thread} entries={entries} /> : provider}
          {plan ? (
            <>
              {" "}
              <span aria-hidden="true">·</span> <PlanProgressChip plan={plan} />
            </>
          ) : null}
        </p>
      </div>
      <div className="studio-session-state">
        <span className={`studio-pill ${tone}`}>{s.state}</span>
        <time dateTime={sessionStateSince(s.thread)}>
          {relativeTime(sessionStateSince(s.thread), now)}
        </time>
      </div>
      <ArrowRightIcon aria-hidden="true" />
    </ChatLink>
  );
}

function ProjectCard({
  card,
  hosts,
  now,
  canStart,
  onNewSession,
}: {
  card: ProjectCardView;
  hosts: string;
  now: number;
  canStart: boolean;
  onNewSession: () => void;
}) {
  return (
    <article className={`studio-project${card.attention > 0 ? " needs-you" : ""}`}>
      <div className="studio-project-head">
        <ProjectFavicon project={card.group} className="studio-project-icon" />
        <div>
          <h3>{card.group.displayName}</h3>
          <p className="studio-small">{hosts}</p>
        </div>
      </div>
      <dl className="studio-project-stats">
        <div className={card.attention > 0 ? "amber" : ""}>
          <dt>Sessions needing action</dt>
          <dd>
            {card.complete === false
              ? card.attention > 0
                ? `${card.attention}+`
                : "Unknown"
              : card.attention}
          </dd>
        </div>
        <div className={card.working > 0 ? "moss" : ""}>
          <dt>Working sessions</dt>
          <dd>{card.complete === false ? `${card.working}+` : card.working}</dd>
        </div>
        <div>
          <dt>Sessions</dt>
          <dd>{card.sessions}</dd>
        </div>
      </dl>
      <div className="studio-project-foot">
        <span className="studio-small">
          {card.lastActivity
            ? `Active ${relativeTime(card.lastActivity, now).toLowerCase()}`
            : "No sessions yet"}
        </span>
        <div>
          <button
            type="button"
            className="studio-text-link"
            disabled={!canStart}
            onClick={onNewSession}
          >
            New session
          </button>
          <Link
            to="/projects/$projectKey"
            params={{ projectKey: card.group.projectKey }}
            className="studio-text-link"
          >
            Open <ArrowRightIcon aria-hidden="true" />
          </Link>
        </div>
      </div>
    </article>
  );
}
