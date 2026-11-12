import { createFileRoute } from "@tanstack/react-router";

import { ConnectAdminSettings } from "../components/settings/ConnectAdminSettings";

export const Route = createFileRoute("/settings/connect-admin")({
  component: ConnectAdminSettings,
});
