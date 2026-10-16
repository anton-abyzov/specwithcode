import { createFileRoute } from "@tanstack/react-router";

import { ChromeSettings } from "../components/settings/ChromeSettings";

export const Route = createFileRoute("/settings/chrome")({
  component: ChromeSettings,
});
