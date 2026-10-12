import { createFileRoute } from "@tanstack/react-router";
import { GoogleAccountSettingsPanel } from "../components/settings/GoogleAccountSettings";

export const Route = createFileRoute("/settings/google")({ component: GoogleAccountSettingsPanel });
