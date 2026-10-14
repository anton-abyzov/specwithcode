import { ConnectionsLibrarySettings } from "../components/settings/ConnectionsLibrarySettings";
import { createFileRoute } from "@tanstack/react-router";

import { ConnectionsSettings } from "../components/settings/ConnectionsSettings";

export const Route = createFileRoute("/settings/connections")({
  component: () => (
    <>
      <ConnectionsLibrarySettings />
      <ConnectionsSettings />
    </>
  ),
});
