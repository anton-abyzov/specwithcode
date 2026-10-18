import { squashAtomCommandFailure } from "@specweave-studio/client-runtime/state/runtime";
import { ProjectId, type EnvironmentId } from "@specweave-studio/contracts";
import { FolderPlusIcon } from "lucide-react";
import { useState } from "react";

import { randomUUID } from "~/lib/utils";
import { projectEnvironment } from "~/state/projects";
import { useAtomCommand } from "~/state/use-atom-command";
import { toastManager } from "../ui/toast";
import { ThreadDetailsControl } from "./ThreadDetailsControl";

/** A project name from the chat's title, or its folder's name when it has none yet. */
export function chatFolderProjectTitle(chatTitle: string | null | undefined, folder: string) {
  const title = chatTitle?.trim();
  if (title) return title;
  return folder.split(/[/\\]/).filter(Boolean).at(-1) ?? "Chat project";
}

/**
 * Registers a chat's own folder as a project, in place, so its files get the
 * project tools (Git, a coordinator, scripts). The chat itself stays where it
 * is; the new project opens from Projects.
 */
export function TurnChatIntoProject(props: {
  readonly environmentId: EnvironmentId;
  readonly folder: string;
  readonly chatTitle: string | null | undefined;
}) {
  const create = useAtomCommand(projectEnvironment.create, { reportFailure: false });
  const [state, setState] = useState<"idle" | "saving" | "done">("idle");
  async function turnIntoProject() {
    if (state !== "idle") return;
    setState("saving");
    const title = chatFolderProjectTitle(props.chatTitle, props.folder);
    try {
      const result = await create({
        environmentId: props.environmentId,
        input: {
          projectId: ProjectId.make(randomUUID()),
          title,
          workspaceRoot: props.folder,
          createWorkspaceRootIfMissing: false,
          defaultModelSelection: null,
        },
      });
      if (result._tag === "Failure") throw squashAtomCommandFailure(result);
      setState("done");
      toastManager.add({
        type: "success",
        title: `${title} is a project`,
        description:
          "Its files stay in this chat's folder. Open it from Projects; this chat stays in Chats.",
      });
    } catch (cause) {
      setState("idle");
      toastManager.add({
        type: "error",
        title: "Could not turn this chat into a project",
        description:
          cause instanceof Error ? cause.message : "The chat and its files are unchanged.",
      });
    }
  }
  return (
    <ThreadDetailsControl
      size="xs"
      variant="ghost"
      part="row"
      panel
      disabled={state !== "idle"}
      title={`Register ${props.folder} as a project`}
      onClick={() => void turnIntoProject()}
    >
      <FolderPlusIcon className="size-3.5" aria-hidden />
      <span className="ml-0.5">
        {state === "saving"
          ? "Turning into project..."
          : state === "done"
            ? "Now a project"
            : "Turn into project"}
      </span>
    </ThreadDetailsControl>
  );
}
