import { isMacPlatform } from "@specweave-studio/shared/keybindings";

import { isWindowsPlatform } from "../../lib/utils";
import { SPECWITHCODE_REPO_URL } from "./StarOnGitHub";

export type FeedbackKind = "bug" | "idea" | "question";

export const FEEDBACK_DISCUSSIONS_URL = `${SPECWITHCODE_REPO_URL}/discussions`;

const TEMPLATES: Record<FeedbackKind, string> = {
  bug: "bug_report.yml",
  idea: "feature_request.yml",
  question: "question.yml",
};

export interface FeedbackContext {
  readonly version: string;
  readonly platform: string;
  readonly desktop: boolean;
  readonly machineCount: number;
}

export function feedbackOsLabel(platform: string): string {
  if (/iphone|ipad|ios/i.test(platform)) return "iOS";
  if (isMacPlatform(platform) || /darwin/i.test(platform)) return "macOS";
  if (isWindowsPlatform(platform)) return "Windows";
  if (/android/i.test(platform)) return "Android";
  if (/linux/i.test(platform)) return "Linux";
  return "Other";
}

/**
 * A prefilled GitHub issue form. Only the version, OS family, app kind and
 * machine count go in: no names, paths or hostnames.
 */
export function feedbackIssueUrl(kind: FeedbackKind, context: FeedbackContext): string {
  const machines = `${context.machineCount} ${context.machineCount === 1 ? "machine" : "machines"}`;
  const environment = [
    feedbackOsLabel(context.platform),
    context.desktop ? "desktop app" : "web app",
    machines,
  ].join(", ");
  const params = new URLSearchParams({ template: TEMPLATES[kind] });
  if (kind === "idea") {
    // The feature form has one combined "version and platform" field.
    params.set("version", `${context.version}, ${environment}`);
  } else {
    params.set("version", context.version);
    params.set("environment", environment);
  }
  return `${SPECWITHCODE_REPO_URL}/issues/new?${params.toString()}`;
}
