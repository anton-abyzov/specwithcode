/**
 * The whiteboard entry in the Artifacts shelf's New menu (ArtifactNewMenu): an
 * empty `.excalidraw` file in the project's `.specweave/artifacts/` folder,
 * which the shelf opens in the editor straight away.
 */
import type { EnvironmentId } from "@specweave-studio/contracts";
import { ShapesIcon } from "lucide-react";

import type { ArtifactNewEntry, CreatedArtifact } from "../../studio/shell/ArtifactNewMenu";
import { useCreateWhiteboard } from "./newWhiteboard";

/** The "Whiteboard" entry, or null where this person cannot write files here. */
export function useNewWhiteboardEntry(props: {
  readonly environmentId: EnvironmentId;
  readonly workspaceRoot: string;
}): ArtifactNewEntry | null {
  const whiteboards = useCreateWhiteboard(props.environmentId, props.workspaceRoot);
  if (!whiteboards.canCreate) return null;
  const create = async (): Promise<CreatedArtifact | null> => {
    const path = await whiteboards.create();
    return path === null ? null : { path, title: path.split("/").pop() ?? path };
  };
  return { id: "whiteboard", label: "Whiteboard", icon: <ShapesIcon aria-hidden />, create };
}
