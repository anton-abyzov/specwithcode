/**
 * What New project says after create and publish, from the server's typed
 * reasons, naming the machine when it is not this device. An older server
 * sends no reason; its own message is then said as it is.
 */
import type {
  ProjectCreateFailure,
  SourceControlPublishFailureReason,
} from "@specweave-studio/contracts";

/** The machine a project lives on: null when it is this device. */
export type ProjectMachineName = string | null;

const onMachine = (machine: ProjectMachineName) => (machine ? `on ${machine}` : "on this device");

function fieldOf(value: unknown, key: string): unknown {
  return typeof value === "object" && value !== null && key in value
    ? (value as Record<string, unknown>)[key]
    : undefined;
}

function messageOf(error: unknown): string {
  const message = fieldOf(error, "message");
  return typeof message === "string" && message.trim().length > 0 ? message : "An error occurred.";
}

/** The server's words, with "this machine" turned into the machine's name. */
function namedInMessage(message: string, machine: ProjectMachineName): string {
  return machine ? message.replaceAll("on this machine", `on ${machine}`) : message;
}

function createFailureOf(error: unknown): ProjectCreateFailure | null {
  const failure = fieldOf(error, "projectCreateFailure");
  return typeof failure === "object" && failure !== null && "reason" in failure
    ? (failure as ProjectCreateFailure)
    : null;
}

/** Why a project could not be created: the cause and the folder, on which machine. */
export function createFailureDescription(error: unknown, machine: ProjectMachineName): string {
  const failure = createFailureOf(error);
  if (failure === null) return namedInMessage(messageOf(error), machine);
  const folder = failure.folder ? `'${failure.folder}'` : "the chosen folder";
  const where = onMachine(machine);
  switch (failure.reason) {
    case "parent_missing":
      return `The folder ${folder} does not exist ${where}. Choose another folder.`;
    case "permission_denied":
      return `You do not have permission to create a folder in ${folder} ${where}. Choose another folder.`;
    case "git_missing":
      return `Git is not installed ${where}, so the project could not be made a repository. Install Git there, then try again.`;
    case "git_init_failed":
      return `git init failed in ${folder} ${where}${failure.detail ? `: ${failure.detail}` : "."}`;
    case "name_exhausted":
      return `Every folder name for "${failure.detail ?? "the project"}" in ${folder} ${where} is taken, up to 100. Choose another name or folder.`;
    case "refused":
      return `SpecWithCode does not make folders in ${folder}.`;
    default:
      return namedInMessage(messageOf(error), machine);
  }
}

/** Why a publish failed, with the fix. No generic "could not be completed" for a known reason. */
export function publishFailureDescription(
  error: unknown,
  machine: ProjectMachineName,
  repository: string,
): string {
  const reason = fieldOf(error, "publishFailure") as SourceControlPublishFailureReason | undefined;
  const detail = fieldOf(error, "detail");
  const where = onMachine(machine);
  switch (reason) {
    case "not_signed_in":
      return `GitHub is not signed in ${where}. Run gh auth login there, then publish again.`;
    case "name_taken":
      return `A repository named ${repository} already exists on GitHub. Rename the folder or publish under another name.`;
    case "no_permission":
      return `The GitHub account signed in ${where} may not create ${repository}.`;
    case "network":
      return `GitHub could not be reached ${where}. Check the network, then publish again.`;
    case "rate_limited":
      return "GitHub's rate limit was reached. Publish again once it resets.";
    case "push_failed":
      return typeof detail === "string" && detail.length > 0
        ? detail
        : "The repository was created, but pushing to it failed.";
    default:
      return messageOf(error);
  }
}

/** Why a new repository holds nothing yet: there was no first commit to push. */
export function nothingPushedDescription(input: {
  readonly repository: string;
  readonly commitError?: string | undefined;
}): string {
  const why = input.commitError
    ? `The project has no first commit: ${input.commitError.replace(/[.\s]*$/, ".")}`
    : "The project has no first commit yet.";
  return `${input.repository} is empty. ${why} Commit, then push from the Git menu.`;
}

/** Where the project is, naming the machine when it is not this device. */
export function projectWhere(workspaceRoot: string, machine: ProjectMachineName): string {
  return machine ? `${workspaceRoot} on ${machine}` : workspaceRoot;
}

/** The app made the project but could not open it: say it exists, where, and how to open it. */
export function notOpenedDescription(input: {
  readonly title: string;
  readonly workspaceRoot: string;
  readonly machine: ProjectMachineName;
}): string {
  return `${input.title} was created in ${projectWhere(input.workspaceRoot, input.machine)}. Open it from the sidebar, or choose it in Add project.`;
}
