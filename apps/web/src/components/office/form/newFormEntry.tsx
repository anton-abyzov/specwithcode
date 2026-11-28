/**
 * The form entry in the Artifacts shelf's New menu (ArtifactNewMenu): a new
 * `.form.json` file and its responses Sheet in the project's
 * `.specweave/artifacts/` folder, opened in the form editor straight away.
 */
import type { EnvironmentId } from "@specweave-studio/contracts";
import { ClipboardListIcon } from "lucide-react";

import type { ArtifactNewEntry, CreatedArtifact } from "../../studio/shell/ArtifactNewMenu";
import { useCreateForm } from "./newForm";

/** The "Form" entry, or null where this person cannot write files here. */
export function useNewFormEntry(props: {
  readonly environmentId: EnvironmentId;
  readonly workspaceRoot: string;
}): ArtifactNewEntry | null {
  const forms = useCreateForm(props.environmentId, props.workspaceRoot);
  if (!forms.canCreate) return null;
  const create = async (): Promise<CreatedArtifact | null> => {
    const path = await forms.create();
    return path === null ? null : { path, title: path.split("/").pop() ?? path };
  };
  return { id: "form", label: "Form", icon: <ClipboardListIcon aria-hidden />, create };
}
