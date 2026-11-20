import { createFileRoute } from "@tanstack/react-router";

import { PreviewRecordingTab } from "../components/settings/integrations/PreviewRecordingTab";

export const Route = createFileRoute("/settings/integrations/preview")({
  component: PreviewRecordingTab,
});
