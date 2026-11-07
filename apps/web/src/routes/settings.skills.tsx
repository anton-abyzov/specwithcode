import { createFileRoute } from "@tanstack/react-router";
import { ProjectSkillsSettings } from "../components/settings/ProjectSkillsSettings";

export const Route = createFileRoute("/settings/skills")({
  validateSearch: (
    raw: Record<string, unknown>,
  ): {
    skill?: string;
    skillView?: string;
    agent?: string;
    skillCwd?: string;
    skillThread?: string;
    skillContext?: string;
  } =>
    Object.fromEntries(
      ["skill", "skillView", "agent", "skillCwd", "skillThread", "skillContext"].flatMap((key) =>
        typeof raw[key] === "string" && raw[key].trim() !== "" ? [[key, raw[key]]] : [],
      ),
    ),
  component: ProjectSkillsSettings,
});
