import { renderRich } from "../../i18n/rich";
import { useTx } from "../../i18n";
import { aggregateProjectAttention } from "@specweave-studio/client-runtime/state/projectAttention";
import { projectAttentionRoots, useAttentionMembers } from "../../studio/useProjectAttention";
import { useSettingsProjectGroups } from "../settings/useSettingsProjectGroups";
import { isPersonalAssistantProject } from "@specweave-studio/shared/personalAssistant";
import { useAideEnabled } from "../../hooks/useSettings";
import { threadsVisibleWithAide, visibleWithAide } from "../../studio/personalAssistant";
import { useNowMinute } from "../../hooks/useNowMinute";
import {
  archivedMemberKeys,
  automatedMemberKeys,
  partitionProjectGroups,
  projectPickerMembers,
  type ScratchRootLookup,
} from "../../studio/projectListVisibility";
import { scopeProjectRef } from "@specweave-studio/client-runtime/environment";
import type { ModelSelection } from "@specweave-studio/contracts";
import { AuthOrchestrationOperateScope } from "@specweave-studio/contracts";
import { Link } from "@tanstack/react-router";
import { ArrowRightIcon, CheckIcon, PlusIcon, SearchIcon, XIcon } from "lucide-react";
import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { openCommandPalette } from "../../commandPaletteBus";
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
import { useEnvironments, usePrimaryEnvironmentId } from "../../state/environments";
import { useEnvironmentsWithScope } from "../../state/session";
import { WhatYouCanDo } from "./WhatYouCanDo";
import {
  attentionLabel,
  dayGroup,
  deriveSessions,
  groupAttention,
  resolveNativeModel,
  type DayGroup,
  type SessionView,
} from "../../studio/overviewModel";
import { ProjectFavicon, type ProjectFaviconProject } from "../ProjectFavicon";
import { WorkspacePageHeader } from "../WorkspacePageHeader";
import { Select, SelectItem, SelectPopup, SelectTrigger, SelectValue } from "../ui/select";
import { SidebarInset } from "../ui/sidebar";
import { CapacityFleet } from "./CapacityFleet";
import {
  ChatRow,
  MachineRow,
  ProjectRow,
  providerLabel,
  useOverviewKeys,
  type MachineRowView,
  type ProjectRowView,
} from "./OverviewRows";
import { useProviderEntriesByEnvironment } from "./shell/ModelBadge";
import "./overview.css";

type DraftRequest = {
  readonly environmentId?: string;
  readonly model?: ModelSelection;
  readonly validate?: () => boolean;
};

type RecentTab = "open" | "done";

/** Needs you shows this many rows before "Show more". */
const ATTENTION_PAGE = 8;
/** Recent shows this many, and "Show more" adds as many again. */
const RECENT_PAGE = 20;
const PROJECT_PAGE = 8;

const DAY_LABELS: Record<DayGroup, string> = {
  today: "Today",
  yesterday: "Yesterday",
  earlier: "Earlier",
};

export function StudioOverview() {
  const tx = useTx();
  // While the personal assistant is off (Settings → General), Overview shows neither
  // its card, its chats nor offers it as a new chat's project.
  const aideEnabled = useAideEnabled();
  const allProjectGroups = useSettingsProjectGroups();
  const projectGroups = useMemo(
    () =>
      aideEnabled
        ? allProjectGroups
        : allProjectGroups.filter(
            (group) => !group.memberProjects.some(isPersonalAssistantProject),
          ),
    [aideEnabled, allProjectGroups],
  );
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
  const catalogProjects = useProjects();
  const projects = useMemo(
    () => visibleWithAide(catalogProjects, aideEnabled),
    [catalogProjects, aideEnabled],
  );
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
  const catalogShells = useThreadShells();
  const allShells = useMemo(
    () => threadsVisibleWithAide(catalogShells, catalogProjects, aideEnabled),
    [catalogShells, catalogProjects, aideEnabled],
  );
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
  const [recentTab, setRecentTab] = useState<RecentTab>("open");
  const [recentLimit, setRecentLimit] = useState(RECENT_PAGE);
  const [attentionOpen, setAttentionOpen] = useState(false);
  const [chatQuery, setChatQuery] = useState("");
  // Picking a machine or a project's count narrows every list to it.
  const [machineScope, setMachineScope] = useState<string | null>(null);
  const [projectScope, setProjectScope] = useState<string | null>(null);
  const pageRef = useRef<HTMLElement>(null);
  const filterRef = useRef<HTMLInputElement>(null);
  const revealFrom = useRef<number | null>(null);
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
  // Counted as the Working list shows them: a running chat that needs you is listed there.
  const working = sessions.filter((s) => s.working && s.attention === null).length;
  const connected = connectedIds.size;
  // With no projects, no sessions and every host connected, nothing is left unobserved.
  const observationsComplete =
    attentionComplete ||
    (attentionMembers.length === 0 && allShells.length === 0 && connected === environments.length);
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
  const projectCards = useMemo(
    () =>
      summarizeProjects(
        listedGroups,
        // With a machine picked, each project counts only its chats there.
        machineScope === null
          ? sessions
          : sessions.filter((s) => s.thread.environmentId === machineScope),
      ).map((card) => ({
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
    [listedGroups, sessions, attentionMembers, attentionComplete, machineScope],
  );
  const providerEntries = useProviderEntriesByEnvironment();
  const providersFor = (environmentId: SessionView["thread"]["environmentId"]) =>
    configs.get(environmentId)?.providers ?? [];

  const openDraftChooser = (next: DraftRequest = {}) => {
    setRequest(next);
    setSelectedProject("");
    setStartError(null);
  };
  const openDraftChooserRef = useRef(openDraftChooser);
  openDraftChooserRef.current = openDraftChooser;
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
          ? tx(
              "This capacity choice is no longer available. Refresh observations or check the host connection and permissions, then choose again.",
            )
          : tx(
              "The draft could not be opened. Reconnect the host or check the project, then try again.",
            ),
      );
    } finally {
      setStarting(false);
    }
  };

  const primaryEnvironmentId = usePrimaryEnvironmentId();
  const groupByMemberKey = useMemo(() => {
    const map = new Map<string, string>();
    for (const group of listedGroups)
      for (const ref of group.memberProjectRefs)
        map.set(`${ref.environmentId}:${ref.projectId}`, group.projectKey);
    return map;
  }, [listedGroups]);
  const inScope = (s: SessionView) =>
    (machineScope === null || s.thread.environmentId === machineScope) &&
    (projectScope === null ||
      groupByMemberKey.get(`${s.thread.environmentId}:${s.thread.projectId}`) === projectScope);
  const scoped = sessions.filter(inScope);
  const scopedAttention = scoped.filter((s) => s.attention !== null);
  const attentionGroups = groupAttention(scopedAttention);
  const workingSessions = scoped.filter((s) => s.working && s.attention === null);
  const query = chatQuery.trim().toLowerCase();
  const recentOf = (tab: RecentTab) =>
    scoped.filter(
      (s) => s.attention === null && !s.working && (tab === "done" ? s.settled : !s.settled),
    );
  const recentCounts = { open: recentOf("open").length, done: recentOf("done").length };
  const recent = recentOf(recentTab).filter(
    (s) =>
      !query ||
      (s.thread.title ?? "").toLowerCase().includes(query) ||
      (s.project?.title ?? "").toLowerCase().includes(query),
  );
  const recentShown = recent.slice(0, recentLimit);
  // Machines whose chats this page cannot currently vouch for.
  const staleMachines = environments.filter(
    (environment) =>
      environment.connection.phase !== "connected" ||
      attentionMembers.some(
        (member) =>
          member.environmentId === environment.environmentId && member.freshness !== "live",
      ),
  );
  const machineStatus = (phase: string) =>
    phase === "connected"
      ? tx("Connected")
      : phase === "connecting" || phase === "reconnecting"
        ? tx("Reconnecting")
        : phase === "error" || phase === "unsupported"
          ? tx("Can’t connect")
          : tx("Offline");
  const machines: MachineRowView[] = environments.map((environment) => {
    const phase = environment.connection.phase;
    const stale = staleMachines.includes(environment);
    return {
      environmentId: environment.environmentId,
      label: environment.label,
      status: phase === "connected" && stale ? tx("Catching up") : machineStatus(phase),
      tone:
        phase === "connected" ? (stale ? "amber" : "moss") : phase === "error" ? "red" : "amber",
      version: environment.serverConfig?.environment.serverVersion ?? null,
      attention: attention.filter((s) => s.thread.environmentId === environment.environmentId)
        .length,
      projects: listedGroups.filter((group) =>
        group.memberProjectRefs.some((ref) => ref.environmentId === environment.environmentId),
      ).length,
      thisMachine: environment.environmentId === primaryEnvironmentId,
    };
  });
  const railProjects = projectCards.filter(
    (card) =>
      machineScope === null ||
      card.group.memberProjectRefs.some((ref) => ref.environmentId === machineScope),
  );
  const [allProjects, setAllProjects] = useState(false);
  const scopeLabel =
    machineScope !== null
      ? (hostNames.get(machineScope as never) ?? tx("this machine"))
      : projectScope !== null
        ? (listedGroups.find((group) => group.projectKey === projectScope)?.displayName ?? "")
        : null;
  const clearScope = () => {
    setMachineScope(null);
    setProjectScope(null);
    // The chip leaves with the filter; focus goes to the list it was narrowing.
    document.getElementById("studio-attention-title")?.focus();
  };
  const jump = (id: string) =>
    document.getElementById(id)?.scrollIntoView?.({ block: "start", behavior: "smooth" });
  const focusFilter = useCallback(() => {
    filterRef.current?.focus();
    filterRef.current?.scrollIntoView?.({ block: "nearest" });
  }, []);
  // With the chooser already open, N leaves its choice and model alone.
  const requestOpen = useRef(false);
  requestOpen.current = request !== null;
  const newChat = useCallback(() => {
    if (requestOpen.current) document.getElementById("studio-project")?.focus();
    else openDraftChooserRef.current();
  }, []);
  useOverviewKeys(pageRef, { onNewChat: newChat, onFilter: focusFilter });

  const headline = !bootstrapped
    ? tx("Reading your chats…")
    : attention.length > 0
      ? renderRich(tx(attention.length === 1 ? "{em} needs you" : "{em} need you"), {
          em: (
            <em>
              {tx(attention.length === 1 ? "{count} chat" : "{count} chats", {
                count: attention.length,
              })}
            </em>
          ),
        })
      : tx("Nothing needs you");
  const linkButton = (label: string, id: string) => (
    <button type="button" className="studio-inline-link" onClick={() => jump(id)}>
      {label}
    </button>
  );
  const summary = !bootstrapped
    ? tx("Each connected machine reports its chats.")
    : renderRich(tx("{working} · {chats} in {projects} on {machines}"), {
        working:
          working > 0
            ? linkButton(tx("{count} working", { count: working }), "studio-working-title")
            : tx("None working"),
        chats: tx(sessions.length === 1 ? "{count} chat" : "{count} chats", {
          count: sessions.length,
        }),
        projects: linkButton(
          tx(listedGroups.length === 1 ? "{count} project" : "{count} projects", {
            count: listedGroups.length,
          }),
          "studio-projects-title",
        ),
        machines: linkButton(
          tx(environments.length === 1 ? "{count} machine" : "{count} machines", {
            count: environments.length,
          }),
          "studio-machines-title",
        ),
      });
  const staleNotice =
    bootstrapped && isReady && (staleMachines.length > 0 || !observationsComplete)
      ? staleMachines.length === 1
        ? tx("{machine} is {status}, so its chats may be missing from these counts.", {
            machine: staleMachines[0]!.label,
            status: (
              machines.find((m) => m.environmentId === staleMachines[0]!.environmentId)?.status ??
              ""
            ).toLowerCase(),
          })
        : staleMachines.length > 1
          ? tx("{machines} are not current, so their chats may be missing from these counts.", {
              machines: staleMachines
                .map(
                  (environment) =>
                    `${environment.label} (${(
                      machines.find((m) => m.environmentId === environment.environmentId)?.status ??
                      ""
                    ).toLowerCase()})`,
                )
                .join(", "),
            })
          : tx("Some machines are still reporting, so these counts may be incomplete.")
      : null;
  const chatRow = (s: SessionView) => (
    <ChatRow
      key={`${s.thread.environmentId}:${s.thread.id}`}
      session={s}
      target={chatTarget(s.thread)}
      host={hostNames.get(s.thread.environmentId) ?? "Host"}
      provider={providerLabel(providersFor(s.thread.environmentId), s.thread.providerInstanceId)}
      entries={providerEntries.get(s.thread.environmentId) ?? new Map()}
      now={now}
    />
  );
  // Needs you shows its first rows across groups, then the rest on request.
  let attentionBudget = attentionOpen ? Number.POSITIVE_INFINITY : ATTENTION_PAGE;
  const attentionHidden = Math.max(0, scopedAttention.length - ATTENTION_PAGE);
  const recentByDay: Array<{ day: DayGroup; sessions: SessionView[] }> = [];
  for (const s of recentShown) {
    const day = dayGroup(s.thread.updatedAt, now);
    const last = recentByDay.at(-1);
    if (last?.day === day) last.sessions.push(s);
    else recentByDay.push({ day, sessions: [s] });
  }
  const tabs: RecentTab[] = ["open", "done"];
  useEffect(() => {
    if (revealFrom.current === null) return;
    const rows = document.querySelectorAll<HTMLElement>('[role="tabpanel"] [data-overview-row]');
    rows[revealFrom.current]?.focus();
    revealFrom.current = null;
  }, [recentLimit]);
  const onTabKey = (event: React.KeyboardEvent<HTMLButtonElement>) => {
    if (event.key !== "ArrowLeft" && event.key !== "ArrowRight") return;
    event.preventDefault();
    const next = tabs[(tabs.indexOf(recentTab) + 1) % tabs.length]!;
    setRecentTab(next);
    setRecentLimit(RECENT_PAGE);
    document.getElementById(`studio-recent-tab-${next}`)?.focus();
  };

  return (
    <SidebarInset className="studio-desk h-dvh min-h-0 overflow-hidden overscroll-y-none">
      <WorkspacePageHeader electron={isElectron} className="studio-topbar">
        <span className="studio-topbar-title">{tx("Overview")}</span>
        <Link to="/settings/connections" className="studio-text-link studio-topbar-link no-drag">
          {tx("Connections")} <ArrowRightIcon aria-hidden="true" />
        </Link>
      </WorkspacePageHeader>
      <main ref={pageRef} className="studio-scroll" aria-labelledby="studio-heading">
        <div className="studio-content">
          <header className="studio-masthead">
            <div className="studio-masthead-copy">
              <h1 id="studio-heading">{headline}</h1>
              <p className="studio-intro" aria-live="polite">
                {summary}
              </p>
            </div>
            <div className="studio-masthead-actions">
              <button
                type="button"
                className="studio-secondary"
                onClick={() => openCommandPalette()}
              >
                <SearchIcon aria-hidden="true" /> {tx("Search")}
              </button>
              <button type="button" className="studio-primary" onClick={() => openDraftChooser()}>
                <PlusIcon aria-hidden="true" /> {tx("New chat")}
                <kbd aria-hidden="true">N</kbd>
              </button>
            </div>
          </header>

          {networkStatus === "offline" && (
            <p className="studio-notice" role="status">
              {tx(
                "This device is offline. Saved chats may be out of date; reconnect before starting work.",
              )}
            </p>
          )}
          {staleNotice && (
            <p className="studio-notice studio-stale-notice" role="status">
              <span className="studio-state-dot amber" aria-hidden="true" />
              <span>{staleNotice}</span>
              <Link to="/settings/connections" className="studio-notice-action">
                {tx("Check connection")}
              </Link>
            </p>
          )}
          <WhatYouCanDo
            known={bootstrapped && isReady}
            hasProject={listedGroups.some(
              (group) => !group.memberProjects.some(isPersonalAssistantProject),
            )}
            hasSession={catalogShells.length > 0}
            hasOtherMachine={environments.length > 1}
            onNewSession={() => openDraftChooser()}
          />

          {request !== null && (
            <section className="studio-draft-chooser" aria-labelledby="studio-draft-title">
              <div>
                <p className="studio-eyebrow">{tx("New chat")}</p>
                <h2 id="studio-draft-title">{tx("Choose a project")}</h2>
                <p className="studio-small">
                  {request.model
                    ? tx("Native instance: {instance} · {model}", {
                        instance: request.model.instanceId,
                        model: request.model.model,
                      })
                    : tx("The project’s native provider and permission settings apply.")}
                </p>
              </div>
              {draftProjects.length === 0 ? (
                <p className="studio-notice">
                  {renderRich(
                    tx(
                      "No connected project is available with this connection’s operating permission. {link} or {link2}.",
                    ),
                    {
                      link: <Link to="/settings/projects">{tx("Open Projects")}</Link>,
                      link2: <Link to="/settings/connections">{tx("Connections")}</Link>,
                    },
                  )}
                </p>
              ) : (
                <div className="studio-draft-fields">
                  <label htmlFor="studio-project">{tx("Project and machine")}</label>
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
                              {tx("Choose a registered project…")}
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
                    {starting ? tx("Opening…") : tx("Open native draft")}
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
                {tx("Cancel")}
              </button>
            </section>
          )}

          {scopeLabel !== null && (
            <div className="studio-scope" role="status">
              <span>
                {machineScope !== null
                  ? tx("Showing chats on {name}", { name: scopeLabel })
                  : tx("Showing chats in {name}", { name: scopeLabel })}
              </span>
              <button type="button" className="studio-scope-clear" onClick={clearScope}>
                <XIcon aria-hidden="true" /> {tx("Show all")}
              </button>
            </div>
          )}

          <div className="studio-work-grid">
            <div className="studio-work-main">
              <section className="studio-attention" aria-labelledby="studio-attention-title">
                <SectionHeading
                  title={tx("Needs you")}
                  id="studio-attention-title"
                  count={bootstrapped ? scopedAttention.length : undefined}
                  tone="amber"
                  action={
                    scopedAttention.length > 0 ? (
                      <span className="studio-key-hint" aria-hidden="true">
                        <kbd>J</kbd> <kbd>K</kbd> {tx("move")} · <kbd>↵</kbd> {tx("open")}
                      </span>
                    ) : undefined
                  }
                />
                {!bootstrapped ? (
                  <EmptyState
                    title={tx("Reading your chats…")}
                    detail={tx("Each connected machine reports its chats.")}
                  />
                ) : scopedAttention.length === 0 ? (
                  <div className="studio-list studio-clear">
                    <CheckIcon aria-hidden="true" />
                    <div>
                      <h3>{tx("A clear desk.")}</h3>
                      <p>
                        {tx(
                          "No approvals, questions or plans reported by connected machines need a decision.",
                        )}
                      </p>
                    </div>
                  </div>
                ) : (
                  <div className="studio-list">
                    {attentionGroups.map((group) => {
                      if (attentionBudget <= 0) return null;
                      const rows = group.sessions.slice(0, attentionBudget);
                      attentionBudget -= rows.length;
                      return (
                        <div
                          key={group.kind}
                          role="group"
                          aria-label={tx(attentionLabel(group.kind))}
                        >
                          <h3 className="studio-group-label">
                            {tx(attentionLabel(group.kind))} · {group.sessions.length}
                          </h3>
                          {rows.map(chatRow)}
                        </div>
                      );
                    })}
                    {attentionHidden > 0 && (
                      <button
                        type="button"
                        className="studio-more"
                        aria-expanded={attentionOpen}
                        onClick={() => setAttentionOpen(!attentionOpen)}
                      >
                        {attentionOpen
                          ? tx("Show fewer")
                          : tx("Show {count} more", { count: attentionHidden })}
                      </button>
                    )}
                  </div>
                )}
              </section>

              <section aria-labelledby="studio-working-title">
                <SectionHeading
                  title={tx("Working")}
                  id="studio-working-title"
                  count={bootstrapped ? workingSessions.length : undefined}
                  tone="moss"
                />
                {workingSessions.length === 0 ? (
                  <EmptyState
                    title={tx("Nothing is running.")}
                    detail={tx("Chats you start or continue show here while they work.")}
                  />
                ) : (
                  <div className="studio-list">{workingSessions.map(chatRow)}</div>
                )}
              </section>

              <section aria-labelledby="studio-sessions-title">
                <SectionHeading
                  title={tx("Recent")}
                  id="studio-sessions-title"
                  action={
                    <>
                      <div className="studio-segmented" role="tablist" aria-label={tx("Show")}>
                        {tabs.map((tab) => (
                          <button
                            key={tab}
                            id={`studio-recent-tab-${tab}`}
                            type="button"
                            role="tab"
                            aria-selected={recentTab === tab}
                            tabIndex={recentTab === tab ? 0 : -1}
                            onKeyDown={onTabKey}
                            onClick={() => {
                              setRecentTab(tab);
                              setRecentLimit(RECENT_PAGE);
                            }}
                          >
                            {tab === "open" ? tx("Open") : tx("Done")}
                            <span>{recentCounts[tab]}</span>
                          </button>
                        ))}
                      </div>
                      <label className="studio-search">
                        <SearchIcon aria-hidden="true" />
                        <input
                          ref={filterRef}
                          type="search"
                          placeholder={tx("Filter chats")}
                          aria-label={tx("Filter chats")}
                          aria-keyshortcuts="/"
                          value={chatQuery}
                          onChange={(event) => {
                            setChatQuery(event.target.value);
                            setRecentLimit(RECENT_PAGE);
                          }}
                        />
                      </label>
                    </>
                  }
                />
                {recent.length === 0 ? (
                  <EmptyState
                    title={
                      !bootstrapped
                        ? tx("Reading your chats…")
                        : sessions.length === 0
                          ? tx("The next chat starts here.")
                          : query
                            ? tx("No chats match.")
                            : recentTab === "done"
                              ? tx("No finished chats yet.")
                              : tx("No other open chats.")
                    }
                    detail={
                      sessions.length === 0
                        ? tx(
                            "Choose New chat above. Plans, approvals and checkpoints stay with the chat.",
                          )
                        : query
                          ? tx("Try a shorter name, or switch between Open and Done.")
                          : tx("Chats that need you or are working are listed above.")
                    }
                  />
                ) : (
                  <div
                    className="studio-list"
                    role="tabpanel"
                    aria-labelledby={`studio-recent-tab-${recentTab}`}
                  >
                    {recentByDay.map((block) => (
                      <div key={block.day} role="group" aria-label={tx(DAY_LABELS[block.day])}>
                        <h3 className="studio-group-label">{tx(DAY_LABELS[block.day])}</h3>
                        {block.sessions.map(chatRow)}
                      </div>
                    ))}
                    {recent.length > recentShown.length && (
                      <button
                        type="button"
                        className="studio-more"
                        onClick={() => {
                          // Focus moves to the first chat it reveals, so it is not lost
                          // when the button leaves with the last page.
                          revealFrom.current = recentShown.length;
                          setRecentLimit(recentLimit + RECENT_PAGE);
                        }}
                      >
                        {tx("Show {count} more", {
                          count: Math.min(RECENT_PAGE, recent.length - recentShown.length),
                        })}
                        <span className="studio-more-total">
                          {tx("{shown} of {total}", {
                            shown: recentShown.length,
                            total: recent.length,
                          })}
                        </span>
                      </button>
                    )}
                  </div>
                )}
              </section>
            </div>

            <aside className="studio-rail" aria-label={tx("Projects and machines")}>
              <section aria-labelledby="studio-projects-title">
                <SectionHeading
                  title={tx("Projects")}
                  id="studio-projects-title"
                  count={railProjects.length}
                  action={
                    <Link to="/settings/projects" className="studio-text-link">
                      {tx("Manage")}
                    </Link>
                  }
                />
                {railProjects.length === 0 ? (
                  <EmptyState
                    title={tx("Add your first project.")}
                    detail={tx("Register a folder on a connected machine to start chats in it.")}
                  />
                ) : (
                  <div className="studio-list">
                    {(allProjects ? railProjects : railProjects.slice(0, PROJECT_PAGE)).map(
                      (card) => {
                        const startable = card.group.memberProjectRefs.filter(
                          (ref) =>
                            canOperate.has(ref.environmentId) &&
                            connectedIds.has(ref.environmentId),
                        );
                        // With a machine picked, a new chat starts on that machine.
                        const target =
                          machineScope === null
                            ? startable[0]
                            : startable.find((ref) => ref.environmentId === machineScope);
                        return (
                          <ProjectRow
                            key={card.group.projectKey}
                            card={card}
                            hosts={[
                              ...new Set(
                                card.group.memberProjectRefs.map(
                                  (ref) => hostNames.get(ref.environmentId) ?? "Host",
                                ),
                              ),
                            ].join(" · ")}
                            filtered={projectScope === card.group.projectKey}
                            canStart={target !== undefined}
                            onFilter={() => {
                              setMachineScope(null);
                              setProjectScope(
                                projectScope === card.group.projectKey
                                  ? null
                                  : card.group.projectKey,
                              );
                              jump("studio-attention-title");
                            }}
                            onNewChat={() => {
                              if (!target) return;
                              openDraftChooser({ environmentId: target.environmentId });
                              setSelectedProject(`${target.environmentId}:${target.projectId}`);
                            }}
                          />
                        );
                      },
                    )}
                    {railProjects.length > PROJECT_PAGE && (
                      <button
                        type="button"
                        className="studio-more"
                        aria-expanded={allProjects}
                        onClick={() => setAllProjects(!allProjects)}
                      >
                        {allProjects
                          ? tx("Show fewer")
                          : tx("Show all {count}", { count: railProjects.length })}
                      </button>
                    )}
                  </div>
                )}
              </section>
              <section aria-labelledby="studio-machines-title">
                <SectionHeading
                  title={tx("Machines")}
                  id="studio-machines-title"
                  count={machines.length}
                  action={
                    <Link to="/settings/connections" className="studio-text-link">
                      {tx("Connections")}
                    </Link>
                  }
                />
                {machines.length === 0 ? (
                  <EmptyState
                    title={tx("No machines yet.")}
                    detail={tx("Connect this machine or another one in Connections.")}
                  />
                ) : (
                  <div className="studio-list">
                    {machines.map((machine) => (
                      <MachineRow
                        key={machine.environmentId}
                        machine={machine}
                        selected={machineScope === machine.environmentId}
                        onSelect={() => {
                          setProjectScope(null);
                          setMachineScope(
                            machineScope === machine.environmentId ? null : machine.environmentId,
                          );
                        }}
                      />
                    ))}
                  </div>
                )}
              </section>
            </aside>
          </div>

          <CapacityFleet
            environments={environments}
            configs={configs}
            onNewDraft={(environmentId, model, validate) =>
              openDraftChooser({ environmentId, model, ...(validate ? { validate } : {}) })
            }
          />
        </div>
      </main>
    </SidebarInset>
  );
}

/** Projects that need a decision or are running lead, then the most recently active. */
function summarizeProjects(
  groups: readonly SidebarProjectSnapshot[],
  sessions: readonly SessionView[],
): Array<ProjectRowView & { readonly lastActivity: string | null }> {
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

function SectionHeading({
  title,
  id,
  count,
  tone = "plain",
  action,
}: {
  title: string;
  id: string;
  count?: number | undefined;
  tone?: "plain" | "amber" | "moss";
  action?: ReactNode;
}) {
  return (
    <div className="studio-section-heading">
      <h2 id={id} tabIndex={-1}>
        {title}
      </h2>
      {count !== undefined && (
        <span className={`studio-count${count > 0 && tone !== "plain" ? ` ${tone}` : ""}`}>
          {count}
        </span>
      )}
      {action && <div className="studio-section-action">{action}</div>}
    </div>
  );
}

/** One project in the chooser: its icon and title, with the machine it lives on beside it. */
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
    <div className="studio-list studio-empty">
      <h3>{title}</h3>
      <p>{detail}</p>
    </div>
  );
}
