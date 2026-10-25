/**
 * What a project's design rows do, shared by the Designs tab and the Library:
 * open the editor, copy to the Playground, and find the design's own file.
 */
import type { DesignSummary, EnvironmentId, ProjectId } from "@specweave-studio/contracts";
import { squashAtomCommandFailure } from "@specweave-studio/client-runtime/state/runtime";
import { useRouter } from "@tanstack/react-router";

import { useAtomCommand } from "../../../state/use-atom-command";
import { design } from "../../../studio/design";
import { libraryBaseName } from "../../../studio/projectPaneModel";
import { designRoute } from "../../design/gallery/designLinks";
import { toastManager } from "../../ui/toast";
import type { LibraryViewerFile } from "./LibraryFileViewer";

export function designFile(summary: DesignSummary): LibraryViewerFile {
  const path = summary.ref.path.endsWith(".json")
    ? summary.ref.path
    : `${summary.ref.path.replace(/\/+$/, "")}/design.json`;
  return { path, name: libraryBaseName(path), modifiedAt: summary.updatedAt };
}

export function useProjectDesignActions(environmentId: EnvironmentId, projectId: ProjectId) {
  const router = useRouter();
  const copyDesign = useAtomCommand(design.copy, { reportFailure: false });
  const openDesign = (summary: DesignSummary) =>
    void router.navigate(designRoute({ kind: "project", projectId }, summary.ref.designId));
  const copyToPlayground = async (summary: DesignSummary) => {
    const result = await copyDesign({
      environmentId,
      input: {
        owner: { kind: "project", projectId },
        designId: summary.ref.designId,
        to: { kind: "playground" },
      },
    });
    if (result._tag === "Failure") {
      const error = squashAtomCommandFailure(result);
      toastManager.add({
        type: "error",
        title: "Could not copy the design",
        description: error instanceof Error ? error.message : "Nothing was copied.",
      });
      return;
    }
    const copy = result.value;
    toastManager.add({
      type: "success",
      title: "Copied to your Playground",
      actionProps: {
        children: "Open copy",
        onClick: () => void router.navigate(designRoute({ kind: "playground" }, copy.ref.designId)),
      },
    });
  };
  return { openDesign, copyToPlayground };
}
