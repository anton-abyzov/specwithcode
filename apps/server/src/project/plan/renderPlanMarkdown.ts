import type { ProjectNativePlan } from "../../../../../packages/contracts/src/projectPlan.ts";

const line = (value: string) => value.replace(/[\r\n]/g, " ");
const code = (value: string) => {
  const longest = Math.max(2, ...[...value.matchAll(/`+/g)].map((match) => match[0].length));
  const fence = "`".repeat(longest + 1);
  return `${fence}\n${value}\n${fence}`;
};

/** Portable export only. This never creates another authoritative ledger. */
export function renderPlanMarkdown(plan: ProjectNativePlan): string {
  const output = ["# Project plan", "", plan.spec, "", "## Acceptance criteria", ""];
  for (const criterion of plan.criteria) output.push(`- ${criterion.id}: ${line(criterion.text)}`);
  output.push("", "## Tasks", "");
  for (const task of plan.tasks) {
    output.push(
      `### ${task.id} ${line(task.title)}`,
      "",
      `Status: ${task.status}`,
      `Owner: ${task.owner?.kind === "thread" ? task.owner.threadId : (task.owner?.kind ?? "unassigned")}`,
      `Acceptance: ${task.criterionIds.join(", ") || "none"}`,
      "",
      task.note,
      "",
    );
    if (task.verification)
      output.push("Saved verification command:", code(JSON.stringify(task.verification)), "");
    for (const evidence of task.evidence)
      output.push(
        `Verification ${evidence.commandId}: ${evidence.outcome}; plan revision ${evidence.contentRevision}; exit ${evidence.exitCode ?? "unknown"}`,
        `Started: ${evidence.startedAt}; finished: ${evidence.finishedAt ?? "unknown"}`,
        `Output SHA-256: ${evidence.outputSha256 || "unavailable"}${evidence.truncated ? " (captured output truncated)" : ""}`,
        code(`stdout:\n${evidence.stdout}\nstderr:\n${evidence.stderr}`),
        "",
      );
  }
  return output.join("\n") + "\n";
}
