import { createFileRoute } from "@tanstack/react-router";
import { PrivacySettingsPanel } from "../components/settings/PrivacySettings";

export const Route = createFileRoute("/settings/privacy")({ component: PrivacySettingsPanel });
