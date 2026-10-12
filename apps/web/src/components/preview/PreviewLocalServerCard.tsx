import type { ScopedThreadRef } from "@specweave-studio/contracts";
import { DiscoveryListRow } from "../ui/discovery-list";
import { Tooltip, TooltipPopup, TooltipTrigger } from "../ui/tooltip";

import { describeLocalServer } from "./localServerLabel";
import { PreviewFaviconIcon } from "./PreviewFaviconIcon";
import type { PreviewableServer } from "./useDiscoveredLocalServers";

interface Props {
  threadRef: ScopedThreadRef;
  server: PreviewableServer;
  onOpen: () => void;
}

export function PreviewLocalServerCard({ threadRef, server, onOpen }: Props) {
  const label = describeLocalServer(server);
  return (
    // Page titles can be long; the tooltip shows both lines when the row cuts them off.
    <Tooltip>
      <TooltipTrigger
        render={
          <DiscoveryListRow
            onClick={onOpen}
            icon={<PreviewFaviconIcon threadRef={threadRef} url={server.requestedUrl} />}
            title={label.title}
            description={label.description}
          />
        }
      />
      <TooltipPopup className="max-w-96 break-words">{label.hoverText}</TooltipPopup>
    </Tooltip>
  );
}
