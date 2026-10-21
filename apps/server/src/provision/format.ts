import type { ProvisionItem, ProvisionReadback } from "@specweave-studio/contracts";

const MARK: Record<ProvisionItem["status"], string> = {
  pending: "  ..",
  running: "  ..",
  ok: "PASS",
  "kept-newer": "PASS",
  changed: "DONE",
  planned: "PLAN",
  "needs-root": "ROOT",
  "user-action": "YOU ",
  failed: "FAIL",
  skipped: "SKIP",
};

export function formatItemLine(item: ProvisionItem): string {
  const found = item.found ?? "missing";
  const version =
    item.status === "ok" || item.status === "kept-newer" || item.status === "changed"
      ? found
      : `${found} -> ${item.wanted}`;
  return `${MARK[item.status]}  ${item.label.padEnd(36)} ${version}${item.detail ? `  ${item.detail}` : ""}`;
}

/** The text readback `specwithcode provision` prints; --json prints the object itself. */
export function formatReadback(readback: ProvisionReadback): string {
  const lines = [
    `SpecWithCode provision ${readback.manifestVersion}${readback.dryRun ? " (dry run)" : ""}`,
    `  Machine: ${readback.target.prettyName} ${readback.target.arch}, ${readback.target.libc}, ${readback.target.init}`,
  ];
  if (!readback.target.supported) {
    lines.push(
      `  Not supported: ${readback.target.reason}`,
      `  Nearest supported: ${readback.target.nearest}`,
    );
    return lines.join("\n");
  }
  lines.push(
    `  Home:    ${readback.service.home ?? "unknown"}`,
    `  Server:  wanted ${readback.server.wanted}, found ${readback.server.found ?? "none"}; service ${readback.service.managerError !== undefined ? "unknown (user manager unreachable)" : readback.service.installed ? (readback.service.active ? "running" : "stopped") : "not installed"}${readback.service.unit ? ` (${readback.service.unit})` : ""}`,
    "",
  );
  for (const item of readback.items) lines.push(formatItemLine(item));
  lines.push("", "Providers:");
  for (const provider of readback.providers)
    lines.push(
      `  ${provider.id.padEnd(7)} ${provider.found ? `${provider.version ?? "unknown version"} at ${provider.path}` : "not installed"}${provider.signedIn === null ? "" : provider.signedIn ? ", signed in" : ", not signed in"}`,
    );
  if (readback.rootStep && !readback.rootStep.ran)
    lines.push(
      "",
      readback.dryRun
        ? `Root steps (${readback.rootStep.items.join(", ")}) run with sudo; if sudo needs a password, provisioning asks for it at this terminal or prints the one command to run:`
        : `Root steps (${readback.rootStep.items.join(", ")}) need your password. Read ${readback.rootStep.script}, then run:`,
      `  ${readback.rootStep.command}`,
    );
  const steps = readback.userSteps.filter((step) => step.id !== "root");
  if (steps.length > 0) {
    lines.push("", "Your steps (provisioning never signs in, grants workers or turns on billing):");
    steps.forEach((step, index) => {
      lines.push(`  ${index + 1}. ${step.optional ? "(optional) " : ""}${step.title}`);
      if (step.command) lines.push(`     ${step.command}`);
    });
  }
  lines.push("", readback.summary);
  if (readback.logPath) lines.push(`Log: ${readback.logPath}`);
  return lines.join("\n");
}
