import { createFileRoute } from "@tanstack/react-router";
import { ProjectSkillsSettings } from "../components/settings/ProjectSkillsSettings";

export const Route = createFileRoute("/settings/skills")({
  component: ProjectSkillsSettings,
});
