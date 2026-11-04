import { useMemo, useState } from "react";
import { Link } from "@tanstack/react-router";
import { ChevronRightIcon, FolderCodeIcon, MessageSquareIcon, SearchIcon } from "lucide-react";
import {
  AuthOrchestrationOperateScope,
  AuthOrchestrationReadScope,
  type EnvironmentId,
} from "@specweave-studio/contracts";
import { useEnvironmentScope } from "../../state/session";
import { useEnvironments } from "../../state/environments";
import { useThreadShells, useServerConfigs } from "../../state/entities";
import { openCommandPalette } from "../../commandPaletteBus";
import { threadActivityAt } from "../../studio/projectWorkspaceModel";
import { formatRelativeTimeLabel } from "../../timestampFormat";
import { cn } from "../../lib/utils";
import { connectionPhaseDotClassName } from "../ConnectionStatusDot";
import { useSettingsProjectGroups } from "./useSettingsProjectGroups";
import { settingsScopeNoticeCheckouts, type ScopeNoticeEntry } from "./settingsScopeNoticeChoices";
import {
  buildRemoteSheetModel,
  isTemporaryWorkspace,
  type RemoteSheetCheckout,
  type RemoteSheetFolder,
  type RemoteSheetProject,
} from "./machineRemoteSheetModel";
import { Badge } from "../ui/badge";
import { Button } from "../ui/button";
import {
  Dialog,
  DialogPopup,
  DialogHeader,
  DialogTitle,
  DialogDescription,
  DialogPanel,
  DialogFooter,
} from "../ui/dialog";
import { InputGroup, InputGroupAddon, InputGroupInput } from "../ui/input-group";
import { MiddleTruncate } from "../ui/middle-truncate";

export function remoteControlAvailability(
  connected: boolean,
  canRead: boolean,
  canOperate: boolean,
) {
  return {
    disabled: !connected || !canRead,
    label: canOperate ? "Remote control" : "View",
    detail: !connected
      ? "Machine is not connected. Reconnect before opening it."
      : !canRead
        ? "View permission required."
        : canOperate
          ? "Work stays on this machine."
          : "View only. Starting work requires permission on this machine.",
  };
}

/** More rows than this and the sheet offers a search field. */
const SEARCH_THRESHOLD = 6;
const RECENT_PROJECTS = 5;
const RECENT_THREADS = 5;

/** Every row shares one grid: icon, name over a secondary line, right-aligned meta. */
const ROW =
  "grid w-full min-w-0 grid-cols-[1rem_minmax(0,1fr)_auto] items-center gap-x-3 rounded-md px-2 py-1.5 text-left outline-none hover:bg-accent focus-visible:ring-2 focus-visible:ring-ring";
const META = "justify-self-end whitespace-nowrap text-muted-foreground text-xs tabular-nums";
const SECTION_TITLE = "px-2 pb-1 font-medium text-muted-foreground text-xs";

function activityLabel(activityAt: string | null) {
  return activityAt ? formatRelativeTimeLabel(activityAt) : "";
}

function threadCountLabel(count: number) {
  return count === 1 ? "1 thread" : `${count} threads`;
}

type Member = ReturnType<typeof useSettingsProjectGroups>[number]["memberProjects"][number];
type Checkout = ScopeNoticeEntry<Member>;
type SheetProject = RemoteSheetProject<Checkout["project"], Checkout["search"]>;
type SheetFolder = RemoteSheetFolder<Checkout["project"], Checkout["search"]>;

/** One secondary line: a path keeps both ends, a temporary folder's label truncates at the end. */
function FolderPath({ folder, fallback }: { folder: SheetFolder; fallback?: string }) {
  const value = folder.shortPath ?? fallback;
  if (!value) return null;
  const className = "text-muted-foreground text-xs";
  return isTemporaryWorkspace(folder.path) ? (
    <span title={folder.path ?? undefined} className={cn("min-w-0 truncate", className)}>
      {value}
    </span>
  ) : (
    <MiddleTruncate
      value={value}
      title={folder.path ?? undefined}
      showTitle={false}
      className={className}
    />
  );
}

function ProjectRow({ project, onNavigate }: { project: SheetProject; onNavigate: () => void }) {
  const [expanded, setExpanded] = useState(false);
  const first = project.folders[0]!;
  const name = (
    <span className="flex min-w-0 items-center gap-1.5">
      <span className="truncate font-medium text-sm">{project.name}</span>
      {project.folders.length > 1 ? (
        <Badge size="sm" variant="secondary">
          {project.folders.length} folders
        </Badge>
      ) : null}
      {project.archived ? (
        <Badge size="sm" variant="outline">
          Archived
        </Badge>
      ) : null}
    </span>
  );
  const icon = <FolderCodeIcon aria-hidden className="size-4 text-muted-foreground" />;
  const meta = (
    <span className={META} title={threadCountLabel(project.threadCount)}>
      {activityLabel(project.activityAt)}
      <span className="sr-only">, {threadCountLabel(project.threadCount)}</span>
    </span>
  );
  if (project.folders.length === 1) {
    return (
      <li>
        <Link to="/settings/projects" search={first.search} onClick={onNavigate} className={ROW}>
          {icon}
          <span className="flex min-w-0 flex-col">
            {name}
            <FolderPath folder={first} />
          </span>
          {meta}
        </Link>
      </li>
    );
  }
  return (
    <li>
      <button
        type="button"
        aria-expanded={expanded}
        onClick={() => setExpanded((value) => !value)}
        className={ROW}
      >
        {icon}
        <span className="flex min-w-0 flex-col">
          {name}
          {expanded ? null : <FolderPath folder={first} />}
        </span>
        <span className="flex items-center gap-1.5 justify-self-end">
          {meta}
          <ChevronRightIcon
            aria-hidden
            className={cn(
              "size-3.5 text-muted-foreground transition-transform motion-reduce:transition-none",
              expanded && "rotate-90",
            )}
          />
        </span>
      </button>
      {expanded ? (
        <ul aria-label={`${project.name} folders`}>
          {project.folders.map((folder) => (
            <li key={folder.key}>
              <Link
                to="/settings/projects"
                search={folder.search}
                onClick={onNavigate}
                className={ROW}
              >
                <span aria-hidden />
                <span className="flex min-w-0 items-center gap-1.5">
                  <FolderPath folder={folder} fallback={project.name} />
                  {folder.archived && !project.archived ? (
                    <Badge size="sm" variant="outline">
                      Archived
                    </Badge>
                  ) : null}
                </span>
                <span className={META} title={threadCountLabel(folder.threadCount)}>
                  {activityLabel(folder.activityAt)}
                </span>
              </Link>
            </li>
          ))}
        </ul>
      ) : null}
    </li>
  );
}

function MachineRemoteSheet({
  environmentId,
  name,
  canOperate,
  onNavigate,
}: {
  environmentId: EnvironmentId;
  name: string;
  canOperate: boolean;
  onNavigate: () => void;
}) {
  const groups = useSettingsProjectGroups();
  const configs = useServerConfigs();
  const shells = useThreadShells();
  const [query, setQuery] = useState("");
  const [showTemporary, setShowTemporary] = useState(false);
  const [showAllProjects, setShowAllProjects] = useState(false);
  const [showAllThreads, setShowAllThreads] = useState(false);

  const checkouts = useMemo(() => {
    const entries = settingsScopeNoticeCheckouts(
      groups
        .map((group) => ({
          ...group,
          memberProjects: group.memberProjects.filter(
            (member) => member.environmentId === environmentId,
          ),
        }))
        .filter((group) => group.memberProjects.length > 0),
      (id) => configs.get(id)?.scratchWorkspaceRoot ?? null,
      undefined,
    );
    const toCheckout =
      (archived: boolean) =>
      (entry: Checkout): RemoteSheetCheckout<Checkout["project"], Checkout["search"]> => {
        // The whole sheet is one machine, so rows drop the " · <machine>" suffix.
        const suffix = ` · ${entry.project.environmentLabel ?? "Environment"}`;
        return {
          key: entry.key,
          name: entry.label.endsWith(suffix) ? entry.label.slice(0, -suffix.length) : entry.label,
          path: entry.detail,
          projectId: entry.project.id,
          archived,
          project: entry.project,
          search: entry.search,
        };
      };
    return [...entries.listed.map(toCheckout(false)), ...entries.archived.map(toCheckout(true))];
  }, [groups, configs, environmentId]);

  const threads = useMemo(
    () =>
      shells
        .filter(
          (thread) =>
            thread.environmentId === environmentId &&
            thread.deletedAt === null &&
            thread.archivedAt === null,
        )
        .map((thread) => ({
          id: thread.id,
          title: thread.title,
          projectId: thread.projectId,
          activityAt: threadActivityAt(thread),
        })),
    [shells, environmentId],
  );

  const model = useMemo(
    () => buildRemoteSheetModel({ checkouts, threads, query }),
    [checkouts, threads, query],
  );
  const searching = query.trim().length > 0;
  const temporaryVisible = showTemporary || searching;
  const visibleProjects =
    showAllProjects || searching ? model.projects : model.projects.slice(0, RECENT_PROJECTS);
  const visibleThreads =
    showAllThreads || searching ? model.threads : model.threads.slice(0, RECENT_THREADS);
  const nothingMatches =
    searching &&
    model.projects.length === 0 &&
    model.temporary.length === 0 &&
    model.threads.length === 0;

  return (
    <>
      <DialogPanel className="space-y-5">
        {model.totalRows > SEARCH_THRESHOLD || query ? (
          <InputGroup>
            <InputGroupAddon>
              <SearchIcon />
            </InputGroupAddon>
            <InputGroupInput
              aria-label={`Search projects and threads on ${name}`}
              placeholder="Search projects and threads"
              type="search"
              size="sm"
              value={query}
              onChange={(event) => setQuery(event.currentTarget.value)}
            />
          </InputGroup>
        ) : null}
        {nothingMatches ? (
          <p className="px-2 text-muted-foreground text-sm">Nothing matches “{query.trim()}”.</p>
        ) : null}
        {!searching || model.projects.length + model.temporary.length > 0 ? (
          <section aria-label={`Projects on ${name}`}>
            <h3 className={SECTION_TITLE}>Projects</h3>
            {model.projects.length > 0 ? (
              <ul>
                {visibleProjects.map((project) => (
                  <ProjectRow key={project.key} project={project} onNavigate={onNavigate} />
                ))}
              </ul>
            ) : searching ? null : (
              <p className="px-2 text-muted-foreground text-sm">No projects on {name} yet.</p>
            )}
            {temporaryVisible && model.temporary.length > 0 ? (
              <ul aria-label="Temporary workspaces" className="mt-1">
                {model.temporary.map((project) => (
                  <ProjectRow key={project.key} project={project} onNavigate={onNavigate} />
                ))}
              </ul>
            ) : null}
            {!searching &&
            (model.projects.length > RECENT_PROJECTS || model.temporary.length > 0) ? (
              <div className="mt-1 flex flex-wrap gap-1">
                {model.projects.length > RECENT_PROJECTS ? (
                  <Button
                    size="xs"
                    variant="ghost"
                    className="text-muted-foreground"
                    onClick={() => setShowAllProjects((value) => !value)}
                  >
                    {showAllProjects ? "Show fewer" : `Show all ${model.projects.length} projects`}
                  </Button>
                ) : null}
                {model.temporary.length > 0 ? (
                  <Button
                    size="xs"
                    variant="ghost"
                    className="text-muted-foreground"
                    aria-expanded={showTemporary}
                    onClick={() => setShowTemporary((value) => !value)}
                  >
                    {showTemporary
                      ? "Hide temporary workspaces"
                      : `Show ${model.temporary.length} temporary ${
                          model.temporary.length === 1 ? "workspace" : "workspaces"
                        }`}
                  </Button>
                ) : null}
              </div>
            ) : null}
          </section>
        ) : null}
        {!searching || model.threads.length > 0 ? (
          <section aria-label={`Recent threads on ${name}`}>
            <h3 className={SECTION_TITLE}>Recent threads</h3>
            {visibleThreads.length > 0 ? (
              <ul>
                {visibleThreads.map((thread) => (
                  <li key={thread.id}>
                    <Link
                      to="/$environmentId/$threadId"
                      params={{ environmentId, threadId: thread.id }}
                      onClick={onNavigate}
                      className={ROW}
                    >
                      <MessageSquareIcon aria-hidden className="size-4 text-muted-foreground" />
                      <span className="flex min-w-0 items-center gap-1.5">
                        <span className="truncate text-sm">{thread.title}</span>
                        {thread.repeats > 1 ? (
                          <Badge
                            size="sm"
                            variant="secondary"
                            title={`${thread.repeats} threads have this title. This opens the newest.`}
                          >
                            ×{thread.repeats}
                          </Badge>
                        ) : null}
                      </span>
                      <span className={cn(META, "flex min-w-0 max-w-36 gap-1.5 sm:max-w-56")}>
                        {thread.projectName ? (
                          <span className="hidden min-w-0 truncate sm:inline">
                            {thread.projectName}
                          </span>
                        ) : null}
                        <span className="shrink-0">{activityLabel(thread.activityAt)}</span>
                      </span>
                    </Link>
                  </li>
                ))}
              </ul>
            ) : (
              <p className="px-2 text-muted-foreground text-sm">No threads on {name} yet.</p>
            )}
            {!searching && model.threads.length > RECENT_THREADS ? (
              <Button
                size="xs"
                variant="ghost"
                className="mt-1 text-muted-foreground"
                onClick={() => setShowAllThreads((value) => !value)}
              >
                {showAllThreads ? "Show fewer" : `Show all ${model.threads.length}`}
              </Button>
            ) : null}
          </section>
        ) : null}
      </DialogPanel>
      <DialogFooter className="sm:items-center sm:justify-between">
        <Link
          to="/settings/providers"
          search={{ machine: environmentId }}
          onClick={onNavigate}
          className="text-center text-muted-foreground text-sm hover:text-foreground"
        >
          Agents on {name}
        </Link>
        <Button
          size="sm"
          variant="outline"
          disabled={!canOperate}
          title={
            canOperate ? "Opens setup on this machine. It does not start an agent." : undefined
          }
          onClick={() => {
            onNavigate();
            openCommandPalette({ open: "add-project", environmentId });
          }}
        >
          Add a project
        </Button>
      </DialogFooter>
    </>
  );
}

/** Opening this panel only selects a view. It never starts or moves work or grants access. */
export function MachineRemoteControl({
  environmentId,
  name,
}: {
  environmentId: EnvironmentId;
  name: string;
}) {
  const [open, setOpen] = useState(false);
  const { environments } = useEnvironments();
  const environment = environments.find((item) => item.environmentId === environmentId);
  const phase = environment?.connection?.phase ?? null;
  const canRead = useEnvironmentScope(environmentId, AuthOrchestrationReadScope);
  const canOperate = useEnvironmentScope(environmentId, AuthOrchestrationOperateScope);
  const availability = remoteControlAvailability(phase === "connected", canRead, canOperate);
  return (
    <>
      <Button
        size="xs"
        variant="outline"
        disabled={availability.disabled}
        title={availability.detail}
        onClick={() => setOpen(true)}
      >
        {availability.label}
      </Button>
      <Dialog open={open} onOpenChange={setOpen}>
        <DialogPopup className="max-w-xl">
          <DialogHeader>
            <DialogTitle>
              {availability.label} · {name}
            </DialogTitle>
            <DialogDescription className="flex items-center gap-2">
              <span
                aria-hidden
                className={cn(
                  "inline-flex size-2 shrink-0 rounded-full",
                  phase ? connectionPhaseDotClassName(phase) : "bg-muted-foreground/40",
                )}
              />
              <span>
                {phase === "connected" ? "Online" : "Offline"} · {availability.detail}
              </span>
            </DialogDescription>
          </DialogHeader>
          {availability.disabled ? (
            <DialogPanel>
              <p role="status">{availability.detail}</p>
            </DialogPanel>
          ) : (
            <MachineRemoteSheet
              environmentId={environmentId}
              name={name}
              canOperate={canOperate}
              onNavigate={() => setOpen(false)}
            />
          )}
        </DialogPopup>
      </Dialog>
    </>
  );
}
