import { createFileRoute } from "@tanstack/react-router";
import { ProjectSkillsSettings } from "../components/settings/ProjectSkillsSettings";

export const Route = createFileRoute("/settings/skills")({
  // `?skill=` opens that skill's details, as the composer's Manage link does.
  validateSearch: (raw: Record<string, unknown>): { skill?: string } =>
    typeof raw.skill === "string" && raw.skill.trim() !== "" ? { skill: raw.skill } : {},
  component: ProjectSkillsSettings,
});
