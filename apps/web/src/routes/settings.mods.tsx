import { createFileRoute } from "@tanstack/react-router";
import { ModsSettingsPanel } from "../components/settings/ModsSettings";

export const Route = createFileRoute("/settings/mods")({ component: ModsSettingsPanel });
