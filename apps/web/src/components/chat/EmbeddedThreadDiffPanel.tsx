import { scopedThreadKey } from "@specweave-studio/client-runtime/environment";
import type { ScopedThreadRef } from "@specweave-studio/contracts";
import { lazy, Suspense } from "react";
import type { DraftId } from "../../composerDraftStore";

const DiffPanel = lazy(() => import("../DiffPanel"));

export function EmbeddedThreadDiffPanel({
  threadRef,
  composerDraftTarget,
  workspaceMutationId,
}: {
  threadRef: ScopedThreadRef;
  composerDraftTarget: ScopedThreadRef | DraftId;
  workspaceMutationId: string | null;
}) {
  return (
    <Suspense fallback={null}>
      <DiffPanel
        key={scopedThreadKey(threadRef)}
        mode="embedded"
        threadRef={threadRef}
        composerDraftTarget={composerDraftTarget}
        workspaceMutationId={workspaceMutationId}
      />
    </Suspense>
  );
}
