import { createFileRoute } from "@tanstack/react-router";
import { MessagingSettingsPanel } from "../components/settings/MessagingSettings";

export const Route = createFileRoute("/settings/messaging")({ component: MessagingSettingsPanel });
