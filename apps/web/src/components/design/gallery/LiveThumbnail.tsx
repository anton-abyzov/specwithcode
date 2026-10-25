import type { DesignSummary, EnvironmentId } from "@specweave-studio/contracts";
import { useEffect } from "react";

import { useEnvironmentQuery } from "~/state/query";
import { design } from "~/studio/design";

import { DesignThumbnail } from "./DesignThumbnail";
import { ownerInputOf } from "./galleryModel";

/** The card picture: the design's head revision, fetched once the card is near the viewport. */
export function LiveThumbnail({
  environmentId,
  summary,
}: {
  environmentId: EnvironmentId;
  summary: DesignSummary;
}) {
  const owner = ownerInputOf(summary);
  const document = useEnvironmentQuery(
    design.get({ environmentId, input: { owner, designId: summary.ref.designId } }),
  );
  const systemId = document.data?.document.designSystem ?? null;
  const system = useEnvironmentQuery(
    systemId === null ? null : design.systemGet({ environmentId, input: { owner, systemId } }),
  );
  const current = document.data?.document ?? null;
  // A newer revision in the list than the one on screen means the picture is stale.
  const { refresh } = document;
  useEffect(() => {
    if (current !== null && current.revision < summary.revision) refresh();
  }, [current, refresh, summary.revision]);
  return (
    <DesignThumbnail
      className="h-full w-full"
      document={current}
      system={system.data?.system ?? null}
    />
  );
}
