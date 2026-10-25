/**
 * The design system page wired to one machine: reads the system, its owner's
 * other systems, how many designs use it and its stored files, and runs the
 * edits, rename, duplicate, rescan and delete the page offers.
 */
import { squashAtomCommandFailure } from "@specweave-studio/client-runtime/state/runtime";
import {
  AuthFilesystemReadScope,
  AuthFilesystemWriteScope,
  type DesignOwnerInput,
  type DesignSystem,
  type DesignSystemId,
  type EnvironmentId,
} from "@specweave-studio/contracts";
import { useRouter } from "@tanstack/react-router";
import { ShapesIcon } from "lucide-react";
import { useCallback, useState, type MouseEvent, type ReactNode } from "react";

import { isElectron } from "~/env";
import { cn } from "~/lib/utils";
import { useServerConfigs } from "~/state/entities";
import { useEnvironmentQuery } from "~/state/query";
import { useEnvironmentScope } from "~/state/session";
import { useAtomCommand } from "~/state/use-atom-command";
import { design } from "~/studio/design";

import { ProjectFavicon } from "../../../ProjectFavicon";
import { Spinner } from "../../../ui/spinner";
import { toastManager } from "../../../ui/toast";
import { WorkspacePageHeader } from "../../../WorkspacePageHeader";
import { encodeSystemKey } from "../../designKey";
import type { DesignOwnerProject } from "../../editor/backend";
import { ownerLinks, plainClick } from "../../editor/ownerLinks";
import { useOwnerProject } from "../../useOwnerProject";
import { duplicateSystemName } from "../reviewModel";
import { useOwnerProjects } from "../useOwnerProjects";
import { useSystemReviewFlow } from "../useSystemReviewFlow";
import { GENERATED_FILE_PATHS } from "./generatedFiles";
import { SystemWorkspace } from "./SystemWorkspace";
import { CONFLICT_TEXT, conflictRevision, editFailureText, useSystemEdits } from "./useSystemEdits";

const commandText = (cause: unknown, fallback: string) =>
  conflictRevision(cause) !== null ? CONFLICT_TEXT : editFailureText(cause, fallback);

/** The newer of what the server last sent and what this page saved since. */
function newest(read: DesignSystem | null, saved: DesignSystem | null): DesignSystem | null {
  if (read === null) return saved;
  if (saved === null || saved.id !== read.id) return read;
  return saved.revision > read.revision ? saved : read;
}

/** Systems read from project files can be read again. */
export function canRescan(owner: DesignOwnerInput, system: Pick<DesignSystem, "sources">): boolean {
  return (
    owner.kind === "project" &&
    system.sources.length > 0 &&
    system.sources.every((source) => source.kind === "file")
  );
}

export function SystemMessage({ title, children }: { title: string; children: ReactNode }) {
  return (
    <div className="flex min-h-0 flex-1 flex-col bg-background text-foreground">
      <WorkspacePageHeader electron={isElectron}>
        <h1 className="font-medium text-sm">Design system</h1>
      </WorkspacePageHeader>
      <div className="flex flex-1 flex-col items-center justify-center gap-1 px-6 text-center">
        <h2 className="font-medium text-base">{title}</h2>
        <p className="max-w-sm text-muted-foreground text-sm">{children}</p>
      </div>
    </div>
  );
}

export interface SystemPageProps {
  readonly environmentId: EnvironmentId;
  /** Stable for the page's life: the edit queue is built on it. */
  readonly owner: DesignOwnerInput;
  readonly systemId: DesignSystemId;
  readonly hash: string;
  readonly onHashChange: (hash: string) => void;
}

export function SystemPage(props: SystemPageProps) {
  const { environmentId, owner, systemId } = props;
  const canRead = useEnvironmentScope(environmentId, AuthFilesystemReadScope);
  const get = useEnvironmentQuery(
    canRead ? design.systemGet({ environmentId, input: { owner, systemId } }) : null,
  );
  const [saved, setSaved] = useState<DesignSystem | null>(null);
  const system = newest(get.data?.system ?? null, saved);

  if (!canRead)
    return (
      <SystemMessage title="Design systems are not available here">
        This window may not read design systems.
      </SystemMessage>
    );
  if (system === null) {
    const failure = get.failure as { _tag?: string; code?: string } | null;
    if (failure?._tag === "DesignError" && failure.code === "not_found")
      return (
        <SystemMessage title="Design system not found">
          It may have been deleted or moved.
        </SystemMessage>
      );
    if (get.error !== null)
      return <SystemMessage title="Could not open the design system">{get.error}</SystemMessage>;
    return (
      <div className="flex flex-1 items-center justify-center" aria-busy="true">
        <Spinner />
      </div>
    );
  }
  return <LoadedSystem {...props} system={system} onSaved={setSaved} refresh={get.refresh} />;
}

function LoadedSystem(
  props: SystemPageProps & {
    system: DesignSystem;
    onSaved: (system: DesignSystem) => void;
    refresh: () => void;
  },
) {
  const { environmentId, owner, systemId, system, onSaved, refresh } = props;
  const router = useRouter();
  const canWrite = useEnvironmentScope(environmentId, AuthFilesystemWriteScope);
  const editing =
    useServerConfigs().get(environmentId)?.environment.capabilities.designSystemEditing === true;
  const canEdit = canWrite && editing;
  const readOnlyReason = !canWrite
    ? "This window may view design systems but not change them."
    : !editing
      ? "Editing needs a newer version of the app on this machine."
      : null;
  const ownerProject = useOwnerProject(owner, environmentId);
  const projects = useOwnerProjects(environmentId);
  const ownerLabel =
    owner.kind === "playground" ? "Playground" : (ownerProject?.label ?? "Project");

  const list = useEnvironmentQuery(
    design.systemList({
      environmentId,
      input: {
        filter:
          owner.kind === "playground"
            ? { kind: "playground" }
            : { kind: "project", projectId: owner.projectId },
      },
    }),
  );
  const usage = useEnvironmentQuery(
    design.systemUsage({ environmentId, input: { owner, systemId } }),
  );
  const files = useEnvironmentQuery(
    editing ? design.systemFiles({ environmentId, input: { owner, systemId } }) : null,
  );

  const edits = useSystemEdits({ environmentId, owner, systemId, system, onSaved, refresh });
  const renameCommand = useAtomCommand(design.systemRename, { reportFailure: false });
  const copyCommand = useAtomCommand(design.systemCopy, { reportFailure: false });
  const deleteCommand = useAtomCommand(design.systemDelete, { reportFailure: false });
  const [rescanning, setRescanning] = useState(false);
  const review = useSystemReviewFlow({
    environmentId,
    projects,
    figmaWanted: false,
    onSaved: () => {
      refresh();
      list.refresh();
    },
  });

  const openSystem = useCallback(
    (id: DesignSystemId) =>
      void router.navigate({
        to: "/design/systems/$systemKey",
        params: { systemKey: encodeSystemKey(owner, id) },
      }),
    [owner, router],
  );

  const rename = async (name: string): Promise<boolean> => {
    const result = await renameCommand({
      environmentId,
      input: { owner, systemId, name, expectedRevision: system.revision },
    });
    if (result._tag === "Failure") {
      toastManager.add({
        type: "error",
        title: "Not renamed",
        description: commandText(squashAtomCommandFailure(result), "The name was not saved."),
      });
      return false;
    }
    onSaved(result.value.system);
    list.refresh();
    return true;
  };

  const duplicate = async () => {
    const copied = await copyCommand({ environmentId, input: { owner, systemId, to: owner } });
    if (copied._tag === "Failure") {
      toastManager.add({
        type: "error",
        title: "Not duplicated",
        description: commandText(
          squashAtomCommandFailure(copied),
          "The design system was not copied.",
        ),
      });
      return;
    }
    // Before the list loads, the name the server chose (already free) stands.
    const siblings = list.data?.systems;
    const name =
      siblings === undefined
        ? null
        : duplicateSystemName(
            system.name,
            siblings.map((sibling) => sibling.name),
          );
    const renamed =
      name === null
        ? null
        : await renameCommand({
            environmentId,
            input: {
              owner,
              systemId: copied.value.ref.systemId,
              name,
              expectedRevision: copied.value.system.revision,
            },
          });
    list.refresh();
    toastManager.add({
      type: "success",
      title: `Duplicated as ${renamed?._tag === "Success" ? name : copied.value.system.name}`,
    });
    openSystem(copied.value.ref.systemId);
  };

  const rescan = async () => {
    setRescanning(true);
    const state = await review.rescan(owner, systemId);
    setRescanning(false);
    if (state === null) return;
    if (state.status === "unchanged")
      toastManager.add({ type: "info", title: "No changes in the source files" });
    else if (state.status === "not-rescannable")
      toastManager.add({ type: "info", title: "Cannot rescan", description: state.detail });
    else if (state.status === "error")
      toastManager.add({ type: "error", title: "Rescan failed", description: state.message });
  };

  const remove = async (): Promise<string | null> => {
    const result = await deleteCommand({
      environmentId,
      input: { owner, systemId, expectedRevision: system.revision },
    });
    if (result._tag === "Failure")
      return commandText(squashAtomCommandFailure(result), "The design system was not deleted.");
    toastManager.add({ type: "success", title: `Deleted ${system.name}` });
    const links = ownerLinks({
      ownerLabel,
      ownerProject,
      thisMachine: "",
      devices: [],
      machines: [],
      link: "",
    });
    void router.navigate(links.designs.route);
    return null;
  };

  const storage = files.data
    ? { usedBytes: files.data.usedBytes, limitBytes: files.data.limitBytes }
    : null;

  return (
    <>
      <SystemWorkspace
        environmentId={environmentId}
        owner={owner}
        system={system}
        canEdit={canEdit}
        readOnlyReason={readOnlyReason}
        canManage={canWrite}
        onEdit={edits.edit}
        conflict={edits.conflict}
        onReload={edits.reload}
        usage={usage.data?.designs ?? null}
        fileCount={files.data ? files.data.files.length + GENERATED_FILE_PATHS.length : null}
        crumbs={<SystemCrumbs ownerProject={ownerProject} ownerLabel={ownerLabel} />}
        menu={{
          ownerLabel,
          siblings: list.data?.systems ?? (list.error ? [] : null),
          storage,
          onSwitch: openSystem,
          onDuplicate: () => void duplicate(),
          onOpenSettings: () => void router.navigate({ to: "/settings/design-systems" }),
          onRescan: canRescan(owner, system) ? () => void rescan() : null,
          rescanning,
          onDelete: remove,
        }}
        onRename={rename}
        hash={props.hash}
        onHashChange={props.onHashChange}
        onChanged={() => {
          refresh();
          files.refresh();
          list.refresh();
        }}
        electron={isElectron}
      />
      {review.dialog}
    </>
  );
}

const CRUMB =
  "inline-flex h-7 min-w-0 shrink items-center gap-1.5 rounded-md px-1.5 text-[13px] text-muted-foreground outline-none transition-colors duration-[120ms] hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring motion-reduce:transition-none";

function Slash() {
  return (
    <span aria-hidden className="shrink-0 select-none text-[13px] text-muted-foreground">
      /
    </span>
  );
}

/** "EasyChamp / Designs /" or "Playground /" ahead of the system's name. */
export function SystemCrumbs({
  ownerProject,
  ownerLabel,
}: {
  ownerProject: DesignOwnerProject | null;
  ownerLabel: string;
}) {
  const router = useRouter();
  const links = ownerLinks({
    ownerLabel,
    ownerProject,
    thisMachine: "",
    devices: [],
    machines: [],
    link: "",
  });
  const go = (event: MouseEvent, route: Parameters<typeof router.navigate>[0]) => {
    if (!plainClick(event)) return;
    event.preventDefault();
    void router.navigate(route);
  };
  return (
    <nav
      aria-label="Design system location"
      className="hidden min-w-0 shrink items-center md:flex"
      data-testid="system-crumbs"
    >
      {ownerProject !== null ? (
        <>
          {links.project !== null ? (
            <a
              href={links.project.href}
              className={cn(CRUMB, "max-w-48")}
              onClick={(event) => go(event, links.project!.route as never)}
            >
              {ownerProject.icon ? (
                <ProjectFavicon project={ownerProject.icon} className="size-3.5 shrink-0" />
              ) : null}
              <span className="truncate">{ownerProject.label}</span>
            </a>
          ) : (
            <span className={cn(CRUMB, "max-w-48")}>
              <span className="truncate">{ownerProject.label}</span>
            </span>
          )}
          <Slash />
        </>
      ) : null}
      <a
        href={links.designs.href}
        className={CRUMB}
        onClick={(event) => go(event, links.designs.route as never)}
      >
        {ownerProject === null ? <ShapesIcon aria-hidden className="size-3.5 shrink-0" /> : null}
        <span className="truncate">{ownerProject === null ? "Playground" : "Designs"}</span>
      </a>
      <Slash />
    </nav>
  );
}
