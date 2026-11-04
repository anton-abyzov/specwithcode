import { useState } from "react";
import { Link } from "@tanstack/react-router";
import {
  AuthOrchestrationOperateScope,
  AuthOrchestrationReadScope,
  type EnvironmentId,
} from "@specweave-studio/contracts";
import { useEnvironmentScope } from "../../state/session";
import { useEnvironments } from "../../state/environments";
import { useThreadShells, useServerConfigs } from "../../state/entities";
import { openCommandPalette } from "../../commandPaletteBus";
import { useSettingsProjectGroups } from "./useSettingsProjectGroups";
import { settingsScopeNoticeCheckouts } from "./settingsScopeNoticeChoices";
import { Button } from "../ui/button";
import {
  Dialog,
  DialogPopup,
  DialogHeader,
  DialogTitle,
  DialogDescription,
  DialogPanel,
} from "../ui/dialog";

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

function MachineRemoteProjects({
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
  const projects = settingsScopeNoticeCheckouts(
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
  return (
    <section aria-label={`Projects on ${name}`} className="space-y-2">
      <h3 className="text-sm font-medium">Projects on {name}</h3>
      {projects.listed.length + projects.archived.length > 0 ? (
        <ul className="space-y-2">
          {[...projects.listed, ...projects.archived].map((project) => (
            <li key={project.key}>
              <Link to="/settings/projects" search={project.search} onClick={onNavigate}>
                {project.label}
              </Link>
              <p className="text-xs text-muted-foreground">{project.detail}</p>
            </li>
          ))}
        </ul>
      ) : (
        <p className="text-sm text-muted-foreground">No projects on {name} yet.</p>
      )}
      <Button
        size="sm"
        variant="outline"
        disabled={!canOperate}
        onClick={() => {
          onNavigate();
          openCommandPalette({ open: "add-project", environmentId });
        }}
      >
        Add a project on {name}
      </Button>
    </section>
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
  const canRead = useEnvironmentScope(environmentId, AuthOrchestrationReadScope);
  const canOperate = useEnvironmentScope(environmentId, AuthOrchestrationOperateScope);
  const availability = remoteControlAvailability(
    environment?.connection?.phase === "connected",
    canRead,
    canOperate,
  );
  const threads = useThreadShells().filter(
    (thread) => thread.environmentId === environmentId && thread.deletedAt === null,
  );
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
            <DialogDescription>
              Agents, files and terminals stay on {name}. Viewing does not move a thread or its
              coordinator. {availability.detail}
            </DialogDescription>
          </DialogHeader>
          <DialogPanel>
            {availability.disabled ? (
              <p role="status">{availability.detail}</p>
            ) : (
              <div className="space-y-4">
                <div className="flex flex-wrap gap-3 text-sm">
                  <Link
                    to="/settings/providers"
                    search={{ machine: environmentId }}
                    onClick={() => setOpen(false)}
                  >
                    Agents on {name}
                  </Link>
                </div>
                <MachineRemoteProjects
                  environmentId={environmentId}
                  name={name}
                  canOperate={canOperate}
                  onNavigate={() => setOpen(false)}
                />
                <p className="text-sm text-muted-foreground">
                  Open a thread to inspect its work and use the controls permitted by this machine.
                  Adding a project opens setup on this machine. It does not start an agent.
                </p>
                {threads.length ? (
                  <ul className="space-y-2">
                    {threads.map((thread) => (
                      <li key={thread.id}>
                        <Link
                          to="/$environmentId/$threadId"
                          params={{ environmentId, threadId: thread.id }}
                          onClick={() => setOpen(false)}
                        >
                          {thread.title || "Untitled thread"}
                        </Link>
                      </li>
                    ))}
                  </ul>
                ) : (
                  <p>No threads on {name} yet.</p>
                )}
              </div>
            )}
          </DialogPanel>
        </DialogPopup>
      </Dialog>
    </>
  );
}
